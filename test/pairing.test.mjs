import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './fixture.mjs';
import { pairingNative as helper } from './support/pairing-native.mjs';

const paired = { event: 'paired', device: { udid: 'wireless-27', name: 'Wireless iPhone', model: 'iPhone17,1' }, peer: '192.0.2.27' };
const happyPath = [{ event: 'advertising', port: 53124 }, { event: 'connected', peer: '192.0.2.27' }, { event: 'pin', pin: '482916' }, { await: 'accept' }, paired];

async function pairingFixture(t, { pairHost = happyPath, remote = {} } = {}) {
  let ddiDir;
  const f = await fixture(t, {
    beforeStart: async dir => {
      await writeFile(join(dir, 'build/poki-native'), helper, { mode: 0o755 });
      await writeFile(join(dir, 'pairing.json'), JSON.stringify({ pairHost, remote }));
      ddiDir = join(dir, 'ddi-image');
      await mkdir(ddiDir);
      await writeFile(join(ddiDir, 'BuildManifest.plist'), 'manifest');
    },
    extraEnv: dir => ({ POKI_DDI_DIR: join(dir, 'ddi-image') }),
  });
  // The stand-in RemotePairing helpers run detached, as real ones do; stop them with the test.
  t.after(() => { try { execFileSync('pkill', ['-f', `${f.dir}/build/poki-native`]); } catch {} });
  const data = result => {
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  const call = async (name, args = {}, client = f.a) => client.callTool({ name, arguments: args });
  const until = async (job, predicate, client) => {
    const deadline = performance.now() + 15000;
    while (true) {
      const current = data(await call('pairing_status', { job }, client));
      if (predicate(current)) return current;
      if (performance.now() > deadline) throw new Error(`Job stayed ${current.state}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  return { f, data, call, until, ddiDir, release: name => writeFile(join(f.dir, name), '') };
}

const registry = async f => JSON.parse(await readFile(join(f.dir, 'state/remote-devices.json'), 'utf8').catch(() => '[]'));

test('a pairing job advances in order, shows its PIN, registers the iPhone and installs the DDI over the tunnel', { timeout: 60000 }, async t => {
  const { f, data, call, until, ddiDir, release } = await pairingFixture(t);
  const started = data(await call('pair_device', { name: 'Poki Lab' }));
  assert.equal(started.existing, false);
  assert.equal(started.job.host_name, 'Poki Lab');
  const job = started.job.job;
  const atPin = await until(job, j => j.state === 'pin');
  assert.equal(atPin.pin, '482916');
  assert.match(atPin.instruction, /482916/);
  const text = (await call('pairing_status', { job })).content[0].text;
  assert.match(text, /^PIN: 482916/, 'a host without MCP Apps still shows the PIN as text');

  // Another session sees the same job, and a second pair_device does not start a second helper.
  const other = await f.connect();
  const again = data(await call('pair_device', {}, other));
  assert.equal(again.existing, true);
  assert.equal(again.job.job, job);
  const listed = data(await call('list_devices', {}, other));
  assert.deepEqual(listed.pairing.jobs.map(j => j.job), [job]);
  assert.equal(listed.pairing.host.advertising, true);
  assert.equal(listed.pairing.host.name, 'Poki Lab');
  assert.equal((await f.events()).filter(e => e.helper === '--pair-host').length, 1);

  await release('accept');
  const ready = await until(job, j => j.terminal);
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.deepEqual(ready.device, { id: 'wireless-27', name: 'Wireless iPhone', host: '192.0.2.27', model: 'iPhone17,1' });
  assert.equal(ready.pin, undefined, 'the PIN is not kept once used');

  const events = await f.events();
  const ops = events.filter(e => e.remote).map(e => e.remote);
  assert.deepEqual(ops.slice(0, 2), ['ddi_status', 'install_ddi']);
  assert.equal(events.find(e => e.remote === 'install_ddi').request.restore_dir, ddiDir);
  assert.deepEqual((await registry(f)).map(d => d.id), ['wireless-27']);
  const config = JSON.parse(await readFile(join(f.dir, 'state/remote/wireless-27/config.json'), 'utf8'));
  assert.equal(config.host, '192.0.2.27');
  assert.equal((await stat(config.pairing_file)).mode & 0o777, 0o600);

  const after = data(await call('list_devices'));
  const device = after.devices.find(d => d.id === 'wireless-27');
  assert.equal(device.connection, 'RemotePairing');
  assert.equal(device.display_service, true);
  assert.equal(after.pairing.host.advertising, false);
  const history = after.pairing.jobs.find(j => j.job === job);
  assert.equal(history.state, 'ready');
});

test('the job keeps its states in order', { timeout: 60000 }, async t => {
  const { data, call, until, release } = await pairingFixture(t);
  const { job } = data(await call('pair_device')).job;
  const seen = [];
  await release('accept');
  await until(job, j => { if (seen.at(-1) !== j.state) seen.push(j.state); return j.terminal; });
  const order = ['starting', 'advertising', 'pin', 'paired', 'registering', 'mounting_ddi', 'ready'];
  // Polling may miss quick states, never reorder them.
  assert.deepEqual(seen.filter(s => order.includes(s)).map(s => order.indexOf(s)), [...seen.map(s => order.indexOf(s))].sort((a, b) => a - b));
  assert.equal(seen.at(-1), 'ready');
});

test('cancelling a pairing stops its helper and registers nothing', { timeout: 60000 }, async t => {
  const { f, data, call, until } = await pairingFixture(t);
  const { job } = data(await call('pair_device')).job;
  await until(job, j => j.state === 'pin');
  const helperPid = (await f.events()).find(e => e.helper === '--pair-host').pid;
  const cancelled = data(await call('pairing_cancel', { job }));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.terminal, true);
  assert.ok((await f.events()).some(e => e.helper === 'pair-host-sigterm' && e.pid === helperPid), 'the helper got SIGTERM');
  assert.throws(() => process.kill(helperPid, 0), { code: 'ESRCH' }, 'the helper has exited');
  assert.deepEqual(await registry(f), []);
  await assert.rejects(access(join(f.dir, 'state/remote/wireless-27')), { code: 'ENOENT' });
  const listed = data(await call('list_devices'));
  assert.equal(listed.pairing.host.advertising, false);
  assert.equal(listed.pairing.jobs.find(j => j.job === job).state, 'cancelled');
  // A new pairing can start once the old one ended.
  const next = data(await call('pair_device'));
  assert.notEqual(next.job.job, job);
  await call('pairing_cancel', { job: next.job.job });
});

test('a helper that fails reports why and what to do', { timeout: 60000 }, async t => {
  const { data, call, until } = await pairingFixture(t, { pairHost: [{ event: 'advertising', port: 1 }, { fail: 'The iPhone rejected the pairing request.' }] });
  const { job } = data(await call('pair_device')).job;
  const failed = await until(job, j => j.terminal);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.stage, 'pairing');
  assert.equal(failed.reason, 'pairing_failed');
  assert.match(failed.error, /rejected the pairing request/);
  assert.match(failed.action, /Developer Mode/);
  assert.match((await call('pairing_status', { job })).content[0].text, /^Pairing failed/);
});

test('a DDI the tunnel cannot install fails with the reason and the USB advice; the iPhone stays paired', { timeout: 60000 }, async t => {
  const { f, data, call, until, release } = await pairingFixture(t, { remote: { install: { installed: false, stage: 'install', error: 'cryptexd refused the installation' } } });
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  const failed = await until(job, j => j.terminal);
  assert.equal(failed.state, 'failed', JSON.stringify(failed));
  assert.equal(failed.stage, 'ddi');
  assert.equal(failed.reason, 'ddi_tunnel_install_failed');
  assert.equal(failed.paired, true);
  assert.match(failed.error, /cryptexd refused/);
  assert.match(failed.action, /USB cable once/);
  assert.match(failed.action, /prepare-device\.mjs wireless-27/);
  assert.deepEqual((await registry(f)).map(d => d.id), ['wireless-27'], 'pairing itself succeeded and is kept');
  const listed = data(await call('list_devices'));
  const device = listed.devices.find(d => d.id === 'wireless-27');
  assert.equal(device.display_service, false);
  assert.match(device.action, /pair_device with device "wireless-27"/);
});

test('a signing failure is not sent to USB: USB needs the same signature', { timeout: 60000 }, async t => {
  const { data, call, until, release } = await pairingFixture(t, { remote: { install: { installed: false, stage: 'signing', error: 'TSS server responded with non-success status 94' } } });
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  const failed = await until(job, j => j.terminal);
  assert.equal(failed.reason, 'ddi_signing_failed');
  assert.match(failed.action, /gs\.apple\.com/);
  assert.match(failed.action, /USB cable does not help/);
});

test('pair_device with a paired device only installs its DDI again', { timeout: 60000 }, async t => {
  const { f, data, call, until, release } = await pairingFixture(t);
  const first = data(await call('pair_device')).job.job;
  await release('accept');
  await until(first, j => j.terminal);
  const helpers = (await f.events()).filter(e => e.helper === '--pair-host').length;
  const again = data(await call('pair_device', { device: 'wireless-27' }));
  assert.equal(again.job.kind, 'prepare');
  const done = await until(again.job.job, j => j.terminal);
  assert.equal(done.state, 'ready');
  assert.equal(done.ddi.already_mounted, true, 'the stub reports the DDI from the first job');
  assert.equal((await f.events()).filter(e => e.helper === '--pair-host').length, helpers, 'no second pairing helper');
  const unknown = await call('pair_device', { device: 'nobody' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /No wirelessly paired device/);
});

test('unpair_device removes the pairing, disconnects its helper, ends other sessions\' leases, and needs no restart', { timeout: 60000 }, async t => {
  const { f, data, call, until, release } = await pairingFixture(t);
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  await until(job, j => j.terminal);
  const other = await f.connect();
  const lease = JSON.parse((await call('acquire_device', { device: 'wireless-27', ttl_seconds: 120 }, other)).content[0].text);
  assert.ok(lease.lease_id, JSON.stringify(lease));

  const result = data(await call('unpair_device', { device: 'wireless-27' }));
  assert.equal(result.unpaired, true);
  assert.deepEqual(result.helper, { running: true, disconnected: true });
  assert.match(result.phone_cleanup, /iPhone/);
  assert.ok((await f.events()).some(e => e.remote === 'disconnect'), 'the helper was told to disconnect');
  assert.deepEqual(await registry(f), []);
  await assert.rejects(access(join(f.dir, 'state/remote/wireless-27')), { code: 'ENOENT' });

  const listed = data(await call('list_devices'));
  assert.ok(!listed.devices.some(d => d.id === 'wireless-27'), 'gone from list_devices without a restart');
  const renewed = await call('renew_device', { lease_id: lease.lease_id }, other);
  assert.equal(renewed.isError, true, 'the other session\'s lease ended');
  const reused = await call('take_screenshot', { device: 'wireless-27' }, other);
  assert.equal(reused.isError, true);
  assert.match(reused.content[0].text, /No connected device/);
  const usb = await call('unpair_device', { device: 'fixture-phone' });
  assert.equal(usb.isError, true);
  assert.match(usb.content[0].text, /not paired over Wi-Fi by Poki/);
});

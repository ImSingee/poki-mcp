import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './fixture.mjs';
import { pairingNative as helper } from './support/pairing-native.mjs';

const paired = { event: 'paired', device: { udid: 'wireless-27', name: 'Wireless iPhone', model: 'iPhone17,1' }, peer: '192.0.2.27' };
const happyPath = [{ event: 'advertising', port: 53124 }, { event: 'connected', peer: '192.0.2.27' }, { event: 'pin', pin: '482916' }, { await: 'accept' }, paired];

// approvalMode: 'allow' unless a test is about approval (unpair_device asks in 'ask' mode).
// registered: ids of phones paired before the service starts. env: more environment for it.
async function pairingFixture(t, { pairHost = happyPath, remote = {}, approvalMode = 'allow', registered = [], env = {}, daemon = true } = {}) {
  let ddiDir;
  const f = await fixture(t, {
    approvalMode, daemon,
    beforeStart: async dir => {
      await writeFile(join(dir, 'build/poki-native'), helper, { mode: 0o755 });
      await writeFile(join(dir, 'pairing.json'), JSON.stringify({ pairHost, remote }));
      ddiDir = join(dir, 'ddi-image');
      await mkdir(ddiDir);
      await writeFile(join(ddiDir, 'BuildManifest.plist'), 'manifest');
      const entries = [];
      for (const id of registered) {
        const directory = join(dir, 'state/remote', id);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'config.json'), JSON.stringify({ id, host: '192.0.2.50', port: 49152, pairing_file: join(directory, 'pairing.plist') }));
        entries.push({ id, name: id, config_path: join(directory, 'config.json') });
      }
      if (entries.length) await writeFile(join(dir, 'state/remote-devices.json'), JSON.stringify(entries));
    },
    extraEnv: dir => ({ POKI_DDI_DIR: join(dir, 'ddi-image'), ...env }),
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

// A stopped process can stay a zombie until its parent reaps it: wait for that, briefly.
async function waitGone(pid, message, ms = 3000) {
  const deadline = performance.now() + ms;
  while (true) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    if (performance.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
  assert.equal(ready.ddi.version, '27B52', 'the installed image\'s version');

  const events = await f.events();
  const ops = events.filter(e => e.remote).map(e => e.remote);
  // A fresh handshake first, in case an image was mounted another way; then the installation.
  assert.deepEqual(ops.slice(0, 4), ['ddi_status', 'reconnect', 'ddi_status', 'install_ddi']);
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

test('unpair_device stops a helper that is busy installing the DDI and does not answer', { timeout: 60000 }, async t => {
  const { f, data, call, until, release } = await pairingFixture(t, { remote: { hangInstall: true } });
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  await until(job, j => j.state === 'mounting_ddi');
  await f.until(log => log.includes('"remote":"install_ddi"'));
  const helperPid = (await f.events()).find(e => e.helper === '--remote-server').pid;
  const result = data(await call('unpair_device', { device: 'wireless-27' }));
  assert.equal(result.helper.disconnected, false);
  assert.equal(result.helper.stopped, true, JSON.stringify(result.helper));
  assert.equal(result.helper.pid, helperPid);
  // Stopped; its parent (the service) reaps it a moment later.
  await waitGone(helperPid, 'the busy helper was stopped, not left holding the tunnel');
  assert.deepEqual(await registry(f), []);
  const ended = data(await call('pairing_status', { job }));
  assert.equal(ended.state, 'cancelled');
});

test('pair_device with a device another session holds a lease on is refused', { timeout: 60000 }, async t => {
  const { f, data, call, until, release } = await pairingFixture(t);
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  await until(job, j => j.terminal);
  const other = await f.connect();
  const lease = JSON.parse((await call('acquire_device', { device: 'wireless-27', ttl_seconds: 120 }, other)).content[0].text);
  assert.ok(lease.lease_id, JSON.stringify(lease));
  const installs = (await f.events()).filter(e => e.remote === 'install_ddi' || e.remote === 'ddi_status').length;
  const refused = await call('pair_device', { device: 'wireless-27' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /occupied/);
  assert.equal((await f.events()).filter(e => e.remote === 'install_ddi' || e.remote === 'ddi_status').length, installs, 'nothing reached the phone');
});

test('while a device is being unpaired, no session can lease or act on it', { timeout: 60000 }, async t => {
  // A helper busy with an installation makes the unpair wait for it, so the window stays open.
  const { f, data, call, until, release } = await pairingFixture(t, { remote: { hangInstall: true } });
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  await until(job, j => j.state === 'mounting_ddi');
  await f.until(log => log.includes('"remote":"install_ddi"'));
  const other = await f.connect();
  const unpairing = call('unpair_device', { device: 'wireless-27' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const lease = await call('acquire_device', { device: 'wireless-27', ttl_seconds: 120 }, other);
  assert.equal(lease.isError, true, JSON.stringify(lease));
  assert.match(lease.content[0].text, /being unpaired/);
  const read = await call('take_screenshot', { device: 'wireless-27' }, other);
  assert.equal(read.isError, true);
  assert.equal(data(await unpairing).unpaired, true);
  const after = await call('acquire_device', { device: 'wireless-27', ttl_seconds: 120 }, other);
  assert.equal(after.isError, true);
  assert.match(after.content[0].text, /No connected device/);
});

// Review follow-ups (each fails on b9ba402f).

test('list_devices reports displayservice for a wireless iPhone without a ddi field that could not be filled', { timeout: 60000 }, async t => {
  const { data, call, until, release } = await pairingFixture(t);
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  await until(job, j => j.terminal);
  const device = data(await call('list_devices')).devices.find(d => d.id === 'wireless-27');
  assert.equal(device.display_service, true);
  assert.equal('ddi' in device, false);
});

test('pair_device for a paired iPhone runs beside a new pairing, and each call gets its own job', { timeout: 60000 }, async t => {
  const { data, call, until } = await pairingFixture(t, { registered: ['other-phone'], remote: { installDelayMs: 3000 } });
  const pairing = data(await call('pair_device')).job;
  await until(pairing.job, j => j.state === 'pin');
  const prepare = data(await call('pair_device', { device: 'other-phone' }));
  assert.equal(prepare.existing, false, 'not the pairing of another phone');
  assert.equal(prepare.job.kind, 'prepare');
  assert.notEqual(prepare.job.job, pairing.job);
  assert.equal(data(await call('pair_device', { device: 'other-phone' })).job.job, prepare.job.job, 'the same phone gets the job already preparing it');
  assert.equal(data(await call('pair_device')).job.job, pairing.job, 'a new pairing gets the pairing already running');
  assert.equal((await until(prepare.job.job, j => j.terminal)).state, 'ready');
  assert.equal(data(await call('pairing_status', { job: pairing.job })).state, 'pin', 'preparing one phone did not end the pairing of another');
  await call('pairing_cancel', { job: pairing.job });
});

test('an image mounted another way is found by reconnecting, not installed again', { timeout: 60000 }, async t => {
  const { f, data, call, until } = await pairingFixture(t, { registered: ['usb-mounted'], remote: { displayAfterReconnect: true } });
  const { job } = data(await call('pair_device', { device: 'usb-mounted' })).job;
  const done = await until(job, j => j.terminal);
  assert.equal(done.state, 'ready', JSON.stringify(done));
  assert.equal(done.ddi.already_mounted, true);
  const ops = (await f.events()).filter(e => e.remote).map(e => e.remote);
  assert.ok(ops.includes('reconnect'));
  assert.ok(!ops.includes('install_ddi'), JSON.stringify(ops));
});

test('calls to an iPhone whose DDI is being installed fail at once and say why', { timeout: 60000 }, async t => {
  const { f, data, call, until } = await pairingFixture(t, { registered: ['busy-phone'], remote: { hangInstall: true } });
  const { job } = data(await call('pair_device', { device: 'busy-phone' })).job;
  await until(job, j => j.state === 'mounting_ddi');
  await f.until(log => log.includes('"remote":"install_ddi"'));
  const started = performance.now();
  const read = await call('take_screenshot', { device: 'busy-phone' });
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /getting its developer disk image from pairing job/);
  assert.ok(performance.now() - started < 3000, 'it did not wait for the busy helper');
  const startedList = performance.now();
  // Bounded: a list_devices that asks the busy helper would otherwise only show as a test timeout.
  const listing = await Promise.race([call('list_devices'), new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
  assert.notEqual(listing, 'timeout', 'list_devices waited for the helper that is installing the image');
  const listed = data(listing).devices.find(d => d.id === 'busy-phone');
  assert.equal(listed.pairing_job, job);
  assert.match(listed.readiness, /being prepared by pairing job/);
  assert.ok(performance.now() - startedList < 3000, 'list_devices did not ask the busy helper');
});

test('cancelling while the iPhone registers removes the new pairing again and says so', { timeout: 30000 }, async t => {
  const { PairingJobs } = await import('../src/pairing/jobs.mjs');
  const { completeWirelessPairing } = await import('../src/pairing/wireless.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poki-cancel-registering-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'record');
console.log(JSON.stringify(${JSON.stringify(paired)}));
`, { mode: 0o755 });
  let registering, finishRegistration;
  const gate = new Promise(resolve => { finishRegistration = resolve; });
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), native, complete: async (...args) => { registering = true; await gate; return completeWirelessPairing(...args); }, ensureImage: async () => ({ already: true }) });
  const { job } = jobs.start();
  while (!registering) await new Promise(resolve => setTimeout(resolve, 10));
  const cancelling = jobs.cancel(job.job);
  finishRegistration();
  const cancelled = await cancelling;
  assert.equal(cancelled.state, 'cancelled');
  assert.match(cancelled.note, /removed from this computer again/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'state/remote-devices.json'), 'utf8')), []);
  await assert.rejects(access(join(dir, 'state/remote/wireless-27')), { code: 'ENOENT' });
});

test('pairing a registered iPhone again stops its old helper, so the next call uses the new configuration', { timeout: 60000 }, async t => {
  const { f, data, call, until, release } = await pairingFixture(t);
  const first = data(await call('pair_device')).job.job;
  await release('accept');
  await until(first, j => j.terminal);
  const helpers = () => f.events().then(events => events.filter(e => e.helper === '--remote-server').map(e => e.pid));
  const [old] = await helpers();
  const second = data(await call('pair_device')).job.job;
  await until(second, j => j.state === 'pin');
  await release('accept');
  const done = await until(second, j => j.terminal);
  assert.equal(done.state, 'ready', JSON.stringify(done));
  const events = await f.events();
  assert.ok(events.some(e => e.remote === 'disconnect'), 'the old helper was told to disconnect');
  await waitGone(old, 'the helper was stopped');
  assert.ok((await helpers()).length >= 2, 'a new helper serves the new pairing');
});

test('unpair_device stops a helper that was still starting, instead of leaving it for a deleted pairing', { timeout: 60000 }, async t => {
  const { f, data, call } = await pairingFixture(t, { registered: ['slow-phone'], remote: { startDelayMs: 1500 } });
  const listing = call('list_devices');
  await f.until(log => log.includes('"helper":"--remote-server"'));
  const result = data(await call('unpair_device', { device: 'slow-phone' }));
  assert.equal(result.helper.disconnected, true, JSON.stringify(result.helper));
  await listing;
  await new Promise(resolve => setTimeout(resolve, 500));
  const pid = (await f.events()).find(e => e.helper === '--remote-server').pid;
  await waitGone(pid, 'the helper was stopped');
});

test('unpair_device asks a person in ask mode, and refuses when they decline', { timeout: 60000 }, async t => {
  const { f, data, call } = await pairingFixture(t, { registered: ['asked-phone'], approvalMode: 'ask' });
  // The dialog stand-ins answer from fixture state: declined unless approveUnpair is set.
  for (const tool of ['osascript', 'zenity']) await writeFile(join(f.dir, 'bin', tool), `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ dialog: process.argv.slice(2).join(' ') }) + '\\n');
const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, 'utf8'));
if (${JSON.stringify(tool)} === 'zenity') process.exit(state.approveUnpair ? 0 : 1);
console.log(state.approveUnpair ? 'done' : 'cancelled');
`, { mode: 0o755 });
  const declined = await call('unpair_device', { device: 'asked-phone' });
  assert.equal(declined.isError, true);
  assert.ok((await f.events()).some(e => e.dialog?.includes('asked-phone')), 'a dialog named the phone');
  assert.deepEqual((await registry(f)).map(d => d.id), ['asked-phone'], 'nothing was removed');
  await f.set({ approveUnpair: true });
  const approved = data(await call('unpair_device', { device: 'asked-phone' }));
  assert.equal(approved.approval.approved_by, 'human');
  assert.deepEqual(await registry(f), []);
  const status = JSON.parse((await call('poki_mcp_status')).content[0].text);
  assert.ok(status.approval_covers.includes('unpair_device'));
});

test('pairing tools are refused inside batch_commands and run_code', { timeout: 60000 }, async t => {
  const { f, call } = await pairingFixture(t);
  const batch = await call('batch_commands', { device: 'fixture-phone', commands: [{ tool: 'pairing_status', arguments: { job: 'x' } }] });
  assert.equal(batch.isError, true);
  assert.match(JSON.stringify(batch), /pairing tools outside a batch/);
  const script = await call('run_code', { devices: ['fixture-phone'], code: "return await tools.pair_device({});" });
  assert.equal(script.isError, true);
  assert.match(JSON.stringify(script), /pairing tools outside a batch/);
  assert.equal((await f.events()).filter(e => e.helper === '--pair-host').length, 0, 'no pairing started');
});

test('stopping the service cancels its pairing jobs', { timeout: 60000 }, async t => {
  const { f, data, call, until } = await pairingFixture(t);
  const { job } = data(await call('pair_device')).job;
  await until(job, j => j.state === 'pin');
  await f.daemon.stop('SIGTERM');
  await f.until(log => log.includes('pair-host-sigterm'));
});

test('an automatic service started by a shim stays while a pairing runs and gets POKI_DDI_DIR', { timeout: 60000 }, async t => {
  const { f, data, call, until, release, ddiDir } = await pairingFixture(t, { daemon: false, env: { POKI_DAEMON_IDLE_EXIT_MS: '400' } });
  const { job } = data(await call('pair_device')).job;
  await until(job, j => j.state === 'pin');
  const ready = (await readFile(join(f.dir, 'state/daemon.log'), 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(e => e.event === 'ready');
  await f.a.close();
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.doesNotThrow(() => process.kill(ready.pid, 0), 'the service did not exit for idleness during the pairing');
  const client = await f.connect();
  await release('accept');
  assert.equal((await until(job, j => j.terminal, client)).state, 'ready');
  assert.equal((await f.events()).find(e => e.remote === 'install_ddi').request.restore_dir, ddiDir, 'POKI_DDI_DIR reached the automatic service');
});

test('unpairing a phone that is being paired again waits for its registration and leaves it removed', { timeout: 30000 }, async t => {
  const { PairingJobs } = await import('../src/pairing/jobs.mjs');
  const { completeWirelessPairing } = await import('../src/pairing/wireless.mjs');
  const { registerRemote, unregisterRemote } = await import('../src/pairing/registry.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poki-unpair-registering-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  // Registered before: this job pairs the same phone again.
  await registerRemote('wireless-27', 'Wireless iPhone', '192.0.2.27', 49152, join(dir, 'old.plist'), { stateDir });
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'record');
console.log(JSON.stringify(${JSON.stringify(paired)}));
`, { mode: 0o755 });
  let registering, finishRegistration;
  const gate = new Promise(resolve => { finishRegistration = resolve; });
  let prepared = false;
  const jobs = new PairingJobs({ stateDir, native, complete: async (...args) => { registering = true; await gate; return completeWirelessPairing(...args); }, ensureImage: async () => { prepared = true; return { already: true }; } });
  const { job } = jobs.start();
  while (!registering) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(jobs.preparing('wireless-27')?.id, job.job, 'the job is found by the phone the iPhone answered as');
  // What unpair_device does: stop the device's jobs, then delete the pairing.
  const unpairing = jobs.cancelForDevice('wireless-27').then(() => unregisterRemote('wireless-27', { stateDir }));
  setTimeout(finishRegistration, 100);
  await unpairing;
  await jobs.jobs.get(job.job).done;
  assert.equal(jobs.get(job.job).state, 'cancelled');
  assert.equal(prepared, false, 'no developer image preparation after the unpair');
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'remote-devices.json'), 'utf8')), [], 'the pairing was not registered again');
});

test('pairing a registered iPhone again leaves its helper alone while another session holds the device', { timeout: 30000 }, async t => {
  const { PairingJobs } = await import('../src/pairing/jobs.mjs');
  const { registerRemote } = await import('../src/pairing/registry.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poki-repair-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  await registerRemote('wireless-27', 'Wireless iPhone', '192.0.2.99', 49152, join(dir, 'old.plist'), { stateDir });
  const before = await readFile(join(stateDir, 'remote/wireless-27/config.json'), 'utf8');
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'record');
console.log(JSON.stringify(${JSON.stringify(paired)}));
`, { mode: 0o755 });
  for (const [label, coordinator] of [
    ['being unpaired', { leases: new Map(), unavailable: new Map([['wireless-27', 'Wireless iPhone (wireless-27) is being unpaired.']]), inputLock: { acquire: async () => () => {} } }],
    ['input lock taken', { leases: new Map(), inputLock: { acquire: async () => { throw new Error('Device wireless-27 is busy: tap by session other'); } } }],
    ['leased', { leases: new Map([['wireless-27', { expires_at: '2026-11-28T00:00:00Z' }]]), inputLock: { acquire: async () => { throw new Error('the lock must not be tried under a lease'); } } }],
  ]) {
    const disconnected = [];
    const jobs = new PairingJobs({ stateDir, native, disconnect: async target => { disconnected.push(target.id); return { running: true, disconnected: true }; }, ensureImage: async () => ({ already: true }) });
    jobs.coordinator = coordinator;
    const { job } = jobs.start();
    await jobs.jobs.get(job.job).done;
    const failed = jobs.get(job.job);
    assert.equal(failed.state, 'failed', label);
    assert.equal(failed.stage, 'registering', label);
    assert.equal(failed.reason, 'device_busy', label);
    assert.deepEqual(disconnected, [], `${label}: the old helper was not disconnected`);
    assert.equal(await readFile(join(stateDir, 'remote/wireless-27/config.json'), 'utf8'), before, `${label}: the registration was not replaced`);
  }
});

test('unpair_device returns only after the helper has finished shutting down', { timeout: 60000 }, async t => {
  // The helper answers the disconnect, then takes a while to release its session and remove its socket.
  const { f, data, call, until, release } = await pairingFixture(t, { remote: { exitDelayMs: 1500 } });
  const { job } = data(await call('pair_device')).job;
  await release('accept');
  await until(job, j => j.terminal);
  const helperPid = (await f.events()).find(e => e.helper === '--remote-server').pid;
  const result = data(await call('unpair_device', { device: 'wireless-27' }));
  assert.equal(result.helper.disconnected, true);
  // Only the reaping by its parent may still be pending, not the helper's own cleanup.
  await waitGone(helperPid, 'unpair_device returned while the helper was still shutting down', 300);
});

test('the session that leases a phone can reinstall its developer image', { timeout: 60000 }, async t => {
  const { data, call, until } = await pairingFixture(t, { registered: ['my-phone'] });
  const lease = JSON.parse((await call('acquire_device', { device: 'my-phone', ttl_seconds: 120 })).content[0].text);
  assert.ok(lease.lease_id, JSON.stringify(lease));
  const { job } = data(await call('pair_device', { device: 'my-phone' })).job;
  const done = await until(job, j => j.terminal);
  assert.equal(done.state, 'ready', JSON.stringify(done));
});

test('unpairing waits for a slow re-registration to settle, however long it takes', { timeout: 60000 }, async t => {
  const { PairingJobs } = await import('../src/pairing/jobs.mjs');
  const { completeWirelessPairing } = await import('../src/pairing/wireless.mjs');
  const { registerRemote, unregisterRemote } = await import('../src/pairing/registry.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poki-unpair-slow-registering-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  await registerRemote('wireless-27', 'Wireless iPhone', '192.0.2.27', 49152, join(dir, 'old.plist'), { stateDir });
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'record');
console.log(JSON.stringify(${JSON.stringify(paired)}));
`, { mode: 0o755 });
  let registering;
  // Longer than any fixed cap on the wait: an old helper slow to shut down, say.
  const jobs = new PairingJobs({ stateDir, native, complete: async (...args) => { registering = true; await new Promise(resolve => setTimeout(resolve, 11000)); return completeWirelessPairing(...args); }, ensureImage: async () => ({ already: true }) });
  const { job } = jobs.start();
  while (!registering) await new Promise(resolve => setTimeout(resolve, 10));
  await jobs.cancelForDevice('wireless-27');
  await unregisterRemote('wireless-27', { stateDir });
  await jobs.jobs.get(job.job).done;
  assert.equal(jobs.get(job.job).state, 'cancelled');
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'remote-devices.json'), 'utf8')), [], 'the pairing was not registered again');
});

test('unpairing waits for a re-registration that pairing_cancel already marked cancelled', { timeout: 30000 }, async t => {
  const { PairingJobs } = await import('../src/pairing/jobs.mjs');
  const { completeWirelessPairing } = await import('../src/pairing/wireless.mjs');
  const { registerRemote, unregisterRemote } = await import('../src/pairing/registry.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poki-cancel-then-unpair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  await registerRemote('wireless-27', 'Wireless iPhone', '192.0.2.27', 49152, join(dir, 'old.plist'), { stateDir });
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'record');
console.log(JSON.stringify(${JSON.stringify(paired)}));
`, { mode: 0o755 });
  let registering, finishRegistration;
  const gate = new Promise(resolve => { finishRegistration = resolve; });
  const jobs = new PairingJobs({ stateDir, native, complete: async (...args) => { registering = true; await gate; return completeWirelessPairing(...args); }, ensureImage: async () => ({ already: true }) });
  const { job } = jobs.start();
  while (!registering) await new Promise(resolve => setTimeout(resolve, 10));
  // The view's Cancel first: the job is cancelled, its registration still in flight.
  const cancelling = jobs.cancel(job.job);
  assert.equal(jobs.get(job.job).state, 'cancelled');
  // Then unpair_device, before the registration finishes.
  const unpairing = jobs.cancelForDevice('wireless-27').then(() => unregisterRemote('wireless-27', { stateDir }));
  setTimeout(finishRegistration, 100);
  await Promise.all([cancelling, unpairing]);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'remote-devices.json'), 'utf8')), [], 'the pairing was not registered again');
});

test('while a registered iPhone is paired again, other calls are refused and no stray helper is left behind', { timeout: 60000 }, async t => {
  // The old helper takes 1.5 s to shut down, the window in which another call used to start a helper
  // whose socket the old helper's cleanup then deleted.
  const { f, data, call, until, release } = await pairingFixture(t, { remote: { exitDelayMs: 1500 } });
  const first = data(await call('pair_device')).job.job;
  await release('accept');
  await until(first, j => j.terminal);
  const other = await f.connect();
  const second = data(await call('pair_device')).job.job;
  await until(second, j => j.state === 'pin');
  await release('accept');
  await until(second, j => j.state === 'registering');
  const read = await call('take_screenshot', { device: 'wireless-27' }, other);
  assert.equal(read.isError, true, 'the phone is out of reach while its pairing is replaced');
  assert.match(read.content[0].text, /being paired again/);
  assert.equal((await until(second, j => j.terminal)).state, 'ready');
  await new Promise(resolve => setTimeout(resolve, 500));
  const alive = (await f.events()).filter(e => e.helper === '--remote-server').map(e => e.pid).filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  assert.equal(alive.length, 1, `helpers still running: ${alive.join(', ')}`);
});

test('a cancelled re-pairing that could not take the device says the phone keeps its earlier pairing', { timeout: 30000 }, async t => {
  const { PairingJobs, describe } = await import('../src/pairing/jobs.mjs');
  const { registerRemote } = await import('../src/pairing/registry.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poki-cancel-note-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  await registerRemote('wireless-27', 'Wireless iPhone', '192.0.2.27', 49152, join(dir, 'old.plist'), { stateDir });
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'record');
console.log(JSON.stringify(${JSON.stringify(paired)}));
`, { mode: 0o755 });
  let waiting;
  // Another session's input holds the phone: the job waits for the lock until it is cancelled.
  const inputLock = { acquire: (keys, holder, signal) => new Promise((_, reject) => { waiting = true; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) };
  const jobs = new PairingJobs({ stateDir, native, ensureImage: async () => ({ already: true }) });
  jobs.coordinator = { leases: new Map(), inputLock };
  const { job } = jobs.start();
  while (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
  const cancelled = await jobs.cancel(job.job);
  assert.equal(cancelled.state, 'cancelled');
  assert.match(cancelled.note, /stays registered on this computer with its earlier pairing/);
  assert.doesNotMatch(cancelled.instruction, /nothing was saved/);
  assert.match(describe(cancelled), /earlier pairing/, 'the text for clients without MCP Apps carries the note');
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'remote-devices.json'), 'utf8')).map(d => d.id), ['wireless-27']);
});

test('the service\'s pairing jobs wait for the device\'s input lock that a running script holds', { timeout: 60000 }, async t => {
  const { f, data, call, until } = await pairingFixture(t, { registered: ['scripted-phone'], env: { POKI_INPUT_LOCK_WAIT_MS: '500' } });
  const other = await f.connect();
  // run_code holds its devices' input lock for the whole script.
  const script = call('run_code', { devices: ['scripted-phone'], code: "await tools.wait({ device: 'scripted-phone', seconds: 3 }); return 1;" }, other);
  await new Promise(resolve => setTimeout(resolve, 700));
  const { job } = data(await call('pair_device', { device: 'scripted-phone' })).job;
  const failed = await until(job, j => j.terminal);
  assert.equal(failed.reason, 'device_busy', JSON.stringify(failed));
  assert.equal((await f.events()).filter(e => e.remote === 'install_ddi').length, 0, 'nothing was installed under the script');
  const finished = await script;
  assert.ok(!finished.isError, JSON.stringify(finished));
});

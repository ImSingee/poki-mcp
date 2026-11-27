import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PairingJobs } from '../src/pairing/jobs.mjs';
import { downloadImage, resolveImage, ddiFailure, ensureDeveloperImage } from '../src/pairing/ddi.mjs';
import { registerRemote, unregisterRemote } from '../src/pairing/registry.mjs';
import { root } from '../src/config.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'poki-pairing-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A --pair-host stand-in that advertises and then waits until it is stopped.
async function waitingHelper(dir) {
  const file = join(dir, 'pair-host');
  await writeFile(file, `#!/usr/bin/env node
process.on('SIGTERM', () => { console.log(JSON.stringify({ event: 'cancelled' })); process.exit(1); });
console.log(JSON.stringify({ event: 'advertising', port: 1 }));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return file;
}

const waitFor = async (predicate, ms = 5000) => {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('a pairing nobody finishes times out, stops its helper and leaves nothing registered', async t => {
  const dir = await scratch(t);
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), native: await waitingHelper(dir), limitMs: 50, nativeRequest: async () => { throw new Error('unused'); } });
  // The JS fallback fires 5 s after the helper's own limit; the helper here never ends on its own.
  const { job } = jobs.start();
  await waitFor(() => jobs.jobs.get(job.job).state === 'advertising');
  const record = jobs.jobs.get(job.job);
  await waitFor(() => record.state === 'failed', 10000);
  assert.equal(record.reason, 'timeout');
  await waitFor(() => record.child.exitCode !== null || record.child.signalCode !== null);
  assert.equal(jobs.busy(), false);
  await assert.rejects(readFile(join(dir, 'state/remote-devices.json')), { code: 'ENOENT' });
});

test('a helper timeout event becomes a timeout failure, not a generic one', async t => {
  const dir = await scratch(t);
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
console.log(JSON.stringify({ event: 'advertising', port: 1 }));
console.log(JSON.stringify({ event: 'timeout' }));
console.error('Wireless pairing was not finished in Settings within 10 minutes.');
process.exit(1);
`, { mode: 0o755 });
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), native });
  const { job } = jobs.start();
  await waitFor(() => jobs.jobs.get(job.job).state === 'failed');
  assert.equal(jobs.jobs.get(job.job).reason, 'timeout');
});

test('finished jobs are kept for the retention period, then forgotten', async t => {
  const dir = await scratch(t);
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), native: await waitingHelper(dir), retainMs: 80 });
  const { job } = jobs.start();
  await waitFor(() => jobs.jobs.get(job.job).state === 'advertising');
  await jobs.cancel(job.job);
  assert.equal(jobs.get(job.job).state, 'cancelled');
  assert.equal(jobs.list().length, 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.throws(() => jobs.get(job.job), /No pairing job/);
  assert.deepEqual(jobs.list(), []);
});

test('cancelling every job on shutdown stops the helpers', async t => {
  const dir = await scratch(t);
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), native: await waitingHelper(dir) });
  const { job } = jobs.start();
  await waitFor(() => jobs.jobs.get(job.job).state === 'advertising');
  const { child } = jobs.jobs.get(job.job);
  await jobs.close();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(jobs.jobs.get(job.job).state, 'cancelled');
  // Its private staging directory is removed too.
  await jobs.jobs.get(job.job).done;
  assert.deepEqual((await readdir(join(dir, 'state/remote'))).filter(name => name.startsWith('wireless-')), []);
});

test('the registry adds and removes entries and their directories', async t => {
  const dir = await scratch(t);
  await registerRemote('phone-a', 'A', '192.0.2.1', 49152, join(dir, 'a.plist'), { stateDir: dir });
  await registerRemote('phone-b', 'B', 'b.local', 49152, join(dir, 'b.plist'), { stateDir: dir });
  assert.equal((await stat(join(dir, 'remote/phone-a/config.json'))).mode & 0o777, 0o600);
  const removed = await unregisterRemote('phone-a', { stateDir: dir });
  assert.equal(removed.id, 'phone-a');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'remote-devices.json'), 'utf8')).map(d => d.id), ['phone-b']);
  await assert.rejects(stat(join(dir, 'remote/phone-a')), { code: 'ENOENT' });
  assert.equal(await unregisterRemote('phone-a', { stateDir: dir }), undefined);
  await assert.rejects(unregisterRemote('../escape', { stateDir: dir }), /Invalid device id/);
});

test('the DDI download checks every file and writes BuildManifest.plist last', async t => {
  const dir = await scratch(t);
  const bytes = { 'Image.dmg': 'image', 'BuildManifest.plist': 'manifest' };
  const image = { build: 'test', baseUrl: 'https://mirror.invalid/ddi', files: Object.entries(bytes).map(([name, body]) => ({ name, sha256: createHash('sha256').update(body).digest('hex') })) };
  const requested = [];
  const fetchImpl = async url => { const name = url.split('/').at(-1); requested.push(name); return new Response(bytes[name]); };
  await downloadImage(join(dir, 'ok'), { image, fetchImpl });
  assert.deepEqual(requested, ['Image.dmg', 'BuildManifest.plist']);
  assert.equal(await readFile(join(dir, 'ok/BuildManifest.plist'), 'utf8'), 'manifest');
  // A complete copy is not fetched again.
  await downloadImage(join(dir, 'ok'), { image, fetchImpl });
  assert.equal(requested.length, 2);

  const tampered = async url => new Response(url.endsWith('Image.dmg') ? 'tampered' : 'manifest');
  await assert.rejects(downloadImage(join(dir, 'bad'), { image, fetchImpl: tampered }), /does not match the expected checksum/);
  await assert.rejects(stat(join(dir, 'bad/BuildManifest.plist')), { code: 'ENOENT' }, 'an incomplete image never looks complete');
  await assert.rejects(downloadImage(join(dir, 'missing'), { image, fetchImpl: async () => new Response('', { status: 404 }) }), /HTTP 404/);
});

test('POKI_DDI_DIR and a pymobiledevice3 copy are used before any download', async t => {
  const dir = await scratch(t);
  const own = join(dir, 'own');
  await mkdir(own);
  await writeFile(join(own, 'BuildManifest.plist'), 'x');
  const neverFetch = async () => { throw new Error('downloaded'); };
  assert.deepEqual(await resolveImage({ env: { HOME: dir, POKI_DDI_DIR: own }, stateDir: dir, fetchImpl: neverFetch }), { source: 'POKI_DDI_DIR', directory: own });
  const cached = join(dir, '.pymobiledevice3/Xcode_iOS_DDI_Cryptex');
  await mkdir(cached, { recursive: true });
  await writeFile(join(cached, 'BuildManifest.plist'), 'x');
  if (process.platform !== 'darwin') assert.deepEqual(await resolveImage({ env: { HOME: dir }, stateDir: dir, fetchImpl: neverFetch }), { source: 'pymobiledevice3', directory: cached });
  const empty = join(dir, 'empty-home');
  await mkdir(empty);
  if (process.platform !== 'darwin') {
    const failure = await resolveImage({ env: { HOME: empty }, stateDir: join(dir, 'state'), fetchImpl: neverFetch }).catch(error => error);
    assert.equal(failure.stage, 'image');
  }
});

test('DDI failures name their reason and only the tunnel install suggests USB', async () => {
  assert.equal(ddiFailure('signing', 'STATUS=94', 'p').reason, 'ddi_signing_failed');
  assert.equal(ddiFailure('install', 'TSS server responded with non-success status', 'p').reason, 'ddi_signing_failed');
  assert.equal(ddiFailure('image', 'offline', 'p').reason, 'ddi_image_unavailable');
  assert.equal(ddiFailure('unavailable', 'no cryptexd', 'p').reason, 'ddi_tunnel_unsupported');
  assert.equal(ddiFailure('install', 'refused', 'p').reason, 'ddi_tunnel_install_failed');
  for (const stage of ['unavailable', 'install']) assert.match(ddiFailure(stage, 'x', 'phone-1').action, /USB cable once.*prepare-device\.mjs phone-1/);
  for (const stage of ['signing', 'image']) assert.doesNotMatch(ddiFailure(stage, 'x', 'p').action, /prepare-device/);
  // Installed but still without displayservice: an image too old for this iOS.
  const request = async ({ op }) => op === 'ddi_status' ? { display_service: false } : { installed: true, display_service: false };
  const error = await ensureDeveloperImage('p', request, { resolve: async () => ({ source: 'test', directory: '/x' }) }).catch(e => e);
  assert.equal(error.failure.reason, 'ddi_tunnel_install_failed');
  assert.deepEqual(await ensureDeveloperImage('p', async () => ({ display_service: true, ddi: null })), { ready: true, already: true, ddi: null });
});

// The real helper: SIGTERM while advertising ends it cleanly with a cancelled event and no record.
const native = join(root, 'build/poki-native');
const realHelper = await stat(native).then(info => info.size > 1_000_000, () => false);
test('poki-native --pair-host stops on SIGTERM and says it was cancelled', { skip: !realHelper && 'build/poki-native is not built', timeout: 30000 }, async t => {
  const dir = await scratch(t);
  const output = join(dir, 'pairing.plist');
  const child = spawn(native, ['--pair-host', join(dir, 'host'), output, `poki-sigterm-${process.pid}`, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => events.push(JSON.parse(line)));
  await waitFor(() => events.some(e => e.event === 'advertising'), 15000);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('did not exit')), 10000))]);
  assert.notEqual(code, 0);
  assert.ok(events.some(e => e.event === 'cancelled'), JSON.stringify(events));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

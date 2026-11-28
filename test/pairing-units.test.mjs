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
import { helperError } from '../src/pairing/wireless.mjs';
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

// Generous: these wait for helper processes to start, which a loaded machine can delay.
const waitFor = async (predicate, ms = 15000) => {
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

test('finished jobs are kept for the retention period from when they ended, then forgotten', async t => {
  const dir = await scratch(t);
  // A clock the test moves: retention must not depend on how fast the helper exits.
  let clock = 1_000_000;
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), native: await waitingHelper(dir), retainMs: 60_000, now: () => clock });
  const { job } = jobs.start();
  await waitFor(() => jobs.jobs.get(job.job).state === 'advertising');
  clock += 5_000;
  await jobs.cancel(job.job);
  clock += 59_999;
  assert.equal(jobs.get(job.job).state, 'cancelled');
  assert.equal(jobs.list().length, 1);
  clock += 1;
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

// The real helper. It announces "starting" once its stop sources exist, so a SIGTERM from then on,
// even before it advertises, ends it with a cancelled event and an mDNS goodbye, never by the default
// disposition.
const native = join(root, 'build/poki-native');
const realHelper = await stat(native).then(info => info.size > 1_000_000, () => false);
// onEvent runs inside the line handler, so a SIGTERM sent from it reaches the helper with no delay
// after the line that triggered it.
async function realPairHost(t, dir, index = 0, onEvent = () => {}) {
  const output = join(dir, `pairing-${index}.plist`);
  const child = spawn(native, ['--pair-host', join(dir, 'host'), output, `poki-stop-${process.pid}-${index}`, '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const events = [];
  createInterface({ input: child.stdout }).on('line', line => { const event = JSON.parse(line); events.push(event); onEvent(event, child); });
  const exited = once(child, 'exit');
  const ended = async () => (await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('did not exit')), 10000))]));
  return { child, events, output, ended };
}
test('poki-native --pair-host ends with cancelled for a SIGTERM sent the moment it starts', { skip: !realHelper && 'build/poki-native is not built', timeout: 180000 }, async t => {
  const dir = await scratch(t);
  // A helper that registered its handler lazily dies by the signal in about two of three runs.
  for (let index = 0; index < 40; index++) {
    const helper = await realPairHost(t, dir, index, (event, child) => { if (event.event === 'starting') child.kill('SIGTERM'); });
    const [code, signal] = await helper.ended();
    assert.equal(signal, null, `run ${index} died by ${signal} instead of stopping: ${JSON.stringify(helper.events)}`);
    assert.equal(code, 1, JSON.stringify(helper.events));
    assert.ok(helper.events.some(e => e.event === 'cancelled'), JSON.stringify(helper.events));
    await assert.rejects(stat(helper.output), { code: 'ENOENT' });
  }
});

test('poki-native --pair-host stops when its standard input closes (the daemon died)', { skip: !realHelper && 'build/poki-native is not built', timeout: 30000 }, async t => {
  const dir = await scratch(t);
  const helper = await realPairHost(t, dir);
  await waitFor(() => helper.events.some(e => e.event === 'advertising'));
  helper.child.stdin.end();
  assert.deepEqual(await helper.ended(), [1, null]);
  assert.ok(helper.events.some(e => e.event === 'cancelled' && e.reason === 'parent_gone'), JSON.stringify(helper.events));
});

test('a helper failure reads as its message, not as the JSON line poki-native prints', () => {
  assert.equal(helperError('{"error":"The iPhone rejected the pairing request.","screen_change_verified":false}\n'), 'The iPhone rejected the pairing request.');
  assert.equal(helperError('plain failure\n'), 'plain failure');
});

test('an image listed as installed without displayservice is installed again once, by force', async () => {
  const requests = [];
  const request = async body => {
    requests.push(body);
    if (body.op === 'ddi_status') return { display_service: false };
    return body.force ? { installed: true, display_service: true, ddi: { version: '27B52' } } : { installed: true, already: true, display_service: false };
  };
  const prepared = await ensureDeveloperImage('p', request, { resolve: async () => ({ source: 'test', directory: '/x' }) });
  assert.equal(prepared.ready, true);
  assert.deepEqual(requests.map(r => [r.op, Boolean(r.force)]), [['ddi_status', false], ['reconnect', false], ['install_ddi', false], ['install_ddi', true]]);
});

test('a DDI installation holds the device\'s input lock, and fails as device_busy when it cannot get it', async t => {
  const dir = await scratch(t);
  const events = [];
  const target = { id: 'phone-lock', name: 'Phone', remote: join(dir, 'config.json') };
  const lock = { acquire: async (keys, holder) => { events.push(['acquire', keys, holder.tool]); return () => events.push(['release']); } };
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), ensureImage: async () => { events.push(['install']); return { already: false }; } });
  jobs.coordinator = { inputLock: lock };
  const { job } = jobs.start({ device: target });
  await jobs.jobs.get(job.job).done;
  assert.equal(jobs.get(job.job).state, 'ready');
  assert.deepEqual(events, [['acquire', ['phone-lock'], 'pair_device'], ['install'], ['release']]);

  jobs.coordinator = { inputLock: { acquire: async () => { throw new Error('Device phone-lock is busy: tap by session other'); } } };
  const busy = jobs.start({ device: { ...target, id: 'phone-busy' } }).job;
  await jobs.jobs.get(busy.job).done;
  const failed = jobs.get(busy.job);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reason, 'device_busy');
  assert.match(failed.action, /Another session is using phone-busy/);
});

test('a zombie process counts as gone', { skip: process.platform === 'win32' }, async () => {
  const { processGone } = await import('../src/remote.mjs');
  // The python parent never waits for its child, so the child stays a zombie while the parent runs.
  const parent = spawn('python3', ['-c', 'import os,sys,time\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(createInterface({ input: parent.stdout }), 'line');
  const zombie = Number(line);
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.doesNotThrow(() => process.kill(zombie, 0), 'kill(0) still finds the zombie');
    assert.equal(await processGone(zombie), true);
    assert.equal(await processGone(process.pid), false);
  } finally { parent.kill('SIGKILL'); }
});

test('jobs preparing two phones at once share one download of the image', async t => {
  const dir = await scratch(t);
  const bytes = { 'Image.dmg': 'image', 'BuildManifest.plist': 'manifest' };
  const image = { build: 'shared', baseUrl: 'https://mirror.invalid/ddi', files: Object.entries(bytes).map(([name, body]) => ({ name, sha256: createHash('sha256').update(body).digest('hex') })) };
  const requested = [];
  const fetchImpl = async url => { const name = url.split('/').at(-1); requested.push(name); await new Promise(resolve => setTimeout(resolve, 50)); return new Response(bytes[name]); };
  const env = { HOME: join(dir, 'home') };
  // As on Linux: no Xcode image to fall back on.
  const [first, second] = await Promise.all([1, 2].map(() => resolveImage({ env, stateDir: join(dir, 'state'), image, fetchImpl, platform: 'linux' })));
  assert.equal(first.directory, second.directory);
  assert.deepEqual(requested, ['Image.dmg', 'BuildManifest.plist'], 'each file was fetched once');
  assert.equal(await readFile(join(first.directory, 'Image.dmg'), 'utf8'), 'image');
  assert.deepEqual((await readdir(first.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('two processes changing the registry at once lose no entry', { timeout: 60000 }, async t => {
  const dir = await scratch(t);
  const registry = new URL('../src/pairing/registry.mjs', import.meta.url).href;
  const writer = prefix => spawn(process.execPath, ['--input-type=module', '-e', `
    import { registerRemote } from ${JSON.stringify(registry)};
    await Promise.all(Array.from({ length: 25 }, (_, i) => registerRemote('${prefix}-' + i, 'P', '192.0.2.1', 49152, '/tmp/p.plist', { stateDir: ${JSON.stringify(dir)} })));
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Their output stays out of this test's own report stream.
  const writers = ['a', 'b'].map(prefix => { const child = writer(prefix); child.errors = ''; child.stderr.on('data', chunk => { child.errors += chunk; }); child.exited = once(child, 'exit'); return child; });
  for (const child of writers) assert.equal((await child.exited)[0], 0, child.errors);
  const ids = JSON.parse(await readFile(join(dir, 'remote-devices.json'), 'utf8')).map(d => d.id);
  assert.equal(ids.length, 50, `entries lost: ${50 - ids.length}`);
  await assert.rejects(stat(join(dir, 'remote-devices.json.lock')), { code: 'ENOENT' }, 'the lock is released');
});

test('a session preparing a phone it leases itself is not held up by its own lease', async t => {
  const dir = await scratch(t);
  const target = { id: 'leased-phone', name: 'Phone', remote: join(dir, 'config.json') };
  const mine = {}, other = {};
  const coordinator = { leases: new Map([['leased-phone', { owner: mine, expires_at: 'soon' }]]), inputLock: { acquire: async () => () => {} } };
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), ensureImage: async () => ({ already: false }) });
  jobs.coordinator = coordinator;
  const own = jobs.start({ device: target, owner: mine }).job;
  await jobs.jobs.get(own.job).done;
  assert.equal(jobs.get(own.job).state, 'ready');
  const theirs = jobs.start({ device: target, owner: other }).job;
  await jobs.jobs.get(theirs.job).done;
  assert.equal(jobs.get(theirs.job).reason, 'device_busy', 'another session\'s lease still holds it up');
});

test('a lease taken while a DDI job waits for the input lock still stops the job', async t => {
  const dir = await scratch(t);
  const target = { id: 'contested-phone', name: 'Phone', remote: join(dir, 'config.json') };
  const leases = new Map(), released = [];
  let installed = false;
  // Another session's acquire_device was queued behind the same input: it gets its lease while the
  // job waits, and the job's turn comes after.
  const inputLock = { acquire: async () => { leases.set('contested-phone', { owner: {}, expires_at: 'later' }); return () => released.push('released'); } };
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), ensureImage: async () => { installed = true; return { already: false }; } });
  jobs.coordinator = { leases, inputLock };
  const { job } = jobs.start({ device: target, owner: {} });
  await jobs.jobs.get(job.job).done;
  const failed = jobs.get(job.job);
  assert.equal(failed.reason, 'device_busy');
  assert.match(failed.error, /leased by another session/);
  assert.equal(installed, false, 'nothing was installed under the other session\'s lease');
  assert.deepEqual(released, ['released'], 'the input lock was given back');
});

test('a pairing record moves into place only inside the registry transaction', async t => {
  const dir = await scratch(t);
  const { completeWirelessPairing } = await import('../src/pairing/wireless.mjs');
  const staging = join(dir, 'staging.plist');
  await writeFile(staging, 'record');
  await mkdir(join(dir, 'state'), { recursive: true });
  // Another process is in the middle of a registry change.
  await writeFile(join(dir, 'state/remote-devices.json.lock'), JSON.stringify({ pid: 1, nonce: 'other' }));
  const saving = completeWirelessPairing({ device: { udid: 'locked-phone', name: 'Phone' }, peer: '192.0.2.5' }, { pairing: staging, stateDir: join(dir, 'state') });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await readFile(staging, 'utf8'), 'record', 'the record waits with the registration');
  await assert.rejects(stat(join(dir, 'state/remote/locked-phone/pairing.plist')), { code: 'ENOENT' });
  await rm(join(dir, 'state/remote-devices.json.lock'));
  const saved = await saving;
  assert.equal(await readFile(join(dir, 'state/remote/locked-phone/pairing.plist'), 'utf8'), 'record');
  assert.equal(saved.id, 'locked-phone');
});

test('an accepted pairing is not failed by the pairing deadline while it is being saved', { timeout: 30000 }, async t => {
  const dir = await scratch(t);
  const { completeWirelessPairing } = await import('../src/pairing/wireless.mjs');
  const native = join(dir, 'pair-host');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'record');
console.log(JSON.stringify({ event: 'paired', device: { udid: 'late-phone', name: 'Late' }, peer: '192.0.2.6' }));
`, { mode: 0o755 });
  // A zero limit: the fallback deadline fires 5 s after the start, while saving takes 5.5 s.
  const jobs = new PairingJobs({ stateDir: join(dir, 'state'), native, limitMs: 0, complete: async (...args) => { await new Promise(resolve => setTimeout(resolve, 5500)); return completeWirelessPairing(...args); }, ensureImage: async () => ({ already: true }) });
  const { job } = jobs.start();
  await jobs.jobs.get(job.job).done;
  const done = jobs.get(job.job);
  assert.equal(done.state, 'ready', JSON.stringify({ state: done.state, reason: done.reason }));
});

test('the shared image download stops when every job waiting for it is cancelled', async t => {
  const dir = await scratch(t);
  const image = { build: 'cancel', baseUrl: 'https://mirror.invalid/ddi', files: [{ name: 'BuildManifest.plist', sha256: createHash('sha256').update('m').digest('hex') }] };
  let fetchSignal, fetches = 0;
  const fetchImpl = (url, { signal }) => { fetches++; fetchSignal = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const options = { env: { HOME: join(dir, 'home') }, stateDir: join(dir, 'state'), image, fetchImpl, platform: 'linux' };
  const [a, b] = [new AbortController(), new AbortController()];
  const first = resolveImage({ ...options, signal: a.signal }).catch(error => error);
  const second = resolveImage({ ...options, signal: b.signal }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fetches, 1, 'one download for both');
  a.abort(new Error('first job cancelled'));
  assert.equal((await first).stage, 'image');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fetchSignal.aborted, false, 'still wanted by the second job');
  b.abort(new Error('second job cancelled'));
  assert.equal((await second).stage, 'image');
  assert.equal(fetchSignal.aborted, true, 'nobody waits any more, so the download stopped');
  // The next job starts a new download instead of joining the stopped one.
  const c = new AbortController();
  const third = resolveImage({ ...options, signal: c.signal }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fetches, 2);
  c.abort(new Error('done'));
  await third;
});

test('two processes reclaiming the same stale registry lock never both hold it', async t => {
  const dir = await scratch(t);
  const { acquireFileLock, lockHooks } = await import('../src/pairing/registry.mjs');
  const { utimes } = await import('node:fs/promises');
  const lock = join(dir, 'remote-devices.json.lock');
  await writeFile(lock, 'left by a process that died');
  await utimes(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  // The first contender confirms the lock is stale, then pauses just before removing it.
  let resume, paused;
  const reached = new Promise(resolve => { paused = resolve; });
  lockHooks.beforeUnlinkStale = () => { lockHooks.beforeUnlinkStale = undefined; paused(); return new Promise(resolve => { resume = resolve; }); };
  t.after(() => { lockHooks.beforeUnlinkStale = undefined; });
  const holders = new Set();
  const contend = name => acquireFileLock(lock, { waitMs: 5000 }).then(release => { holders.add(name); return async () => { holders.delete(name); await release(); }; });
  const first = contend('first');
  await reached;
  const second = contend('second');
  await new Promise(resolve => setTimeout(resolve, 200));
  resume();
  const [winner, release] = await Promise.race([first.then(r => ['first', r]), second.then(r => ['second', r])]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual([...holders], [winner], 'only one contender holds the lock');
  await release();
  const other = await (winner === 'first' ? second : first);
  assert.equal(holders.size, 1);
  await other();
});

test('a break lock its owner left behind does not make contenders spin past their deadline', async t => {
  const dir = await scratch(t);
  const { acquireFileLock } = await import('../src/pairing/registry.mjs');
  const { utimes } = await import('node:fs/promises');
  const lock = join(dir, 'remote-devices.json.lock');
  await writeFile(lock, 'left by a process that died');
  await utimes(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  await writeFile(`${lock}.break`, 'a reclaimer that died a moment ago');
  const started = Date.now();
  await assert.rejects(acquireFileLock(lock, { waitMs: 500 }), /has been held/);
  assert.ok(Date.now() - started < 3000, `waited ${Date.now() - started} ms past a 500 ms deadline`);
});

test('removing a stale break lock never removes a reclaimer\'s live one', async t => {
  const dir = await scratch(t);
  const { acquireFileLock, lockHooks } = await import('../src/pairing/registry.mjs');
  const { utimes } = await import('node:fs/promises');
  const lock = join(dir, 'remote-devices.json.lock');
  const old = new Date(Date.now() - 60000);
  await writeFile(lock, 'left by a process that died');
  await utimes(lock, old, old);
  await writeFile(`${lock}.break`, 'a reclaimer that died long ago');
  await utimes(`${lock}.break`, old, old);
  // X finds the break lock stale and pauses; Y removes it, takes its own and pauses inside its section.
  let resumeX, xReached, resumeY, yReached;
  const xAt = new Promise(resolve => { xReached = resolve; }), yAt = new Promise(resolve => { yReached = resolve; });
  lockHooks.beforeUnlinkStaleBreaker = () => { lockHooks.beforeUnlinkStaleBreaker = undefined; xReached(); return new Promise(resolve => { resumeX = resolve; }); };
  t.after(() => { lockHooks.beforeUnlinkStaleBreaker = undefined; lockHooks.beforeUnlinkStale = undefined; });
  const holders = new Set();
  const contend = name => acquireFileLock(lock, { waitMs: 5000 }).then(release => { holders.add(name); return async () => { holders.delete(name); await release(); }; });
  const x = contend('X');
  await xAt;
  // Y: the stale break lock is X's to judge; remove it here as Y would have, then let Y in.
  const { unlink } = await import('node:fs/promises');
  await unlink(`${lock}.break`);
  lockHooks.beforeUnlinkStale = () => { lockHooks.beforeUnlinkStale = undefined; yReached(); return new Promise(resolve => { resumeY = resolve; }); };
  const y = contend('Y');
  await yAt;
  resumeX();
  await new Promise(resolve => setTimeout(resolve, 200));
  resumeY();
  const [first, release] = await Promise.race([x.then(r => ['X', r]), y.then(r => ['Y', r])]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual([...holders], [first], 'only one contender holds the lock');
  await release();
  await (await (first === 'X' ? y : x))();
});

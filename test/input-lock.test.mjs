import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Coordination } from '../src/coordination.mjs';
import { inputLockFromEnv } from '../src/input-lock.mjs';
import { fixture } from './fixture.mjs';

const lockWith = (env = {}) => inputLockFromEnv({ POKI_INPUT_LOCK_WAIT_MS: '1000', ...env });

// A session stand-in. route() answers the devices a call names (device, or run_code's devices) and a
// run that logs `<session>:<tool>[@device]:start|end` and takes `ms` (args.ms) to finish.
function session(label, log, ms = 40) {
  return {
    label, routing: Promise.resolve(), queues: new Map(), endings: new Set(), backgroundDevices: new Map(),
    async route(name, args = {}) {
      if (args.routeMs) await sleep(args.routeMs);
      const keys = name === 'run_code' ? args.devices : args.device ? [args.device] : [];
      const tag = `${label}:${name}${args.device ? `@${args.device}` : ''}`;
      return { keys, run: async () => {
        log.push(`${tag}:start`);
        await sleep(args.ms ?? ms);
        log.push(`${tag}:end`);
        return { content: [{ type: 'text', text: name }] };
      } };
    },
    async cleanup() { return {}; },
  };
}

test('the input lock reads its limits from the environment, and is always on', () => {
  const lock = inputLockFromEnv({ POKI_INPUT_LOCK_WAIT_MS: '250', POKI_MAX_CONCURRENT_READS: '2' });
  assert.equal(lock.waitMs, 250);
  assert.equal(lock.maxReads, 2);
  assert.equal(inputLockFromEnv({}).waitMs, 30000);
  assert.equal(inputLockFromEnv({}).maxReads, 4);
  assert.ok(new Coordination().inputLock, 'every daemon schedules by device');
  assert.throws(() => inputLockFromEnv({ POKI_INPUT_LOCK_WAIT_MS: 'soon' }), /POKI_INPUT_LOCK_WAIT_MS/);
});

test('a read from another session runs while input holds the device', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log, 80), b = session('b', log, 10);
  await Promise.all([coordinator.call(a, 'tap', { device: 'phone-a' }), sleep(5).then(() => coordinator.call(b, 'take_screenshot', { device: 'phone-a' }))]);
  assert.deepEqual(log, ['a:tap@phone-a:start', 'b:take_screenshot@phone-a:start', 'b:take_screenshot@phone-a:end', 'a:tap@phone-a:end']);
});

test('input from two sessions to one device runs one at a time', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log), b = session('b', log);
  await Promise.all([coordinator.call(a, 'tap', { device: 'phone-a' }), coordinator.call(b, 'type_text', { device: 'phone-a', text: 'x' })]);
  assert.deepEqual(log, ['a:tap@phone-a:start', 'a:tap@phone-a:end', 'b:type_text@phone-a:start', 'b:type_text@phone-a:end']);
});

test('one session drives two devices side by side and keeps each device in order', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log, 60);
  await Promise.all([
    coordinator.call(a, 'tap', { device: 'phone-a' }), coordinator.call(a, 'tap', { device: 'phone-b' }),
    coordinator.call(a, 'take_screenshot', { device: 'phone-a', ms: 5 }),
  ]);
  assert.deepEqual(log.slice(0, 2), ['a:tap@phone-a:start', 'a:tap@phone-b:start'], 'the second device does not wait for the first');
  assert.ok(log.indexOf('a:take_screenshot@phone-a:start') > log.indexOf('a:tap@phone-a:end'), 'a later read of phone-a waits for the earlier tap on it');
});

test('calls keep their arrival order on a device even when the first takes longer to route', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log, 10);
  // The first names the phone the slow way (its name must be looked up), the second by its id.
  await Promise.all([coordinator.call(a, 'tap', { device: 'phone-a', routeMs: 60 }), coordinator.call(a, 'press_key', { device: 'phone-a' })]);
  assert.deepEqual(log, ['a:tap@phone-a:start', 'a:tap@phone-a:end', 'a:press_key@phone-a:start', 'a:press_key@phone-a:end']);
});

test('a session that waits too long gets an error naming the holder and its tool', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith({ POKI_INPUT_LOCK_WAIT_MS: '50' });
  const log = [], a = session('agent-a', log, 300), b = session('agent-b', log);
  const first = coordinator.call(a, 'drag', { device: 'phone-a' });
  await sleep(5);
  await assert.rejects(coordinator.call(b, 'tap', { device: 'phone-a' }), error => {
    assert.equal(error.name, 'InputLockTimeout');
    assert.match(error.message, /Device phone-a is busy/);
    assert.match(error.message, /Session agent-a is running drag/);
    assert.match(error.message, /Waited 50 ms/);
    return true;
  });
  assert.ok(!log.includes('agent-b:tap@phone-a:start'));
  await first;
  // The failed wait leaves the lock usable.
  await coordinator.call(b, 'tap', { device: 'phone-a', ms: 1 });
  assert.ok(log.includes('agent-b:tap@phone-a:end'));
});

test('run_code holds the devices it names, and only those', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log, 60), b = session('b', log, 10);
  await Promise.all([
    coordinator.call(a, 'run_code', { devices: ['phone-a', 'phone-b'], code: '1' }),
    sleep(5).then(() => coordinator.call(b, 'tap', { device: 'phone-c' })),
    sleep(5).then(() => coordinator.call(b, 'tap', { device: 'phone-b' })),
  ]);
  assert.ok(log.indexOf('b:tap@phone-c:end') < log.indexOf('a:run_code:end'), 'a device the script does not name stays free');
  assert.ok(log.indexOf('b:tap@phone-b:start') > log.indexOf('a:run_code:end'), 'a device the script names waits for it');
});

test('two scripts naming the same devices in opposite order do not wait for each other forever', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log, 30), b = session('b', log, 30);
  await Promise.all([
    coordinator.call(a, 'run_code', { devices: ['phone-a', 'phone-b'], code: '1' }),
    coordinator.call(b, 'run_code', { devices: ['phone-b', 'phone-a'], code: '1' }),
  ]);
  assert.equal(log.filter(entry => entry.endsWith(':end')).length, 2);
  assert.ok(log.indexOf('b:run_code:start') > log.indexOf('a:run_code:end'));
});

test('a lock on several devices waits until all of them are free, and holds each of them', async () => {
  const lock = lockWith();
  const releaseA = await lock.acquire(['phone-a'], { session: 's', tool: 'tap' });
  let got = false;
  const pending = lock.acquire(['phone-b', 'phone-a'], { session: 't', tool: 'run_code' }).then(release => { got = true; return release; });
  await sleep(10);
  assert.equal(got, false);
  assert.ok(!lock.holders.has('phone-b'), 'nothing is held while waiting');
  releaseA();
  const release = await pending;
  assert.deepEqual([...lock.holders.keys()].sort(), ['phone-a', 'phone-b']);
  release();
  assert.equal(lock.holders.size, 0);
});

test('a tool marked unqueued runs beside input on its device', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  coordinator.unqueued = new Set(['screen_read']);
  const log = [], a = session('a', log, 80);
  await Promise.all([coordinator.call(a, 'tap', { device: 'phone-a' }), sleep(5).then(() => coordinator.call(a, 'screen_read', { device: 'phone-a', ms: 5 }))]);
  assert.deepEqual(log, ['a:tap@phone-a:start', 'a:screen_read@phone-a:start', 'a:screen_read@phone-a:end', 'a:tap@phone-a:end']);
});

test('reads are capped at POKI_MAX_CONCURRENT_READS', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith({ POKI_MAX_CONCURRENT_READS: '2' });
  const log = [], sessions = ['a', 'b', 'c'].map(name => session(name, log, 30));
  let peak = 0, running = 0;
  for (const s of sessions) {
    const route = s.route.bind(s);
    s.route = async (...args) => { const routed = await route(...args); return { ...routed, run: async () => { peak = Math.max(peak, ++running); try { return await routed.run(); } finally { running--; } } }; };
  }
  await Promise.all(sessions.map(s => coordinator.call(s, 'take_screenshot', { device: 'phone-a' })));
  assert.equal(peak, 2);
  assert.equal(log.filter(entry => entry.endsWith(':end')).length, 3);
});

test('an aborted wait leaves the queue and does not run', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log, 100), b = session('b', log);
  const first = coordinator.call(a, 'tap', { device: 'phone-a' });
  const controller = new AbortController();
  const second = coordinator.call(b, 'tap', { device: 'phone-a' }, controller.signal);
  await sleep(10);
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(second, /stop/);
  await first;
  assert.ok(!log.includes('b:tap@phone-a:start'));
  await coordinator.call(b, 'tap', { device: 'phone-a', ms: 1 });
  assert.ok(log.includes('b:tap@phone-a:end'));
});

test('a phone named by one session and given by its UDID in another takes one input lock', { timeout: 30000 }, async t => {
  const f = await fixture(t, { extraEnv: () => ({ POKI_INPUT_LOCK_WAIT_MS: '500' }) });
  const b = await f.connect();
  await f.call('list_devices');
  await f.set({ block: 'tap' });
  const taps = log => log.split('\n').filter(line => line.startsWith('{"op":"tap"')).length;
  const first = f.call('tap', { device: 'Fixture Phone', x: 10, y: 10 });
  first.catch(() => {});
  await f.until(log => taps(log) === 1);
  const second = await Promise.race([
    b.callTool({ name: 'tap', arguments: { device: 'fixture-phone', x: 10, y: 10 } }),
    f.until(log => taps(log) === 2).then(() => 'a second tap reached the phone while the first held it'),
  ]);
  assert.equal(second.isError, true, String(second));
  assert.match(second.content[0].text, /busy with input from another call/);
  assert.equal((await f.events()).filter(event => event.op === 'tap').length, 1);
});

// A cancellation can arrive while Coordination is still resolving the device or waiting
// for this session's earlier call, before the lock installs its abort listener.
test('already cancelled work cannot enter either lock queue', async () => {
  const lock = lockWith();
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled before lock entry', 'AbortError'));
  await assert.rejects(lock.acquire(['phone-a'], { session: 'cancelled', tool: 'tap' }, controller.signal), /cancelled before lock entry/);
  await assert.rejects(lock.readSlot(controller.signal), /cancelled before lock entry/);
  assert.equal(lock.holders.size, 0);
  assert.equal(lock.reads, 0);
  const input = await lock.acquire(['phone-a'], { session: 'holder', tool: 'tap' });
  const read = await lock.readSlot();
  lock.maxReads = 1;
  try {
    await assert.rejects(lock.acquire(['phone-a', 'phone-b'], { session: 'cancelled', tool: 'tap' }, controller.signal), /cancelled before lock entry/);
    await assert.rejects(lock.readSlot(controller.signal), /cancelled before lock entry/);
    assert.equal(lock.waiters.size, 0);
    assert.equal(lock.readWaiters.length, 0);
  } finally { input(); read(); }
});

test('cancellation during device resolution does not leave a lock waiter behind', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('cancelled', log);
  let resolveDevice, resolving;
  const entered = new Promise(resolve => { resolving = resolve; });
  const route = a.route.bind(a);
  a.route = (...args) => { resolving(); return new Promise(resolve => { resolveDevice = () => resolve(route(...args)); }); };
  const held = await coordinator.inputLock.acquire(['phone-a'], { session: 'holder', tool: 'tap' });
  const controller = new AbortController();
  const call = coordinator.call(a, 'tap', { device: 'phone-a' }, controller.signal);
  await entered;
  controller.abort(new DOMException('cancelled during resolution', 'AbortError'));
  await assert.rejects(call, /cancelled during resolution/);
  resolveDevice();
  await sleep(20);
  try {
    assert.equal(coordinator.inputLock.waiters.size, 0, 'cancelled work must not wait for the device after the client has returned');
    assert.deepEqual(log, []);
  } finally { held(); await a.queues.get('phone-a'); }
});

test('a stop on one device also stops a call to it that was still finding its device', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = lockWith();
  const log = [], a = session('a', log, 10);
  const slow = coordinator.call(a, 'tap', { device: 'phone-a', routeMs: 80 });
  await sleep(10);
  await coordinator.end(a, 'cancelled', ['phone-a']);
  const result = await slow;
  assert.equal(result.isError, true);
  assert.equal(result._meta.stop_reason, 'cancelled');
  assert.deepEqual(log, []);
  // A call made after the stop runs.
  await coordinator.call(a, 'tap', { device: 'phone-a' });
  assert.deepEqual(log, ['a:tap@phone-a:start', 'a:tap@phone-a:end']);
});

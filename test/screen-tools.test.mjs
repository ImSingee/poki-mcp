import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { Coordination } from '../src/coordination.mjs';
import { work } from '../src/work.mjs';
import { Session } from '../src/device.mjs';
import { Screens } from '../src/stream/hub.mjs';
import { nativeInput, screenInput, takeOver, runScreenTool, INPUT_WAIT_MS } from '../src/stream/tools.mjs';
import { iceServers, packet, chunks, RTC_CHUNK_BYTES, MAGIC } from '../src/stream/rtc.mjs';
import { fakeNative } from './stream-fixture.mjs';

const target = { id: 'fixture-phone', kind: 'physical' };
const until = async (predicate, ms = 5000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await delay(5); } };

// A takeover token as a refused gesture's reply carries it.
const grant = viewer => { viewer.takeoverTokens ??= new Map(); const token = `test-token-${Math.random().toString(36).slice(2)}`; viewer.takeoverTokens.set(token, performance.now() + 60000); return token; };

async function setup(t) {
  const coordinator = new Coordination();
  const agent = new Session(coordinator), view = new Session(coordinator);
  agent.label = 'agent'; view.label = 'view';
  const screens = new Screens({ ...fakeNative(), ffmpeg: async () => false });
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  t.after(() => screens.closeAll());
  const sent = [];
  const native = async (device, request) => { sent.push({ device: device.id, ...request }); return { sent: true }; };
  return { coordinator, agent, view, viewer, sent, native };
}

test('view gestures become the native ops, with coordinates normalized to 0..65535', () => {
  assert.deepEqual(nativeInput({ kind: 'tap', x: 0.5, y: 0.25 }), { op: 'tap', x: 32768, y: 16384, duration_ms: 50 });
  assert.deepEqual(nativeInput({ kind: 'long_press', x: 0, y: 1, t_ms: 900 }), { op: 'long_press', x: 0, y: 65535, duration_ms: 900 });
  assert.deepEqual(nativeInput({ kind: 'swipe', x: 0.5, y: 0.8, x2: 0.5, y2: 0.2, t_ms: 20 }), { op: 'drag', x1: 32768, y1: 52428, x2: 32768, y2: 13107, duration_ms: 60 });
  assert.equal(nativeInput({ kind: 'drag', x: 0, y: 0, x2: 1, y2: 1, t_ms: 1500 }).duration_ms, 1500);
  // A vertical pinch near the left edge keeps its axis, so its contacts stay on the screen.
  const vertical = nativeInput({ kind: 'pinch', x: 0.1, y: 0.5, start_distance: 0.5, end_distance: 0.3, angle: 90 });
  assert.equal(vertical.angle, 90);
  const pinch = nativeInput({ kind: 'pinch', x: 0.5, y: 0.5, start_distance: 0.1, end_distance: 0.4, t_ms: 300 });
  assert.equal(pinch.op, 'pinch'); assert.equal(Math.round(pinch.start_distance), 6554); assert.equal(Math.round(pinch.end_distance), 26214);
  assert.deepEqual(nativeInput({ kind: 'button', button: 'volume_up' }), { op: 'button', button: 'volume-up' });
  assert.deepEqual(nativeInput({ kind: 'key', key: 'Return' }), { op: 'key', key: 'return', modifiers: [] });
  assert.deepEqual(nativeInput({ kind: 'text', text: 'hello 42' }), { op: 'type_keys', text: 'hello 42' });
  assert.deepEqual(nativeInput({ kind: 'text', text: '你好' }), { op: 'type_text', text: '你好' });
  assert.throws(() => nativeInput({ kind: 'swipe', x: 0, y: 0 }), /x2 and y2/);
  assert.throws(() => nativeInput({ kind: 'key', key: 'F13' }), /Unsupported key/);
});

test('screen_input waits briefly for the input lock, then reports the agent busy without sending', async t => {
  const { coordinator, view, viewer, sent, native } = await setup(t);
  const release = await coordinator.inputLock.acquire([target.id], { session: 'agent', tool: 'batch_commands' });
  const started = performance.now();
  const busy = await screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native });
  assert.equal(busy.structuredContent.reason, 'busy');
  assert.match(busy.content[0].text, /batch_commands/);
  assert.ok(performance.now() - started >= INPUT_WAIT_MS - 50 && performance.now() - started < INPUT_WAIT_MS + 1000);
  assert.deepEqual(sent, []);
  // Once the agent's input ends, the view's gesture goes through and marks the screen changed.
  const before = coordinator.revision(target.id);
  const pending = screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native });
  await delay(50);
  assert.deepEqual(sent, [], 'the gesture overtook the agent\'s input');
  release();
  assert.equal((await pending).structuredContent.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(coordinator.revision(target.id), before + 1);
});

test('screen_input respects another session\'s lease, and a confirmed takeover ends that session\'s work', async t => {
  const { coordinator, agent, view, viewer, sent, native } = await setup(t);
  await coordinator.acquire(agent, target, 120);
  const refused = await screenInput(view, viewer, { kind: 'tap', x: 0.1, y: 0.1 }, { native });
  assert.equal(refused.structuredContent.reason, 'busy');
  assert.deepEqual(sent, []);
  // The agent has a call in flight on the device when the person takes over.
  let aborted;
  const work = coordinator.call(agent, 'poki_mcp_status', {}, undefined, 'r1');
  for (const op of coordinator.operations) if (op.owner === agent) { op.devices.add(target.id); op.controller.signal.addEventListener('abort', () => { aborted = op.controller.signal.reason; }); }
  const taken = await takeOver(view, viewer, { token: refused.structuredContent.takeover_token });
  await work.catch(() => {});
  assert.equal(taken.structuredContent.taken_over, true);
  assert.equal(aborted?.stopReason, 'taken_over');
  assert.equal(coordinator.leases.get(target.id).owner, viewer.owner);
  // The agent is kept off, even though the view's calls may come on the agent's own session, and
  // is told why.
  assert.throws(() => coordinator.access(agent, target), /occupied: the screen panel took over fixture-phone/);
  assert.equal((await screenInput(agent, viewer, { kind: 'tap', x: 0.2, y: 0.2 }, { native })).structuredContent.sent, true);
  assert.equal(sent.length, 1);
  // Closing the view hands the device back.
  viewer.close();
  await delay(20);
  assert.equal(coordinator.leases.has(target.id), false);
  coordinator.access(agent, target);
});

test('ICE servers: public STUN by default, none when turned off, and TURN credentials from the shared secret', () => {
  assert.deepEqual(iceServers({}), [{ urls: ['stun:stun.l.google.com:19302'] }]);
  assert.deepEqual(iceServers({ POKI_STUN_URL: '' }), []);
  const now = Date.UTC(2026, 10, 28);
  const [, turn] = iceServers({ POKI_TURN_URL: 'turn:turn.example:3478, turns:turn.example:443', POKI_TURN_SECRET: 'secret' }, now);
  // werift uses only the first TURN URL: the TLS one on 443 goes first.
  assert.deepEqual(turn.urls, ['turns:turn.example:443', 'turn:turn.example:3478']);
  assert.equal(turn.username, `${now / 1000 + 3600}:poki`);
  assert.equal(turn.credential, createHmac('sha1', 'secret').update(turn.username).digest('base64'));
  assert.throws(() => iceServers({ POKI_TURN_URL: 'http://x', POKI_TURN_SECRET: 'secret' }), /must start with/);
  // A view is only given credentials that expire: no TURN without the shared secret.
  assert.throws(() => iceServers({ POKI_TURN_URL: 'turn:turn.example:3478', POKI_TURN_USERNAME: 'u', POKI_TURN_PASSWORD: 'p' }), /POKI_TURN_SECRET/);
  const [, short] = iceServers({ POKI_STUN_URL: 'stun:a', POKI_TURN_URL: 'turn:t', POKI_TURN_SECRET: 's', POKI_TURN_TTL_SECONDS: '600' }, now, { label: 'poki-abc' });
  assert.equal(short.username, `${now / 1000 + 600}:poki-abc`);
});

test('RTC packets carry the codec, sequence, key flag and config, in chunks the view reassembles', () => {
  const frame = { seq: 7, key: true, config: Buffer.from([1, 2]), data: Buffer.alloc(40000, 9) };
  const hevc = packet('hevc', frame);
  assert.equal(hevc.readUInt32BE(0), MAGIC.hevc);
  assert.equal(hevc.readUInt32BE(4), 7);
  assert.equal(hevc[8], 2);
  assert.equal(hevc.readUInt16BE(9), 2);
  assert.equal(hevc.length, 11 + 2 + 40000);
  const parts = [...chunks(hevc)];
  assert.ok(parts.every(part => part.length <= RTC_CHUNK_BYTES));
  const joined = Buffer.alloc(hevc.length);
  for (const part of parts) { assert.equal(part.readUInt32BE(0), hevc.length); part.copy(joined, part.readUInt32BE(4), 8); }
  assert.deepEqual(joined, hevc);
  const jpeg = packet('jpeg', { seq: 3, key: true, data: Buffer.from([0xff, 0xd8]) });
  assert.equal(jpeg.readUInt32BE(0), MAGIC.jpeg);
  assert.equal(jpeg.length, 10);
});

// The takeover runs as a tool call: its own operation must not count as another owner's work on the
// device, or the takeover refuses itself ("Device has an active operation").
test('screen_takeover called as a tool takes the device, and the agent is then refused', async t => {
  const { coordinator, agent, view, viewer, sent, native } = await setup(t);
  const op = { owner: view, controller: new AbortController(), devices: new Set(), timings: [] };
  coordinator.operations.add(op);
  const taken = await work.run({ operation: op, signal: op.controller.signal, timings: op.timings }, () => takeOver(view, viewer, { token: grant(viewer) }));
  coordinator.operations.delete(op);
  assert.equal(taken.structuredContent?.taken_over, true, JSON.stringify(taken));
  assert.equal(coordinator.leases.get(target.id).owner, viewer.owner);
  assert.throws(() => coordinator.access(agent, target), /occupied/);
  assert.throws(() => coordinator.access(view, target), /occupied/, 'the MCP session the view calls on is kept off too');
  // The view's own gestures, also made as tool calls, go through.
  const input = { owner: view, controller: new AbortController(), devices: new Set(), timings: [] };
  coordinator.operations.add(input);
  const reply = await work.run({ operation: input, signal: input.controller.signal, timings: input.timings }, () => screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native }));
  coordinator.operations.delete(input);
  assert.equal(reply.structuredContent.sent, true, JSON.stringify(reply));
  assert.equal(sent.length, 1);
});

test('a gesture that waited for the lock is refused if a lease was taken meanwhile, and no lease is taken while one is sent', async t => {
  const { coordinator, agent, view, viewer, sent, native } = await setup(t);
  const release = await coordinator.inputLock.acquire([target.id], { session: 'agent', tool: 'tap' });
  const waiting = screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native });
  await delay(100);
  await coordinator.acquire(agent, target, 120);
  release();
  assert.equal((await waiting).structuredContent.reason, 'busy');
  assert.deepEqual(sent, [], 'the gesture landed during the agent\'s lease');
  await coordinator.end(agent, 'released', [target.id]);
  // While a gesture is on its way to the phone, the device cannot be leased from under it.
  let finish;
  const slow = (device, request) => new Promise(resolve => { sent.push(request); finish = () => resolve({ sent: true }); });
  const sending = screenInput(view, viewer, { kind: 'tap', x: 0.1, y: 0.1 }, { native: slow });
  await until(() => sent.length === 1);
  await assert.rejects(coordinator.acquire(agent, target, 120), /active operation/);
  finish();
  assert.equal((await sending).structuredContent.sent, true);
  await coordinator.acquire(agent, target, 120);
});

test('a device another session holds can still be watched', async t => {
  const coordinator = new Coordination();
  const agent = new Session(coordinator), view = new Session(coordinator);
  const phone = { id: 'fixture-phone', kind: 'physical', name: 'Lab iPhone' };
  for (const session of [agent, view]) session.inventory = async () => [phone];
  await coordinator.acquire(agent, phone, 120);
  const route = await view.route('show_screen', { device: 'fixture-phone' });
  const shown = await route.run();
  assert.equal(shown.structuredContent?.device, 'fixture-phone', JSON.stringify(shown));
  await coordinator.end(agent, 'released', [phone.id]);
});

test('a takeover also stops another session\'s recording or simulated location on the device', async t => {
  const { coordinator, agent, view, viewer } = await setup(t);
  // The agent started a recording earlier; no call is in flight and it holds no lease.
  agent.backgroundDevices.set(target.id, new Set(['recording']));
  let cleaned;
  agent.cleanup = async devices => { cleaned = [...devices]; agent.backgroundDevices.delete(target.id); return { recordings: [], locations: [] }; };
  view.peers = () => [agent, view];
  const taken = await takeOver(view, viewer, { token: grant(viewer) });
  assert.equal(taken.structuredContent?.taken_over, true, JSON.stringify(taken));
  assert.deepEqual(cleaned, [target.id], 'the recording kept running under the takeover');
});

test('a lease the agent took on the same MCP session still keeps the view\'s gestures off', async t => {
  const { coordinator, view, viewer, sent, native } = await setup(t);
  // One stdio connection carries both the agent's calls and the view's: the same session.
  await coordinator.acquire(view, target, 120);
  const reply = await screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native });
  assert.equal(reply.structuredContent.reason, 'busy', JSON.stringify(reply));
  assert.deepEqual(sent, []);
});

test('a takeover whose panel closes while the agent\'s work stops takes no lease', async t => {
  const { coordinator, agent, view, viewer } = await setup(t);
  // The agent has a call in flight on the device that takes a while to stop.
  let finish;
  const op = { owner: agent, devices: new Set([target.id]), controller: new AbortController(), timings: [], done: new Promise(resolve => { finish = resolve; }) };
  coordinator.operations.add(op);
  const taking = takeOver(view, viewer, { token: grant(viewer) });
  await delay(20);
  viewer.close();
  coordinator.operations.delete(op); finish();
  const taken = await taking;
  assert.equal(taken.structuredContent?.reason, 'stream_closed', JSON.stringify(taken));
  assert.equal(coordinator.leases.has(target.id), false, 'a closed panel kept the agent off the device');
});

test('stopping the device\'s work stops a gesture that is still being sent', async t => {
  const { coordinator, view, viewer } = await setup(t);
  const { signal: workSignal } = await import('../src/work.mjs');
  let aborted = false;
  // A long text input: the native request runs until its signal aborts.
  const slow = () => new Promise(resolve => { const s = workSignal(); s?.addEventListener('abort', () => { aborted = true; resolve({ isError: true, error: 'cancelled' }); }, { once: true }); });
  const sending = screenInput(view, viewer, { kind: 'text', text: 'a long message' }, { native: slow });
  await until(() => [...coordinator.operations].some(op => op.devices.has(target.id)));
  const stopped = coordinator.end(view, 'cancelled', [target.id]);
  await sending;
  await stopped;
  assert.equal(aborted, true, 'the native request went on after cancel_device');
});

test('cancel_device stops a gesture that is still waiting for the input lock', async t => {
  const { coordinator, view, viewer, sent, native } = await setup(t);
  const release = await coordinator.inputLock.acquire([target.id], { session: 'agent', tool: 'batch_commands' });
  t.after(release);
  const started = Date.now();
  const waiting = screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native });
  await delay(100);
  const stopped = await coordinator.end(view, 'cancelled', [target.id]);
  const reply = await waiting;
  assert.equal(reply.structuredContent.reason, 'stopped', JSON.stringify(reply));
  assert.equal(stopped.cancelled_operations, 1);
  assert.ok(Date.now() - started < INPUT_WAIT_MS, 'the gesture waited out the lock after cancel_device');
  assert.deepEqual(sent, []);
});

test('a gesture whose panel closed while it waited for the input lock is not sent', async t => {
  const { coordinator, view, viewer, sent, native } = await setup(t);
  const release = await coordinator.inputLock.acquire([target.id], { session: 'agent', tool: 'tap' });
  const waiting = screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native });
  await delay(100);
  viewer.close();
  release();
  const reply = await waiting;
  assert.equal(reply.structuredContent.reason, 'stream_closed', JSON.stringify(reply));
  assert.deepEqual(sent, [], 'a gesture from a closed panel reached the phone');
});

test('disconnect_device ends the phone\'s screen panels, so their subscription does not reconnect it', async t => {
  const { createServer } = await import('node:net');
  const { createHash, randomUUID } = await import('node:crypto');
  const { mkdir, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const { screens } = await import('../src/stream/hub.mjs');
  const phone = { id: 'remote-phone', kind: 'physical', name: 'Remote iPhone', remote: `/nonexistent/${randomUUID()}/config.json`, connection: 'RemotePairing' };
  // The phone's RemotePairing helper, at the socket the daemon derives from its config path.
  const directory = `/tmp/poki-remote-${process.getuid()}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = join(directory, createHash('sha256').update(phone.remote).digest('hex').slice(0, 24) + '.sock');
  const ops = [];
  const server = createServer(socket => {
    socket.write(JSON.stringify({ pid: process.pid }) + '\n');
    let buffered = '';
    socket.on('data', chunk => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      const { op } = JSON.parse(buffered.slice(0, buffered.indexOf('\n')));
      ops.push(op);
      socket.end(JSON.stringify(op === 'disconnect' ? { disconnected: true } : { error: 'unexpected' }) + '\n');
    });
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(async () => { server.close(); await unlink(path).catch(() => {}); });
  // The daemon's own screens, over a stand-in subscription.
  const native = fakeNative();
  const deps = screens.deps;
  screens.deps = { ...deps, ...native, ffmpeg: async () => false };
  t.after(() => { screens.closeAll(); screens.deps = deps; });
  const viewer = await screens.open(phone, { codecs: ['hevc'] });
  const session = new Session(new Coordination());
  session.inventory = async () => [phone];
  // As the daemon wires them.
  screens.attach({ unavailable: id => session.coordinator.unavailable.get(id), activity: id => session.coordinator.lastActive(id), started: id => session.coordinator.lastStarted(id) });
  const route = await session.route('disconnect_device', { device: phone.id });
  const reply = await route.run();
  assert.ok(!reply.isError, JSON.stringify(reply));
  assert.deepEqual(ops, ['disconnect']);
  assert.equal(viewer.closed, true, 'the panel kept watching a disconnected phone');
  // The view is told it was a disconnect, by a read still waiting and by a later call on the stream.
  assert.equal((await viewer.read({ wait_ms: 0 })).reason, 'device_disconnected');
  const later = await runScreenTool(session, 'screen_read', { stream: viewer.id, wait_ms: 0 }, { screens });
  assert.equal(later.structuredContent?.reason, 'device_disconnected', JSON.stringify(later));
  // A panel mounted again looks the devices up first: a lookup is not a tool acting on the phone, so
  // the stream still opens only when the person asks.
  await (await session.route('list_devices', {})).run();
  await assert.rejects(screens.open(phone, { codecs: ['hevc'] }), error => error.reason === 'device_disconnected', 'list_devices reopened a phone disconnected on purpose');
  assert.equal(native.subscriptions[0].open, false, 'the subscription stayed, to reconnect the phone');
});

test('a disconnect still reaches a panel that has taken over the iPhone', async t => {
  const { coordinator, view, viewer } = await setup(t);
  void coordinator;
  const taken = await takeOver(view, viewer, { token: grant(viewer) });
  assert.equal(taken.structuredContent?.taken_over, true, JSON.stringify(taken));
  viewer.screens.closeDevice(target.id);
  assert.equal(viewer.ended?.reason, 'device_disconnected', 'the takeover dropped the disconnect\'s reason');
  assert.throws(() => viewer.screens.get(viewer.id), { code: 'device_disconnected' });
  assert.equal(viewer.takeover, undefined);
});

test('a takeover needs the token of a gesture the agent refused, used once, and the approval', async t => {
  const { coordinator, agent, view, viewer, native } = await setup(t);
  await coordinator.acquire(agent, target, 120);
  // No token (a model calling screen_takeover on its own) and a made-up one are refused.
  assert.equal((await takeOver(view, viewer, {})).structuredContent.reason, 'no_token');
  assert.equal((await takeOver(view, viewer, { token: 'x'.repeat(32) })).structuredContent.reason, 'no_token');
  assert.equal(coordinator.leases.get(target.id).owner, agent);
  // A refused gesture carries one; a declined approval takes nothing, and the token is spent.
  const { takeover_token: token } = (await screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native })).structuredContent;
  assert.ok(token);
  const declined = await takeOver(view, viewer, { token, approve: async () => ({ refused: true, message: 'declined' }) });
  assert.equal(declined.structuredContent.reason, 'not_approved');
  assert.equal(coordinator.leases.get(target.id).owner, agent, 'a declined takeover ended the agent\'s lease');
  assert.equal((await takeOver(view, viewer, { token })).structuredContent.reason, 'no_token', 'a token was used twice');
  // An expired token is refused.
  const late = (await screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native })).structuredContent.takeover_token;
  viewer.takeoverTokens.set(late, performance.now() - 1);
  assert.equal((await takeOver(view, viewer, { token: late })).structuredContent.reason, 'no_token');
  // An approved one takes over.
  const approved = (await screenInput(view, viewer, { kind: 'tap', x: 0.5, y: 0.5 }, { native })).structuredContent.takeover_token;
  let asked = 0;
  const taken = await takeOver(view, viewer, { token: approved, approve: async () => { asked++; } });
  assert.equal(taken.structuredContent.taken_over, true, JSON.stringify(taken));
  assert.equal(asked, 1);
});

test('a takeover lasts while the panel keeps its stream, beyond the takeover lease', async t => {
  const { coordinator, view, viewer } = await setup(t);
  const taken = await takeOver(view, viewer, { token: grant(viewer) });
  assert.equal(taken.structuredContent.taken_over, true);
  const lease = coordinator.leases.get(target.id);
  const until = lease.until;
  // The view reads (renewing its stream) later on: the takeover is renewed with it.
  viewer.renew(performance.now() + 6000);
  await delay(10);
  viewer.onRenew(performance.now() + 6000);
  assert.ok(coordinator.leases.get(target.id).until > until, 'the takeover was not renewed by the panel\'s reads');
});

test('a long tool call on a device counts as activity while it runs and until it ends', async t => {
  const coordinator = new Coordination();
  const session = new Session(coordinator);
  const phone = { id: 'fixture-phone', kind: 'physical', name: 'Lab iPhone' };
  session.inventory = async () => [phone];
  const route = await session.route('wait', { device: phone.id, seconds: 0.6 });
  const started = performance.now();
  const running = route.run();
  // Midway, the device is active now (not as of the call's start).
  await delay(400);
  assert.ok(performance.now() - coordinator.lastActive(phone.id) < 50, 'a running call did not count as activity now');
  await running;
  const ended = performance.now();
  await delay(200);
  const active = coordinator.lastActive(phone.id);
  assert.ok(active >= ended - 100 && active <= ended, `activity ${Math.round(active - started)} ms into a ${Math.round(ended - started)} ms call`);
  assert.ok(coordinator.lastStarted(phone.id) - started < 100);
});


test('in ask mode a takeover through the MCP route asks on this computer, and a declined dialog takes nothing', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { screens } = await import('../src/stream/hub.mjs');
  // The dialog: osascript on macOS, zenity on Linux; both answer "cancelled".
  const bin = await mkdtemp(join(tmpdir(), 'poki-dialog-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, 'osascript'), '#!/bin/sh\necho cancelled\n', { mode: 0o755 });
  await writeFile(join(bin, 'zenity'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const saved = { PATH: process.env.PATH, POKI_MCP_APPROVAL_MODE: process.env.POKI_MCP_APPROVAL_MODE, DISPLAY: process.env.DISPLAY };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, POKI_MCP_APPROVAL_MODE: 'ask', DISPLAY: ':0' });
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  const native = fakeNative();
  const deps = screens.deps;
  screens.deps = { ...deps, ...native, ffmpeg: async () => false };
  t.after(() => { screens.closeAll(); screens.deps = deps; });
  const coordinator = new Coordination();
  const agent = new Session(coordinator), view = new Session(coordinator);
  const phone = { id: 'fixture-phone', kind: 'physical', name: 'Lab iPhone' };
  for (const session of [agent, view]) session.inventory = async () => [phone];
  await coordinator.acquire(agent, phone, 120);
  const opened = (await (await view.route('screen_open', { device: phone.id, codecs: ['hevc'] })).run()).structuredContent;
  const busy = (await (await view.route('screen_input', { stream: opened.stream, kind: 'tap', x: 0.5, y: 0.5 })).run()).structuredContent;
  assert.ok(busy.takeover_token, JSON.stringify(busy));
  const taken = await (await view.route('screen_takeover', { stream: opened.stream, token: busy.takeover_token })).run();
  assert.equal(taken.structuredContent?.reason, 'not_approved', JSON.stringify(taken));
  assert.equal(coordinator.leases.get(phone.id).owner, agent, 'a takeover nobody approved ended the agent\'s lease');
});

// The helper socket of a RemotePairing phone, answering disconnect (and nothing else).
async function disconnectableHelper(t) {
  const { createServer } = await import('node:net');
  const { createHash, randomUUID } = await import('node:crypto');
  const { mkdir, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const phone = { id: 'remote-phone', kind: 'physical', name: 'Remote iPhone', remote: `/nonexistent/${randomUUID()}/config.json`, connection: 'RemotePairing' };
  const directory = `/tmp/poki-remote-${process.getuid()}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = join(directory, createHash('sha256').update(phone.remote).digest('hex').slice(0, 24) + '.sock');
  const server = createServer(socket => {
    socket.write(JSON.stringify({ pid: process.pid }) + '\n');
    let buffered = '';
    socket.on('data', chunk => { buffered += chunk; if (!buffered.includes('\n')) return; const { op } = JSON.parse(buffered.slice(0, buffered.indexOf('\n'))); socket.end(JSON.stringify(op === 'disconnect' ? { disconnected: true } : { error: 'unexpected' }) + '\n'); });
  });
  server.listen(path); await once(server, 'listening');
  t.after(async () => { server.close(); await unlink(path).catch(() => {}); });
  return phone;
}

for (const [label, overlapping] of [
  ['a call already running when the person disconnects', async (coordinator, agent, person, phone) => {
    const waiting = coordinator.call(agent, 'wait', { device: phone.id, seconds: 1 });
    await delay(300);
    assert.ok(!(await coordinator.call(person, 'disconnect_device', { device: phone.id })).isError);
    await waiting;
  }],
  ['the batch the disconnect is part of', async (coordinator, agent, person, phone) => {
    const batch = await coordinator.call(agent, 'batch_commands', { device: phone.id, commands: [{ tool: 'wait', arguments: { seconds: 0.3 } }, { tool: 'disconnect_device', arguments: {} }] });
    assert.ok(!batch.isError, JSON.stringify(batch).slice(0, 400));
  }],
]) test(`a disconnect is not undone by ${label}; a call started after it is`, async t => {
  const { screens } = await import('../src/stream/hub.mjs');
  const phone = await disconnectableHelper(t);
  const native = fakeNative();
  const deps = screens.deps;
  screens.deps = { ...deps, ...native, ffmpeg: async () => false };
  t.after(() => { screens.closeAll(); screens.deps = deps; });
  const coordinator = new Coordination();
  const agent = new Session(coordinator), person = new Session(coordinator);
  for (const session of [agent, person]) session.inventory = async () => [phone];
  screens.attach({ unavailable: id => coordinator.unavailable.get(id), activity: id => coordinator.lastActive(id), started: id => coordinator.lastStarted(id) });
  // The daemon-wide screens may remember an earlier test's disconnect of this id.
  screens.disconnected.delete(phone.id);
  t.after(() => screens.disconnected.delete(phone.id));
  const viewer = await screens.open(phone, { codecs: ['hevc'] });
  await overlapping(coordinator, agent, person, phone);
  assert.equal(viewer.closed, true);
  await assert.rejects(screens.open(phone, { codecs: ['hevc'] }), error => error.reason === 'device_disconnected', 'a remounted panel reopened the phone without the person asking');
  // The agent goes on using the phone: a panel may show it again.
  await coordinator.call(agent, 'wait', { device: phone.id, seconds: 0 });
  await screens.open(phone, { codecs: ['hevc'] });
});

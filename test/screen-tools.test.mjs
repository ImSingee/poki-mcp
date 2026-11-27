import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { Coordination } from '../src/coordination.mjs';
import { Session } from '../src/device.mjs';
import { Screens } from '../src/stream/hub.mjs';
import { nativeInput, screenInput, takeOver, INPUT_WAIT_MS } from '../src/stream/tools.mjs';
import { iceServers, packet, chunks, RTC_CHUNK_BYTES, MAGIC } from '../src/stream/rtc.mjs';
import { fakeNative } from './stream-fixture.mjs';

const target = { id: 'fixture-phone', kind: 'physical' };

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
  const taken = await takeOver(view, viewer);
  await work.catch(() => {});
  assert.equal(taken.structuredContent.taken_over, true);
  assert.equal(aborted?.stopReason, 'taken_over');
  assert.equal(coordinator.leases.get(target.id).owner, viewer.owner);
  // The agent is kept off, even though the view's calls may come on the agent's own session.
  assert.throws(() => coordinator.access(agent, target), /occupied/);
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
  assert.throws(() => iceServers({ POKI_TURN_URL: 'http://x' }), /must start with/);
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

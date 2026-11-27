// Transport A end to end in Node: a werift peer plays the view's browser against answer(), over
// loopback host candidates only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RTCPeerConnection } from 'werift';
import { Screens } from '../src/stream/hub.mjs';
import { answer, MAGIC } from '../src/stream/rtc.mjs';
import { sampleFrames, fakeNative } from './stream-fixture.mjs';

const target = { id: 'fixture-phone', kind: 'physical' };
const until = async (predicate, ms = 10000) => {
  const end = performance.now() + ms;
  while (!predicate()) { if (performance.now() > end) throw new Error('Timed out'); await delay(10); }
};

test('frames, acknowledgements and gestures cross a WebRTC peer; closing the viewer closes it', { timeout: 60000 }, async t => {
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: async () => false });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  const frames = sampleFrames();
  for (const frame of frames.slice(0, 3)) native.subscriptions[0].send(frame);

  const browser = new RTCPeerConnection({ iceServers: [] });
  t.after(() => browser.close());
  const media = browser.createDataChannel('media', { ordered: true });
  const control = browser.createDataChannel('control', { ordered: true });
  const packets = [], messages = [];
  let buffer, offset = 0;
  media.onMessage.subscribe(chunk => {
    const total = chunk.readUInt32BE(0), at = chunk.readUInt32BE(4);
    assert.equal(at, offset, 'a chunk arrived out of place');
    buffer ??= Buffer.alloc(total);
    chunk.copy(buffer, at, 8);
    offset += chunk.length - 8;
    if (offset === total) { packets.push(buffer); buffer = undefined; offset = 0; }
  });
  control.onMessage.subscribe(message => messages.push(JSON.parse(message)));
  await browser.setLocalDescription(await browser.createOffer());
  await until(() => browser.iceGatheringState === 'complete');
  const inputs = [];
  const { sdp } = await answer(viewer, browser.localDescription.sdp, { servers: [], onInput: async args => { inputs.push(args); return { sent: true }; } });
  await browser.setRemoteDescription({ type: 'answer', sdp });

  await until(() => messages.some(m => m.type === 'ready'));
  const ready = messages.find(m => m.type === 'ready');
  assert.equal(ready.codec, 'hevc');
  assert.equal(ready.codec_string, 'hvc1.1.6.L60.90');
  await until(() => packets.length === 3);
  const header = packet => ({ magic: packet.readUInt32BE(0), seq: packet.readUInt32BE(4), key: packet[8] === 2, config: packet.readUInt16BE(9) });
  assert.deepEqual(packets.map(p => header(p).seq), [1, 2, 3]);
  assert.equal(header(packets[0]).magic, MAGIC.hevc);
  assert.ok(header(packets[0]).key && header(packets[0]).config > 0);
  assert.deepEqual(packets[1].subarray(11), frames[1].data, 'a delta arrived changed');

  // New frames are pushed without a read; an acknowledgement returns credit.
  native.subscriptions[0].send(frames[3]);
  await until(() => packets.length === 4);
  control.send(JSON.stringify({ type: 'ack', seq: 4 }));
  await until(() => viewer.flow.acked === 4);

  // A gesture on the control channel goes through the same input path as screen_input.
  control.send(JSON.stringify({ type: 'input', id: 7, kind: 'tap', x: 0.5, y: 0.5 }));
  await until(() => messages.some(m => m.type === 'input-result' && m.id === 7));
  assert.deepEqual(inputs, [{ kind: 'tap', x: 0.5, y: 0.5 }]);

  // The view's panel closes: the peer goes, and with the last viewer the phone's subscription.
  viewer.close();
  await until(() => ['closed', 'disconnected', 'failed'].includes(browser.connectionState) || media.readyState === 'closed', 15000);
  assert.equal(native.subscriptions[0].open, false);
});

test('an offer without the two ordered channels is refused', { timeout: 30000 }, async t => {
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: async () => false });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  await assert.rejects(answer(viewer, 'x'.repeat(70000), { servers: [] }), /Invalid offer/);
  const browser = new RTCPeerConnection({ iceServers: [] });
  t.after(() => browser.close());
  browser.createDataChannel('media', { ordered: false });
  await browser.setLocalDescription(await browser.createOffer());
  await until(() => browser.iceGatheringState === 'complete');
  const { sdp } = await answer(viewer, browser.localDescription.sdp, { servers: [] });
  await browser.setRemoteDescription({ type: 'answer', sdp });
  // The unordered channel makes the answering side close the peer.
  await until(() => !viewer.rtc, 15000);
});

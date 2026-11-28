import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { describe, nalUnits } from '../src/stream/codec.mjs';
import { Screens } from '../src/stream/hub.mjs';
import { Flow, STALE_MS } from '../src/stream/flow.mjs';
import { Track } from '../src/stream/track.mjs';
import { ffmpegAvailable, JpegSplitter, Transcoder } from '../src/stream/transcode.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { sampleFrames, samplePath, fakeNative } from './stream-fixture.mjs';

const target = { id: 'fixture-phone', kind: 'physical' };
const noFfmpeg = async () => false;
const until = async (predicate, ms = 5000) => {
  const end = performance.now() + ms;
  while (!predicate()) { if (performance.now() > end) throw new Error('Timed out'); await delay(5); }
};

test('the codec string and size come from the SPS of each codec', () => {
  assert.deepEqual(describe('hevc', readFileSync(samplePath('hevc'))), { codec: 'hvc1.1.6.L60.90', width: 180, height: 390 });
  assert.deepEqual(describe('h264', readFileSync(samplePath('h264'))), { codec: 'avc1.42c00b', width: 180, height: 390 });
  // Four-byte and three-byte start codes both split cleanly.
  const units = nalUnits(Buffer.from([0, 0, 0, 1, 0x40, 1, 7, 0, 0, 1, 0x42, 1, 9]));
  assert.deepEqual(units.map(u => [...u]), [[0x40, 1, 7], [0x42, 1, 9]]);
});

test('one read returns a batch from the cached key frame, and the cursor moves on', async t => {
  const native = fakeNative();
  const screens = new Screens({ subscribe: native.subscribe, keyframe: native.keyframe, ffmpeg: noFfmpeg });
  t.after(() => screens.closeAll());
  const frames = sampleFrames();
  // Frames before anyone watches are not received; the phone keeps its own chain.
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  assert.equal(native.subscriptions.length, 1);
  for (const frame of frames.slice(0, 3)) native.subscriptions[0].send(frame);
  const first = await viewer.read({ wait_ms: 0 });
  assert.deepEqual(first.frames.map(f => [f.seq, f.key]), [[1, true], [2, false], [3, false]]);
  assert.equal(first.codec_string, 'hvc1.1.6.L60.90');
  assert.deepEqual([first.width, first.height], [180, 390]);
  assert.ok(first.frames[0].config);
  assert.deepEqual(Buffer.from(first.frames[1].data, 'base64'), frames[1].data);
  // Nothing new: the read waits, then returns empty.
  const before = performance.now();
  const empty = await viewer.read({ cursor: 3, wait_ms: 80 });
  assert.deepEqual(empty.frames, []);
  assert.ok(performance.now() - before >= 70, 'the long poll returned before wait_ms');
  // A frame arriving during a read ends it at once.
  const waiting = viewer.read({ cursor: 3, wait_ms: 1000 });
  await delay(20);
  native.subscriptions[0].send(frames[3]);
  assert.deepEqual((await waiting).frames.map(f => f.seq), [4]);
});

test('a read is bounded by credit, frame count and bytes, and acknowledgements return credit', async t => {
  t.after(() => { delete process.env.POKI_SCREEN_READ_MAX_FRAMES; delete process.env.POKI_SCREEN_READ_MAX_BYTES; });
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: noFfmpeg });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  const frames = sampleFrames();
  for (const frame of frames.slice(0, 4)) native.subscriptions[0].send(frame);
  assert.equal((await viewer.read({ credit: 2, wait_ms: 0 })).frames.length, 2);
  process.env.POKI_SCREEN_READ_MAX_FRAMES = '1';
  assert.deepEqual((await viewer.read({ ack: 2, wait_ms: 0 })).frames.map(f => f.seq), [3]);
  delete process.env.POKI_SCREEN_READ_MAX_FRAMES;
  // The byte limit stops a batch before a frame that would exceed it; a frame over the limit
  // still goes alone.
  for (const frame of frames.slice(4)) native.subscriptions[0].send(frame);
  // Frame 4 was replaced by the next key frame's chain before it was read: the viewer resumes at
  // that key frame. The byte limit stops a batch before a frame that would exceed it; a frame
  // over the limit still goes alone.
  process.env.POKI_SCREEN_READ_MAX_BYTES = String(16 * 1024);
  const batch = await viewer.read({ ack: 3, wait_ms: 0 });
  assert.deepEqual(batch.frames.map(f => f.seq), [5, 6, 7, 8]);
  assert.equal(batch.discontinuity, true);
  process.env.POKI_SCREEN_READ_MAX_BYTES = String(16 * 1024);
  native.subscriptions[0].send({ ...frames[4], seq: 9, data: Buffer.alloc(20 * 1024, 1) });
  native.subscriptions[0].send({ ...frames[5], seq: 10 });
  assert.deepEqual((await viewer.read({ ack: 8, wait_ms: 0 })).frames.map(f => f.seq), [9]);
  assert.deepEqual((await viewer.read({ ack: 9, wait_ms: 0 })).frames.map(f => f.seq), [10]);
  const snapshot = batch.flow;
  assert.equal(snapshot.sent, 8);
  assert.equal(snapshot.acked, 3);
});

test('a viewer that falls behind drops the chain and resumes at a key frame, asking for one at most once a second', async t => {
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: noFfmpeg });
  t.after(() => screens.closeAll());
  const frames = sampleFrames();
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  const send = frame => native.subscriptions[0].send(frame);
  send(frames[0]); send(frames[1]);
  assert.deepEqual((await viewer.read({ wait_ms: 0 })).frames.map(f => f.seq), [1, 2]);
  send(frames[2]); send(frames[3]);
  // The deltas become stale before the viewer asks for them.
  for (const frame of viewer.track.frames) frame.at -= STALE_MS + 100;
  const stale = await viewer.read({ ack: 2, wait_ms: 0 });
  // The only key frame is behind the viewer: nothing until a new one, and the phone was asked.
  assert.deepEqual(stale.frames, []);
  assert.equal(native.keyframes.length, 1);
  await viewer.read({ wait_ms: 0 });
  assert.equal(native.keyframes.length, 1, 'a second keyframe request within a second');
  send(frames[4]); send(frames[5]);
  const resumed = await viewer.read({ wait_ms: 0 });
  assert.deepEqual(resumed.frames.map(f => [f.seq, f.key]), [[5, true], [6, false]]);
  assert.equal(resumed.discontinuity, true);
});

test('a gap in the phone\'s numbering is never passed on inside a chain', () => {
  const track = new Track('hevc');
  const [key, delta1, , delta3] = sampleFrames();
  track.push({ ...key, at: 0 }); track.push({ ...delta1, at: 0 });
  // Frame 3 never arrived (the helper skipped it to a key frame for another reader).
  track.push({ ...delta3, at: 0 });
  assert.equal(track.since(2), undefined);
  const flow = new Flow();
  const taken = flow.take(track, 0, { maxBytes: 1 << 20, maxFrames: 16 });
  assert.deepEqual(taken.frames, [], 'frames after a gap were sent');
  assert.equal(taken.recover, true);
});

test('a JPEG track keeps only the latest picture, and a JPEG viewer gets only the newest one', () => {
  const track = new Track('jpeg', { latestOnly: true });
  const flow = new Flow({ latestOnly: true });
  for (let seq = 1; seq <= 5; seq++) track.push({ seq, key: true, data: Buffer.from([seq]), at: 0 });
  assert.equal(track.frames.length, 1);
  assert.deepEqual(flow.take(track, 0, { maxBytes: 1 << 20, maxFrames: 16 }).frames.map(f => f.seq), [5]);
  track.push({ seq: 6, key: true, data: Buffer.from([6]), at: 0 });
  track.push({ seq: 7, key: true, data: Buffer.from([7]), at: 0 });
  assert.deepEqual(flow.take(track, 0, { maxBytes: 1 << 20, maxFrames: 16 }).frames.map(f => f.seq), [7]);
  // Two pictures unacknowledged: the next waits for an acknowledgement.
  track.push({ seq: 8, key: true, data: Buffer.from([8]), at: 0 });
  assert.deepEqual(flow.take(track, 0, { maxBytes: 1 << 20, maxFrames: 16 }).frames, []);
  flow.acknowledge(7, 10);
  assert.deepEqual(flow.take(track, 10, { maxBytes: 1 << 20, maxFrames: 16 }).frames.map(f => f.seq), [8]);
  const pictures = [];
  const splitter = new JpegSplitter(unit => pictures.push(unit.data.length));
  splitter.push(Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0x00, 0xff, 0xd9, 0xff, 0xd8, 3]));
  splitter.push(Buffer.from([0xff, 0xd9]));
  assert.deepEqual(pictures, [8, 5]);
});

test('an unrenewed viewer is closed after its lease, which ends the phone\'s subscription', async t => {
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: noFfmpeg, ttlMs: 200 });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  const kept = await screens.open(target, { codecs: ['hevc'] });
  assert.equal(native.subscriptions.length, 1, 'two viewers of one phone subscribed twice');
  // One viewer keeps reading; the other is abandoned.
  const end = performance.now() + 500;
  while (performance.now() < end) await kept.read({ wait_ms: 50 });
  assert.equal(viewer.closed, true);
  assert.equal(native.subscriptions[0].open, true, 'the subscription ended while a viewer still read');
  await until(() => kept.closed);
  assert.equal(native.subscriptions[0].open, false, 'the last viewer\'s lease ran out but the phone stayed subscribed');
  assert.equal(screens.active, 0);
  await assert.rejects(async () => screens.get(viewer.id), /ended/);
});

test('a phone without the display service refuses the stream and keeps no viewer', async () => {
  const native = fakeNative({ fail: 'no display service: ServiceNotFound' });
  const screens = new Screens({ ...native, ffmpeg: noFfmpeg });
  await assert.rejects(screens.open(target, { codecs: ['hevc'] }), /no display service/);
  assert.equal(screens.active, 0);
  assert.equal(screens.hubs.size, 0);
});

test('a dropped native subscription is reopened while viewers remain, with a gap before its frames', async t => {
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: noFfmpeg });
  t.after(() => screens.closeAll());
  const frames = sampleFrames();
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  native.subscriptions[0].send(frames[0]); native.subscriptions[0].send(frames[1]);
  await viewer.read({ wait_ms: 0 });
  native.subscriptions[0].end();
  await until(() => native.subscriptions.length === 2, 3000);
  // The helper restarted: its numbering starts again at 1.
  native.subscriptions[1].send({ ...frames[1], seq: 1 });
  native.subscriptions[1].send({ ...frames[4], seq: 2 });
  const after = await viewer.read({ wait_ms: 0 });
  assert.equal(after.frames[0].key, true, 'a delta after the reconnect reached the viewer');
  assert.ok(after.frames[0].seq > 2);
});

test('the H.264 track is transcoded only while it has a viewer, and its encoder is reaped', { skip: !(await ffmpegAvailable()) && 'ffmpeg with libx264 is not installed' }, async t => {
  const native = fakeNative();
  const children = [];
  const spawnSpy = (...args) => { const child = spawn(...args); children.push(child); return child; };
  const screens = new Screens({ ...native, spawn: spawnSpy });
  t.after(() => screens.closeAll());
  const frames = sampleFrames();
  const hevc = await screens.open(target, { codecs: ['hevc'] });
  for (const frame of frames.slice(0, 4)) native.subscriptions[0].send(frame);
  assert.equal(children.length, 0, 'an encoder ran with no H.264 viewer');
  const asked = native.keyframes.length;
  const viewer = await screens.open(target, { codecs: ['h264'] });
  assert.equal(children.length, 1);
  // The encoder starts at the newest cached key frame alone, so the still screen gets a picture,
  // and the frames cached after it are not replayed as new pictures: the phone is asked for a key
  // frame to go on from.
  let received = [];
  const read = async (count, ms) => { const end = performance.now() + ms; while (received.length < count && performance.now() < end) received.push(...(await viewer.read({ ack: received.at(-1)?.seq, wait_ms: 500 })).frames); };
  await read(1, 10000);
  assert.equal(received[0]?.key, true, 'no picture from the cached key frame');
  await read(2, 1500);
  assert.equal(received.length, 1, `the cached chain was replayed: ${received.length} pictures from one key frame and three deltas`);
  assert.ok(native.keyframes.length > asked, 'the phone was not asked for a key frame to go on from');
  // The phone's next key frame and the frames after it come through.
  for (const frame of frames.slice(4)) native.subscriptions[0].send(frame);
  await read(5, 10000);
  assert.equal(received.length, 5, `${received.length} pictures after the phone's key frame`);
  assert.equal(received[1].key, true);
  const info = describe('h264', Buffer.from(received[0].config, 'base64'));
  assert.match(info.codec, /^avc1\.42/);
  assert.deepEqual([info.width, info.height], [180, 390]);
  assert.equal(children.length, 1, 'the encoder was restarted for a new viewer');
  const exited = Promise.all(children.map(child => child.exitCode !== null || child.signalCode ? undefined : new Promise(resolve => child.once('exit', resolve))));
  viewer.close();
  await exited;
  assert.equal(native.subscriptions[0].open, true, 'the HEVC viewer lost its subscription');
  hevc.close();
  assert.equal(native.subscriptions[0].open, false);
});

test('the JPEG track keeps only the latest picture, and a still screen\'s picture comes out', { skip: !(await ffmpegAvailable()) && 'ffmpeg with libx264 and mjpeg is not installed' }, async t => {
  const native = fakeNative();
  const screens = new Screens(native);
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['jpeg'] });
  assert.equal(viewer.codec, 'jpeg');
  // A still screen: one key frame and nothing after it (the phone sends frames only on change).
  // ffmpeg's fps filter held such a picture back for good.
  const frames = sampleFrames();
  native.subscriptions[0].send(frames[0]);
  const read = async () => { const end = performance.now() + 10000; let picture; while (!picture && performance.now() < end) picture = (await viewer.read({ ack: viewer.flow.sent, wait_ms: 500 })).frames[0]; return picture; };
  const still = await read();
  assert.ok(still, 'a still screen\'s picture never came out');
  assert.deepEqual([...Buffer.from(still.data, 'base64').subarray(0, 2)], [0xff, 0xd8]);
  // A burst arriving at once (the cached frames, a busy machine): the last picture comes out too.
  for (const frame of frames.slice(1)) native.subscriptions[0].send(frame);
  await until(() => viewer.track.latest >= 8, 10000).catch(() => {});
  assert.equal(viewer.track.latest, 8, `${viewer.track.latest} of 8 pictures came out of the encoder`);
  assert.ok(viewer.track.frames.length <= 1);
});


test('a device takes at most eight viewers', async t => {
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: noFfmpeg });
  t.after(() => screens.closeAll());
  const viewers = [];
  for (let i = 0; i < 8; i++) viewers.push(await screens.open(target, { codecs: ['hevc'] }));
  await assert.rejects(screens.open(target, { codecs: ['hevc'] }), /already has 8 screen viewers/);
  viewers[0].close();
  await screens.open(target, { codecs: ['hevc'] });
  assert.equal(native.subscriptions.length, 1);
});

test('frames that arrive before the subscription resolves keep their chain', async t => {
  const frames = sampleFrames();
  let deliver;
  const screens = new Screens({
    ffmpeg: noFfmpeg, keyframe: async () => ({}),
    // The helper's reply and its first frames came in one chunk: the frames are delivered first.
    subscribe: async (target, onFrame) => { deliver = onFrame; onFrame(frames[0]); onFrame(frames[1]); return { reply: { subscribed: true }, closed: new Promise(() => {}), close() {} }; },
  });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  deliver(frames[2]);
  const read = await viewer.read({ wait_ms: 0 });
  assert.deepEqual(read.frames.map(f => [f.seq, f.key]), [[1, true], [2, false], [3, false]], 'a delta after the reply broke the cached chain');
});

test('a resync gives back the credit of frames a lost transport never delivered', () => {
  const track = new Track('hevc');
  const flow = new Flow();
  const limits = { maxBytes: 64 * 1024 * 1024, maxFrames: 64 };
  const [key, delta] = sampleFrames();
  track.push({ ...key, seq: 1, at: 0 });
  for (let seq = 2; seq <= 60; seq++) track.push({ ...delta, seq, at: 0 });
  let sent = 0;
  for (let i = 0; i < 10; i++) sent += flow.take(track, 0, { credit: 64, ...limits }).frames.length;
  assert.equal(sent, 48, 'the window holds 48 unacknowledged frames');
  // The peer that carried them is gone; the view asks again over tool calls.
  flow.resync();
  track.push({ ...key, seq: 61, at: 0 });
  assert.deepEqual(flow.take(track, 0, { credit: 64, ...limits }).frames.map(f => [f.seq, f.key]), [[61, true]]);
});

test('a restarted encoder\'s late output never reaches the new chain', () => {
  const children = [];
  const spawnFake = () => { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} }); children.push(child); return child; };
  const pictures = [];
  const transcoder = new Transcoder('jpeg', { spawn: spawnFake, onFrame: frame => pictures.push(frame.data[2]) });
  const [key] = sampleFrames();
  transcoder.write({ ...key, pts_us: 1 });
  transcoder.restart();
  transcoder.write({ ...key, pts_us: 2 });
  assert.equal(children.length, 2);
  // The new encoder's picture, then the terminated one's picture that was still in its pipe.
  children[1].stdout.emit('data', Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]));
  children[0].stdout.emit('data', Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
  assert.deepEqual(pictures, [2]);
  transcoder.close();
});

test('a stream that takes longer to open than the viewer lease still opens', async t => {
  const native = fakeNative();
  const slow = { ...native, subscribe: async (...args) => { await delay(500); return native.subscribe(...args); } };
  const screens = new Screens({ ...slow, ffmpeg: noFfmpeg, ttlMs: 200 });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['hevc'] });
  assert.equal(viewer.closed, undefined, 'screen_open returned a stream that had already expired');
  assert.equal(screens.active, 1);
  native.subscriptions[0].send(sampleFrames()[0]);
  assert.equal((await viewer.read({ wait_ms: 0 })).frames.length, 1);
});

test('an encoder that exits on its own is restarted on the cached chain', async t => {
  const native = fakeNative();
  const children = [];
  const spawnFake = () => {
    const stdin = new PassThrough(), child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin, kill() {}, written: 0 });
    stdin.on('data', () => { child.written++; });
    children.push(child); return child;
  };
  const screens = new Screens({ ...native, spawn: spawnFake, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  const [key, delta] = sampleFrames();
  native.subscriptions[0].send(key); native.subscriptions[0].send({ ...delta, seq: 2 });
  await screens.open(target, { codecs: ['jpeg'] });
  assert.equal(children.length, 1);
  await until(() => children[0].written > 0);
  // ffmpeg dies; the screen stays still, so no new key frame comes from the phone.
  children[0].emit('close', 1);
  await until(() => children.length === 2 && children[1].written > 0, 3000);
});

test('an encoder that keeps failing tells its viewers, and the codec is not offered again', async t => {
  const native = fakeNative();
  const children = [];
  const spawnFake = () => { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} }); children.push(child); return child; };
  const screens = new Screens({ ...native, spawn: spawnFake, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  native.subscriptions[0].send(sampleFrames()[0]);
  const viewer = await screens.open(target, { codecs: ['jpeg', 'hevc'] });
  assert.equal(viewer.codec, 'jpeg');
  for (let exit = 0; exit < 4; exit++) {
    await until(() => children.length === exit + 1, 3000);
    children[exit].emit('close', 1);
  }
  const read = await viewer.read({ wait_ms: 500 });
  assert.equal(read.codec_failed, true, JSON.stringify(read));
  assert.match(read.error, /keeps stopping/);
  assert.equal((await screens.open(target, { codecs: ['jpeg', 'hevc'] })).codec, 'hevc');
});

test('a restarted encoder with no cached chain asks the phone for a key frame', async t => {
  const native = fakeNative();
  const spawnFake = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
  const screens = new Screens({ ...native, spawn: spawnFake, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  const [key, delta] = sampleFrames();
  native.subscriptions[0].send(key);
  // A long still-screen chain outgrows the cache: nothing is left to start an encoder on.
  for (let seq = 2; seq <= 905; seq++) native.subscriptions[0].send({ ...delta, seq });
  const before = native.keyframes.length;
  await screens.open(target, { codecs: ['jpeg'] });
  assert.equal(native.keyframes.length, before + 1, 'the new encoder got no chain and no key frame was asked for');
});

test('H.264 from ffmpeg is cut into whole pictures however its pipe pauses', { skip: !(await ffmpegAvailable()) && 'ffmpeg with libx264 is not installed' }, async () => {
  const { FlvSplitter, ffmpegArgs } = await import('../src/stream/transcode.mjs');
  const { execFileSync } = await import('node:child_process');
  // The transcoder's own arguments, on the whole sample at once.
  const flv = execFileSync('ffmpeg', ffmpegArgs('h264'), { input: readFileSync(samplePath('hevc')), maxBuffer: 1 << 24 });
  const whole = [], split = [];
  new FlvSplitter(unit => whole.push(unit)).push(flv);
  assert.equal(whole.length, 8);
  assert.equal(whole[0].key, true);
  assert.deepEqual(describe('h264', whole[0].config), { codec: describe('h264', whole[0].data).codec, width: 180, height: 390 });
  // The same bytes in uneven pieces with pauses: the same pictures, none cut short.
  const splitter = new FlvSplitter(unit => split.push(unit));
  for (let at = 0; at < flv.length; at += 997) { splitter.push(flv.subarray(at, at + 997)); await delay(20); }
  assert.deepEqual(split.map(u => u.data.length), whole.map(u => u.data.length));
});

test('input dropped behind a backed-up encoder asks the phone for a key frame', async t => {
  const native = fakeNative();
  // An encoder that never reads its input.
  const spawnFake = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough({ highWaterMark: 1024 }), kill() {} });
  const screens = new Screens({ ...native, spawn: spawnFake, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  const [key] = sampleFrames();
  native.subscriptions[0].send(key);
  await screens.open(target, { codecs: ['jpeg'] });
  const before = native.keyframes.length;
  for (let seq = 2; seq <= 4; seq++) native.subscriptions[0].send({ ...key, seq, key: false, data: Buffer.alloc(2 * 1024 * 1024, 1) });
  assert.equal(native.keyframes.length, before + 1, 'the encoder dropped input and nobody asked for a key frame to resume on');
});

// An encoder that reads nothing until the test drains it; every write is recorded.
function stalledEncoder() {
  const encoder = { writes: [] };
  encoder.spawn = () => {
    encoder.stdin = new PassThrough({ highWaterMark: 1024 });
    const write = encoder.stdin.write.bind(encoder.stdin);
    encoder.stdin.write = chunk => { encoder.writes.push(chunk.length); return write(chunk); };
    return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: encoder.stdin, kill() {} });
  };
  return encoder;
}
async function backedUp(t, encoder) {
  const native = fakeNative();
  const screens = new Screens({ ...native, spawn: encoder.spawn, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  const [key] = sampleFrames();
  native.subscriptions[0].send(key);
  await screens.open(target, { codecs: ['jpeg'] });
  for (let seq = 2; seq <= 4; seq++) native.subscriptions[0].send({ ...key, seq, key: false, data: Buffer.alloc(2 * 1024 * 1024, 1) });
  assert.equal(native.keyframes.length, 1);
  // The key frame the phone sends in answer arrives while the encoder is still backed up.
  native.subscriptions[0].send({ ...key, seq: 5 });
  return { native, key };
}

test('an encoder that caught up on a still screen resumes at the cached key frame the phone sent meanwhile', async t => {
  const encoder = stalledEncoder();
  const { key } = await backedUp(t, encoder);
  encoder.writes.length = 0;
  // The encoder takes its input; nothing new comes from the (still) phone.
  encoder.stdin.resume();
  await until(() => encoder.writes.length > 0, 2000);
  assert.ok(encoder.writes.includes(key.data.length), 'the encoder was not given the cached key frame');
});

test('an encoder that caught up on a moving screen waits for a new key frame instead of replaying the cached chain', async t => {
  const encoder = stalledEncoder();
  const { native, key } = await backedUp(t, encoder);
  native.subscriptions[0].send({ ...key, seq: 6, key: false, data: Buffer.alloc(100, 2) });
  encoder.writes.length = 0;
  encoder.stdin.resume();
  // The phone is asked again (the earlier request's answer was dropped) ...
  await until(() => native.keyframes.length >= 2, 2500);
  assert.deepEqual(encoder.writes, [], 'the cached key frame and the frames after it were replayed');
  // ... and its next key frame starts the encoder again.
  native.subscriptions[0].send({ ...key, seq: 7 });
  assert.ok(encoder.writes.includes(key.data.length), 'the new key frame was not fed');
  native.subscriptions[0].send({ ...key, seq: 8, key: false, data: Buffer.alloc(100, 3) });
  assert.ok(encoder.writes.includes(100), 'the frames after it were not fed');
});


test('a request for a key frame within a second of the last one is deferred, not dropped', async t => {
  const native = fakeNative();
  const spawnFake = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough({ highWaterMark: 1024 }), kill() {} });
  const screens = new Screens({ ...native, spawn: spawnFake, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  const [key] = sampleFrames();
  native.subscriptions[0].send(key);
  await screens.open(target, { codecs: ['jpeg'] });
  for (let seq = 2; seq <= 4; seq++) native.subscriptions[0].send({ ...key, seq, key: false, data: Buffer.alloc(2 * 1024 * 1024, 1) });
  assert.equal(native.keyframes.length, 1);
  // The key frame that answered it is dropped too: a second request follows a second later.
  native.subscriptions[0].send({ ...key, seq: 5 });
  await until(() => native.keyframes.length === 2, 2500);
  assert.ok(native.keyframes[1].at - native.keyframes[0].at >= 990);
});

test('cancelling one of two screens opening during a cold start leaves the other to open', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const native = fakeNative();
  const subscribe = async (device, onFrame, { signal } = {}) => {
    await Promise.race([ready, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    return native.subscribe(device, onFrame);
  };
  const screens = new Screens({ ...native, subscribe, ffmpeg: async () => false });
  t.after(() => screens.closeAll());
  const first = new AbortController(), second = new AbortController();
  const opening = [screens.open(target, { codecs: ['hevc'], signal: first.signal }), screens.open(target, { codecs: ['hevc'], signal: second.signal })];
  await delay(20);
  first.abort(new DOMException('Request cancelled', 'AbortError'));
  await assert.rejects(opening[0], /cancelled/);
  started();
  const viewer = await opening[1];
  assert.ok(!viewer.closed, 'the second panel was closed with the first');
  assert.equal(native.subscriptions.length, 1);
  assert.equal(native.subscriptions[0].open, true);
  // With every opening caller cancelled, the attempt itself ends.
  viewer.close();
  let aborted = false;
  const lone = new AbortController();
  const stalled = new Screens({ ...native, subscribe: async (device, onFrame, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })), ffmpeg: async () => false });
  const pending = stalled.open(target, { codecs: ['hevc'], signal: lone.signal });
  await delay(20);
  lone.abort(new DOMException('Request cancelled', 'AbortError'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(aborted, true, 'a subscription nobody waits for went on');
});

test('a resync sends the latest JPEG again when its reply was lost and nothing newer came', () => {
  const track = new Track('jpeg', { latestOnly: true });
  const flow = new Flow({ latestOnly: true });
  track.push({ seq: 1, key: true, data: Buffer.alloc(10), at: 0 });
  assert.deepEqual(flow.take(track, 0, { credit: 2 }).frames.map(f => f.seq), [1]);
  // The reply carrying picture 1 never reached the view, and the screen is still.
  assert.deepEqual(flow.take(track, 10, { credit: 2 }).frames, []);
  flow.resync();
  const again = flow.take(track, 20, { credit: 2 });
  assert.deepEqual(again.frames.map(f => f.seq), [1], 'the only picture was never sent again');
  assert.equal(again.discontinuity, true);
  // Once sent again, it is not repeated.
  assert.deepEqual(flow.take(track, 30, { credit: 2 }).frames, []);
});

test('a screen_open cancelled before its cold start begins starts nothing and leaves no rejection unobserved', async t => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  let subscribed = 0;
  const subscribe = (device, onFrame, { signal } = {}) => { subscribed++; return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const screens = new Screens({ ...fakeNative(), subscribe, ffmpeg: async () => false });
  t.after(() => screens.closeAll());
  const controller = new AbortController();
  controller.abort(new DOMException('Request cancelled', 'AbortError'));
  await assert.rejects(screens.open(target, { codecs: ['hevc'], signal: controller.signal }), /cancelled/);
  await delay(50);
  assert.equal(subscribed, 0, 'a cancelled open started the phone\'s stream');
  assert.deepEqual(unhandled, [], 'a rejected startup nobody awaited would end the daemon');
});

test('an encoder that keeps failing is closed, so the frames that keep coming start no more ffmpeg', async t => {
  const native = fakeNative();
  let spawned = 0;
  // An ffmpeg that exits at once.
  const spawnDead = () => { spawned++; const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} }); setImmediate(() => child.emit('close', 1)); return child; };
  const screens = new Screens({ ...native, spawn: spawnDead, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['jpeg'] });
  const frames = sampleFrames();
  let seq = 0;
  // Each exit restarts it on the next key frame, until it is given up.
  const end = performance.now() + 10000;
  while (!viewer.hub.failed.has('jpeg') && performance.now() < end) { native.subscriptions[0].send({ ...frames[0], seq: ++seq }); await delay(100); }
  assert.ok(viewer.hub.failed.has('jpeg'), 'the failing encoder was never given up');
  const before = spawned;
  for (let i = 0; i < 5; i++) { native.subscriptions[0].send({ ...frames[0], seq: ++seq }); await delay(20); }
  assert.equal(spawned, before, `${spawned - before} more ffmpeg processes started for a failed encoder`);
});

test('an ffmpeg without libx264 still serves JPEG', async t => {
  const screens = new Screens({ ...fakeNative(), ffmpeg: async () => ['jpeg'] });
  t.after(() => screens.closeAll());
  assert.deepEqual(await screens.codecs(), ['hevc', 'jpeg']);
  const viewer = await screens.open(target, { codecs: ['h264', 'jpeg'] });
  assert.equal(viewer.codec, 'jpeg');
  await assert.rejects(screens.open(target, { codecs: ['h264'] }), /serves hevc and jpeg: H\.264 needs ffmpeg with libx264/);
});

test('a dropped subscription is not taken again while the device is unavailable', async t => {
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: async () => false });
  let unavailable = 'fixture-phone is being paired again.';
  screens.attach({ unavailable: () => unavailable, activity: () => 0 });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  native.subscriptions[0].end();
  await delay(2500);
  assert.equal(native.subscriptions.length, 1, 'a subscription was taken while the phone was being paired again');
  unavailable = undefined;
  await until(() => native.subscriptions.length === 2, 8000);
});

test('an idle stream is paused, unless a tool is using the device', async t => {
  process.env.POKI_SCREEN_IDLE_MINUTES = String(300 / 60000);
  t.after(() => { delete process.env.POKI_SCREEN_IDLE_MINUTES; });
  const native = fakeNative();
  const screens = new Screens({ ...native, ffmpeg: async () => false, ttlMs: 60000 });
  let active = 0;
  screens.attach({ unavailable: () => undefined, activity: () => active });
  t.after(() => screens.closeAll());
  const watched = await screens.open(target, { codecs: ['hevc'] });
  // The agent keeps working on the phone: the panel watching it stays.
  const working = setInterval(() => { active = performance.now(); }, 50);
  await delay(1200);
  clearInterval(working);
  assert.ok(!watched.closed, 'a panel watching the agent work was paused');
  await until(() => watched.closed, 3000);
  assert.equal(watched.ended?.reason, 'idle');
  assert.equal(native.subscriptions[0].open, false, 'the paused stream kept the phone\'s camera and microphone');
});

test('a device disconnected on purpose opens again only with reconnect, or once a tool used it since', async t => {
  const screens = new Screens({ ...fakeNative(), ffmpeg: async () => false });
  let active = 0;
  screens.attach({ unavailable: () => undefined, activity: () => active });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  screens.closeDevice(target.id);
  await assert.rejects(screens.open(target, { codecs: ['hevc'] }), error => error.reason === 'device_disconnected');
  const viewer = await screens.open(target, { codecs: ['hevc'], reconnect: true });
  viewer.close();
  screens.closeDevice(target.id);
  await delay(5);
  active = performance.now();
  await screens.open(target, { codecs: ['hevc'] });
});

test('a disconnect while a screen is still checking its codecs is not undone when the check ends', async t => {
  const native = fakeNative();
  let probed;
  const probe = new Promise(resolve => { probed = resolve; });
  const screens = new Screens({ ...native, ffmpeg: () => probe });
  t.after(() => screens.closeAll());
  const opening = screens.open(target, { codecs: ['hevc', 'jpeg'] });
  await delay(10);
  screens.closeDevice(target.id);
  probed(true);
  await assert.rejects(opening, error => error.reason === 'device_disconnected');
  assert.equal(native.subscriptions.length, 0, 'the opening subscribed a phone disconnected meanwhile');
  assert.equal(screens.active, 0);
});

test('JPEG over tool calls goes at most POKI_SCREEN_JPEG_FPS pictures a second, and the newest always goes', async t => {
  const native = fakeNative();
  // An encoder that never outputs: the test puts the pictures on the track itself.
  const spawnQuiet = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough().resume(), kill() {} });
  const screens = new Screens({ ...native, spawn: spawnQuiet, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['jpeg'] });
  const track = viewer.hub.track('jpeg');
  let seq = 0, running = true;
  // The phone moves: 60 pictures a second for a second and a half.
  const feeding = (async () => { const end = performance.now() + 1500; while (performance.now() < end) { track.push({ seq: ++seq, key: true, data: Buffer.from([0xff, 0xd8, seq & 0xff, 0xff, 0xd9]), at: performance.now() }); await delay(16); } running = false; })();
  const got = [];
  while (running) got.push(...(await viewer.read({ ack: got.at(-1), wait_ms: 1000 })).frames.map(f => f.seq));
  await feeding;
  assert.ok(got.length <= 17, `${got.length} pictures in 1.5 s over tool calls`);
  // The screen is still now: its last picture comes within the interval, if it has not yet.
  const tail = got.at(-1) === seq ? [] : (await viewer.read({ ack: got.at(-1), wait_ms: 1000 })).frames.map(f => f.seq);
  assert.equal([...got, ...tail].at(-1), seq, 'the still screen\'s newest picture did not come');
});

test('an encoder waiting for the phone\'s key frame asks again, and at last starts on the cached chain', { timeout: 20000 }, async t => {
  const native = fakeNative();
  let asks = 0;
  // The phone never answers, and its requests fail.
  const keyframe = async () => { asks++; throw new Error('helper busy'); };
  const writes = [];
  const spawnRecorder = () => { const stdin = new PassThrough().resume(); const write = stdin.write.bind(stdin); stdin.write = chunk => { writes.push(chunk.length); return write(chunk); }; return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin, kill() {} }); };
  const screens = new Screens({ ...native, keyframe, spawn: spawnRecorder, ffmpeg: async () => true });
  t.after(() => screens.closeAll());
  await screens.open(target, { codecs: ['hevc'] });
  const [key, delta] = sampleFrames();
  native.subscriptions[0].send(key); native.subscriptions[0].send(delta);
  await screens.open(target, { codecs: ['h264'] });
  // A viewer with no picture yet gets the key frame alone, and the phone is asked for a new one.
  assert.deepEqual(writes.filter(n => n > 7), [key.data.length]);
  await until(() => asks >= 3, 8000);
  // After the last unanswered request the cached chain goes in once.
  await until(() => writes.filter(n => n > 7).length >= 3, 4000);
  assert.deepEqual(writes.filter(n => n > 7).slice(1), [key.data.length, delta.data.length]);
});

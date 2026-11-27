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
  const viewer = await screens.open(target, { codecs: ['h264'] });
  assert.equal(children.length, 1);
  // The encoder starts on the cached HEVC chain, so the still screen still gets a picture.
  let received = [];
  const end = performance.now() + 10000;
  while (received.length < 4 && performance.now() < end) received.push(...(await viewer.read({ ack: received.at(-1)?.seq, wait_ms: 500 })).frames);
  assert.ok(received.length >= 4, `only ${received.length} transcoded frames`);
  assert.equal(received[0].key, true);
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

test('the JPEG track transcodes at most ten pictures a second and keeps only the latest', { skip: !(await ffmpegAvailable()) && 'ffmpeg with libx264 and mjpeg is not installed' }, async t => {
  const native = fakeNative();
  const screens = new Screens(native);
  t.after(() => screens.closeAll());
  const viewer = await screens.open(target, { codecs: ['jpeg'] });
  assert.equal(viewer.codec, 'jpeg');
  const frames = sampleFrames();
  for (const [index, frame] of frames.entries()) { native.subscriptions[0].send(frame); if (index < frames.length - 1) await delay(40); }
  let picture;
  const end = performance.now() + 10000;
  while (!picture && performance.now() < end) picture = (await viewer.read({ wait_ms: 500 })).frames[0];
  assert.ok(picture, 'no JPEG came out');
  const data = Buffer.from(picture.data, 'base64');
  assert.deepEqual([...data.subarray(0, 2)], [0xff, 0xd8]);
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

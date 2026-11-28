// Transcodes the phone's HEVC for viewers that cannot decode it, or that need fewer bytes:
// H.264 (libx264 ultrafast, zerolatency, long edge at most 1280) or JPEG (only the latest picture
// kept). An encoder runs only while a viewer needs its track, and starts
// on an HEVC key frame. Restarting it (a new bitrate, a keyframe request) starts a new chain with
// a key frame.
import { spawn as spawnProcess, execFile } from 'node:child_process';
import { avcType } from './codec.mjs';

let encoders;
// The tracks the ffmpeg on PATH can transcode to: h264 with libx264, jpeg with mjpeg. Checked once.
// Each is offered on its own, so an ffmpeg without libx264 still serves JPEG.
export function ffmpegCodecs() {
  encoders ??= new Promise(resolve => {
    execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 5000 }, (error, stdout) => {
      resolve(error ? [] : [...(/libx264/.test(stdout) ? ['h264'] : []), ...(/mjpeg/.test(stdout) ? ['jpeg'] : [])]);
    });
  });
  return encoders;
}
// Whether ffmpeg can transcode to both H.264 and JPEG.
export const ffmpegAvailable = async () => (await ffmpegCodecs()).length === 2;

const scale = edge => `scale='trunc(min(iw\\,${edge}*iw/max(iw\\,ih))/2)*2':'trunc(min(ih\\,${edge}*ih/max(iw\\,ih))/2)*2'`;

export function ffmpegArgs(mode, { bitrate = 1_500_000, maxEdge = 1280, quality = 5 } = {}) {
  // Measured with the sample stream: `-fflags nobuffer` loses the first key frame, and without the
  // small probe ffmpeg waits for megabytes before decoding anything.
  const input = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0', '-use_wallclock_as_timestamps', '1', '-f', 'hevc', '-i', 'pipe:0', '-an'];
  if (mode === 'h264') {
    const kbps = Math.round(bitrate / 1000);
    // A key frame from the phone is a key frame out: asking the phone for one is enough to give a
    // viewer a new chain, with no encoder restart.
    return [...input, '-vf', scale(maxEdge), '-fps_mode', 'passthrough', '-force_key_frames', 'source', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '240',
      '-x264-params', 'scenecut=0', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${Math.max(100, Math.round(kbps / 2))}k`, '-flush_packets', '1', '-flvflags', 'no_duration_filesize', '-f', 'flv', 'pipe:1'];
  }
  // Every picture is encoded: ffmpeg's fps filter holds a picture until a later one arrives, so a
  // still screen's latest picture would never come out. The track keeps only the latest, and the
  // flow sends at most what the viewer has credit for.
  // Pictures that arrive together can share a wall-clock time, which the encoder refuses, and each
  // JPEG stands alone: they are numbered instead. One encoding thread holds back no picture.
  if (mode === 'jpeg') return [...input, '-vf', `setpts=N/TB,${scale(maxEdge)}`, '-fps_mode', 'passthrough', '-c:v', 'mjpeg', '-threads', '1', '-q:v', String(quality), '-flush_packets', '1', '-f', 'mjpeg', 'pipe:1'];
  throw new Error(`Unknown transcode mode ${mode}`);
}

// Splits ffmpeg's H.264 output, muxed as FLV, into access units. Each FLV video tag carries
// exactly one picture and says how long it is, so a pause in the pipe can never cut a picture in
// two (raw Annex-B output has no end-of-picture mark until the next picture begins). The AVCC
// payload is rewritten to Annex-B, and the sequence header's SPS and PPS go with every key frame.
export class FlvSplitter {
  buffer = Buffer.alloc(0); header = false; config;
  constructor(onUnit) { this.onUnit = onUnit; }
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (!this.header) {
      if (this.buffer.length < 9) return;
      if (this.buffer.toString('latin1', 0, 3) !== 'FLV') throw new Error('Not an FLV stream');
      const size = this.buffer.readUInt32BE(5);
      if (this.buffer.length < size + 4) return;
      this.buffer = this.buffer.subarray(size + 4);
      this.header = true;
    }
    while (this.buffer.length >= 11) {
      const type = this.buffer[0], size = this.buffer.readUIntBE(1, 3);
      if (this.buffer.length < 11 + size + 4) return;
      const data = this.buffer.subarray(11, 11 + size);
      this.buffer = this.buffer.subarray(11 + size + 4);
      if (type === 9 && data.length >= 5 && (data[0] & 0x0f) === 7) this.video(data);
    }
  }
  video(data) {
    const key = data[0] >> 4 === 1, packetType = data[1], payload = data.subarray(5);
    if (packetType === 0) { this.config = avcConfig(payload); return; }
    if (packetType !== 1) return;
    const nals = [];
    for (let at = 0; at + 4 <= payload.length;) {
      const length = payload.readUInt32BE(at);
      if (at + 4 + length > payload.length) break;
      nals.push(payload.subarray(at + 4, at + 4 + length));
      at += 4 + length;
    }
    if (!nals.length) return;
    const isKey = key || nals.some(nal => avcType(nal) === 5);
    const config = isKey ? this.config : undefined;
    if (isKey && !config) return; // a key frame without parameter sets cannot start a decoder
    const picture = annexb(nals);
    this.onUnit({ key: isKey, config, data: isKey && !nals.some(nal => avcType(nal) === 7) ? Buffer.concat([config, picture]) : picture });
  }
  close() {}
}

// The SPS and PPS of an AVCDecoderConfigurationRecord (version, profile, compatibility, level,
// length size, then the SPS count with each SPS, then the PPS count with each PPS), as Annex-B.
function avcConfig(record) {
  const nals = [];
  let at = 5;
  for (const count of [record[at++] & 0x1f, null]) {
    const n = count ?? record[at++];
    for (let i = 0; i < n && at + 2 <= record.length; i++) {
      const length = record.readUInt16BE(at);
      nals.push(record.subarray(at + 2, at + 2 + length));
      at += 2 + length;
    }
  }
  return annexb(nals);
}

// Splits a concatenation of JPEG images at their end markers. Entropy-coded data stuffs every
// 0xFF with 0x00, so 0xFFD9 only ends an image.
export class JpegSplitter {
  buffer = Buffer.alloc(0);
  constructor(onUnit) { this.onUnit = onUnit; }
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { this.buffer = Buffer.alloc(0); return; }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { this.buffer = this.buffer.subarray(start); return; }
      this.onUnit({ key: true, data: Buffer.from(this.buffer.subarray(start, end + 2)) });
      this.buffer = this.buffer.subarray(end + 2);
    }
  }
  close() {}
}

const annexb = nals => Buffer.concat(nals.flatMap(nal => [Buffer.from([0, 0, 0, 1]), nal]));
// An HEVC access unit delimiter. The raw-stream parser only knows a picture is complete when the
// next one starts; a delimiter after each picture lets it decode at once instead of a frame late.
const HEVC_AUD = Buffer.from([0, 0, 0, 1, 0x46, 0x01, 0x50]);

// One encoder process. write() takes the phone's HEVC frames ({ key, data }); onFrame receives
// the output frames ({ key, config?, data, pts_us }). The encoder only starts on a key frame, and
// a write that would back up behind a slow encoder drops input up to the next key frame.
// Input queued for an encoder beyond this is dropped up to the next key frame.
export const ENCODER_BACKLOG_BYTES = 4 * 1024 * 1024;

export class Transcoder {
  child; splitter; feeding = false; pts = []; closed = false; restarts = 0;
  // onStall: input was dropped (a backed-up encoder); feeding resumes at the next key frame.
  // onDrain: that encoder took its backed-up input; it can be fed again from a key frame.
  constructor(mode, { onFrame, onExit, onStall, onDrain, spawn = spawnProcess, ...options } = {}) {
    Object.assign(this, { mode, onFrame, onExit, onStall, onDrain, spawn, options });
  }

  get running() { return Boolean(this.child); }

  start() {
    if (this.closed || this.child) return;
    const child = this.spawn('ffmpeg', ffmpegArgs(this.mode, this.options), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.startedAt = performance.now();
    this.feeding = false;
    this.pts = [];
    const Splitter = this.mode === 'jpeg' ? JpegSplitter : FlvSplitter;
    // Bound to this child: a replaced encoder's late output is dropped, never put into the new chain.
    const splitter = this.splitter = new Splitter(unit => {
      if (this.child !== child) return;
      // One picture out per picture in (no B-frames, no lookahead); JPEG drops pictures, so it
      // takes the newest input time.
      const pts = this.mode === 'jpeg' ? this.pts.splice(0).at(-1) : this.pts.shift();
      this.onFrame?.({ ...unit, pts_us: pts ?? 0 });
    });
    let stderr = '';
    child.stdout.on('data', chunk => { if (this.child === child) splitter.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.once('error', error => { stderr ||= error.message; });
    child.once('close', code => {
      if (this.child !== child) return;
      this.splitter?.close(); this.child = undefined; this.feeding = false;
      this.onExit?.({ code, stderr: stderr.trim(), closed: this.closed });
    });
  }

  write(frame) {
    if (this.closed) return;
    if (!this.child) this.start();
    if (!this.feeding && !frame.key) return;
    // A slow encoder: skip input up to the next key frame rather than queue it without bound.
    if (this.child.stdin.writableLength > ENCODER_BACKLOG_BYTES) {
      this.feeding = false; this.onStall?.();
      const child = this.child;
      if (!child.draining) { child.draining = true; child.stdin.once('drain', () => { child.draining = false; if (this.child === child && !this.closed && !this.feeding) this.onDrain?.(); }); }
      return;
    }
    this.feeding = true;
    this.pts.push(frame.pts_us);
    if (this.pts.length > 256) this.pts.shift();
    this.child.stdin.write(frame.data);
    this.child.stdin.write(HEVC_AUD);
  }

  // A new encoder, from the next key frame on: for a new bitrate, or for a key frame now.
  restart(options = {}) {
    Object.assign(this.options, options);
    this.restarts++;
    this.stopChild();
  }

  stopChild() {
    const child = this.child;
    if (!child) return;
    this.child = undefined; this.feeding = false; this.splitter?.close();
    child.stdin.destroy();
    child.kill('SIGKILL');
  }

  close() { this.closed = true; this.stopChild(); }
}

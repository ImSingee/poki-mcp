// Transcodes the phone's HEVC for viewers that cannot decode it, or that need fewer bytes:
// H.264 (libx264 ultrafast, zerolatency, long edge at most 1280) or JPEG (at most 10 frames a
// second, only the latest kept). An encoder runs only while a viewer needs its track, and starts
// on an HEVC key frame. Restarting it (a new bitrate, a keyframe request) starts a new chain with
// a key frame.
import { spawn as spawnProcess, execFile } from 'node:child_process';
import { nalUnits, avcType } from './codec.mjs';

let available;
// Whether ffmpeg with libx264 and mjpeg is on PATH. Checked once.
export function ffmpegAvailable() {
  available ??= new Promise(resolve => {
    execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 5000 }, (error, stdout) => {
      resolve(!error && /libx264/.test(stdout) && /mjpeg/.test(stdout));
    });
  });
  return available;
}

const scale = edge => `scale='trunc(min(iw\\,${edge}*iw/max(iw\\,ih))/2)*2':'trunc(min(ih\\,${edge}*ih/max(iw\\,ih))/2)*2'`;

export function ffmpegArgs(mode, { bitrate = 1_500_000, maxEdge = 1280, fps = 10, quality = 5 } = {}) {
  // Measured with the sample stream: `-fflags nobuffer` loses the first key frame, and without the
  // small probe ffmpeg waits for megabytes before decoding anything.
  const input = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0', '-use_wallclock_as_timestamps', '1', '-f', 'hevc', '-i', 'pipe:0', '-an'];
  if (mode === 'h264') {
    const kbps = Math.round(bitrate / 1000);
    return [...input, '-vf', scale(maxEdge), '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '240',
      '-x264-params', 'aud=1:repeat-headers=1:scenecut=0', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${Math.max(100, Math.round(kbps / 2))}k`, '-flush_packets', '1', '-f', 'h264', 'pipe:1'];
  }
  if (mode === 'jpeg') return [...input, '-vf', `fps=${fps},${scale(maxEdge)}`, '-c:v', 'mjpeg', '-q:v', String(quality), '-flush_packets', '1', '-f', 'image2pipe', 'pipe:1'];
  throw new Error(`Unknown transcode mode ${mode}`);
}

// Splits ffmpeg's H.264 output into access units at each access unit delimiter (aud=1). The
// last unit is complete once the next delimiter arrives, or once the encoder has been quiet for
// IDLE_FLUSH_MS (zerolatency writes each picture at once).
const IDLE_FLUSH_MS = 15;
export class AvcSplitter {
  buffer = Buffer.alloc(0); timer;
  constructor(onUnit) { this.onUnit = onUnit; }
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let start = this.findDelimiter(0);
    if (start < 0) return this.idle();
    let next;
    while ((next = this.findDelimiter(start + 4)) >= 0) { this.emit(this.buffer.subarray(start, next)); start = next; }
    this.buffer = this.buffer.subarray(start);
    this.idle();
  }
  // The offset of the next start code introducing an access unit delimiter (NAL type 9).
  findDelimiter(from) {
    for (let i = from; i + 4 <= this.buffer.length; i++) {
      if (this.buffer[i] === 0 && this.buffer[i + 1] === 0 && this.buffer[i + 2] === 1 && (this.buffer[i + 3] & 0x1f) === 9) return i > 0 && this.buffer[i - 1] === 0 ? i - 1 : i;
    }
    return -1;
  }
  idle() { clearTimeout(this.timer); if (this.buffer.length) this.timer = setTimeout(() => this.flush(), IDLE_FLUSH_MS); }
  flush() { clearTimeout(this.timer); if (this.buffer.length) { this.emit(this.buffer); this.buffer = Buffer.alloc(0); } }
  emit(unit) {
    const nals = nalUnits(unit).filter(nal => avcType(nal) !== 9);
    if (!nals.length) return;
    const key = nals.some(nal => avcType(nal) === 5);
    const config = key ? annexb(nals.filter(nal => [7, 8].includes(avcType(nal)))) : undefined;
    this.onUnit({ key, config, data: annexb(nals) });
  }
  close() { clearTimeout(this.timer); }
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
export class Transcoder {
  child; splitter; feeding = false; pts = []; closed = false; restarts = 0;
  constructor(mode, { onFrame, onExit, spawn = spawnProcess, ...options } = {}) {
    Object.assign(this, { mode, onFrame, onExit, spawn, options });
  }

  get running() { return Boolean(this.child); }

  start() {
    if (this.closed || this.child) return;
    const child = this.spawn('ffmpeg', ffmpegArgs(this.mode, this.options), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.startedAt = performance.now();
    this.feeding = false;
    this.pts = [];
    const Splitter = this.mode === 'jpeg' ? JpegSplitter : AvcSplitter;
    this.splitter = new Splitter(unit => {
      // One picture out per picture in (no B-frames, no lookahead); JPEG drops pictures, so it
      // takes the newest input time.
      const pts = this.mode === 'jpeg' ? this.pts.splice(0).at(-1) : this.pts.shift();
      this.onFrame?.({ ...unit, pts_us: pts ?? 0 });
    });
    let stderr = '';
    child.stdout.on('data', chunk => this.splitter?.push(chunk));
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
    if (this.child.stdin.writableLength > 4 * 1024 * 1024) { this.feeding = false; return; }
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

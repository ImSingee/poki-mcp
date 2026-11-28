// One encoded sequence of frames (the phone's HEVC, or a transcoded H.264 or JPEG track), kept
// from its latest key frame on, so a viewer can always start on a decodable picture. A JPEG track
// keeps only its latest frame.
import { describe } from './codec.mjs';

export class Track {
  frames = []; bytes = 0; latest = 0; info; closed = false; waiters = new Set();
  constructor(codec, { latestOnly = false, maxFrames = 900, maxBytes = 24 * 1024 * 1024 } = {}) {
    Object.assign(this, { codec, latestOnly, maxFrames, maxBytes });
  }

  // frame: { seq, key, pts_us, config?, data, at }. Sequence numbers increase; a gap is only
  // allowed before a key frame (the frames in between were never decodable).
  push(frame) {
    if (this.closed) return;
    if (frame.seq <= this.latest) return;
    const contiguous = frame.seq === this.latest + 1;
    if (this.latestOnly || frame.key) { this.frames = []; this.bytes = 0; }
    if (frame.key && this.codec !== 'jpeg') this.info = describe(this.codec, frame.config ?? frame.data) ?? this.info;
    if (this.latestOnly || frame.key || (contiguous && this.frames.length)) {
      this.frames.push(frame); this.bytes += frame.data.length;
      // Too long to replay: the next viewer waits for a fresh key frame instead.
      if (this.frames.length > this.maxFrames || this.bytes > this.maxBytes) { this.frames = []; this.bytes = 0; }
    } else { this.frames = []; this.bytes = 0; }
    this.latest = frame.seq;
    this.wake();
  }

  // The frames after `seq`, when they follow it without a gap; undefined when they do not.
  since(seq) {
    const first = this.frames[0];
    if (!first) return seq === this.latest ? [] : undefined;
    if (seq + 1 < first.seq) return undefined;
    return this.frames.filter(frame => frame.seq > seq);
  }

  latestKey() { return this.frames.find(frame => frame.key); }

  // Resolves at the next frame, at close, after `ms`, or when `signal` aborts.
  wait(ms, signal) {
    if (this.closed || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  wake() { for (const waiter of [...this.waiters]) waiter(); }

  // A new source session (a media restart, an encoder restart): what was cached cannot start a
  // decoder of what follows.
  reset() { this.frames = []; this.bytes = 0; this.wake(); }
  close() { this.closed = true; this.reset(); }
}

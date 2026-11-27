// Per-viewer flow control for the screen stream.
//
// Adapted from lody's device preview (apps/cli/src/device-preview/h264-flow.ts and frame-flow.ts,
// https://github.com/ImSingee/Lody, Apache License 2.0): credit is returned by decoded-frame
// acknowledgements, encoded deltas are never skipped inside a chain (a viewer that falls behind
// drops the whole chain and resumes at a key frame), a keyframe is requested at most once a
// second, and the transcoded track's bitrate follows how quickly acknowledgements come back.
// Unlike lody's push flow, frames here are pulled: by long-polled tool calls (screen_read), or by
// the WebRTC sender, which calls take() the same way.

// A delta older than this when it would be sent means the viewer is too far behind: it resumes
// at a fresh key frame instead of replaying the backlog.
export const STALE_MS = 1000;
// Frames and bytes a viewer may have received without acknowledging them.
const WINDOW_FRAMES = 48;
const WINDOW_BYTES = 4 * 1024 * 1024;
// Bitrate bounds for a transcoded track (H.264), and its starting point.
export const MIN_BITRATE = 300_000;
export const MAX_BITRATE = 4_000_000;

const envInteger = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};
// How much one screen_read may return: S3 measured 50-500 KB frames through LobeHub's relay at the
// same latency, but the production gateway's limits are unknown, so the default stays small.
export const readLimits = () => ({
  maxBytes: envInteger('POKI_SCREEN_READ_MAX_BYTES', 256 * 1024, 16 * 1024, 4 * 1024 * 1024),
  maxFrames: envInteger('POKI_SCREEN_READ_MAX_FRAMES', 16, 1, 64),
});
export const startBitrate = () => envInteger('POKI_SCREEN_H264_BITRATE', 1_500_000, MIN_BITRATE, MAX_BITRATE);

export class Flow {
  sent = 0; acked = 0; waitingKey = true; inFlight = new Map();
  baseRtt = 400; rtt = 0; bitrate = startBitrate();
  feedbackAt; feedbackCount = 0; slowFeedback = 0; feedbackBytes = 0; minFeedback = Infinity; lastAck = 0; lastTune = 0;
  constructor({ latestOnly = false } = {}) { this.latestOnly = latestOnly; }

  // Resume at the next key frame: after a gap, a decoder error, a backlog, or a transport lost with
  // frames on it. Whatever was sent and not acknowledged is abandoned with it, so its credit comes
  // back: the viewer cannot acknowledge frames it never received.
  resync() { this.waitingKey = true; this.inFlight.clear(); this.acked = this.sent; }

  inFlightBytes() { let n = 0; for (const f of this.inFlight.values()) n += f.bytes; return n; }

  // The frames of `track` to send now. Returns { frames, discontinuity, recover }: recover asks
  // the source for a key frame (the hub rate-limits it).
  take(track, now, { credit = WINDOW_FRAMES, maxBytes, maxFrames }) {
    let discontinuity = false, recover = false;
    if (this.latestOnly) {
      const latest = track.frames.at(-1);
      if (!latest || latest.seq <= this.sent || this.inFlight.size >= 2 || credit < 1) return { frames: [], discontinuity, recover };
      discontinuity = latest.seq !== this.sent + 1 && this.sent !== 0;
      this.record(latest, now);
      this.waitingKey = false;
      return { frames: [latest], discontinuity, recover };
    }
    let pending = this.waitingKey ? undefined : track.since(this.sent);
    if (pending?.length && pending[0].seq !== this.sent + 1) pending = undefined;
    // Never replay a stale backlog: drop the chain and start again at a key frame.
    if (pending?.length && !pending[0].key && now - pending[0].at > STALE_MS) { pending = undefined; this.waitingKey = true; recover = true; }
    if (!pending) {
      const key = track.latestKey();
      if (!key || key.seq <= this.sent) { this.waitingKey = true; return { frames: [], discontinuity, recover: true }; }
      if (!this.waitingKey) recover = true;
      pending = track.since(key.seq - 1);
      discontinuity = this.sent !== 0;
      this.waitingKey = false;
      // A long chain behind the only key frame: also ask for a fresh one.
      if (pending.length > 30) recover = true;
    }
    const room = Math.min(credit, maxFrames, WINDOW_FRAMES - (this.sent - this.acked));
    const frames = [];
    let bytes = 0;
    const windowLeft = WINDOW_BYTES - this.inFlightBytes();
    for (const frame of pending) {
      if (frames.length >= room) break;
      const size = frame.data.length + (frame.config?.length ?? 0);
      if (frames.length && (bytes + size > maxBytes || bytes + size > windowLeft)) break;
      if (!frames.length && this.inFlight.size && size > windowLeft) break;
      frames.push(frame); bytes += size;
    }
    for (const frame of frames) this.record(frame, now);
    return { frames, discontinuity, recover };
  }

  record(frame, now) {
    this.sent = frame.seq;
    this.inFlight.set(frame.seq, { bytes: frame.data.length + (frame.config?.length ?? 0), at: now });
  }

  // The viewer decoded (or deliberately superseded) every frame up to `seq`.
  acknowledge(seq, now) {
    if (!Number.isSafeInteger(seq) || seq <= this.acked || seq > this.sent) return;
    const frame = this.inFlight.get(seq);
    this.acked = seq;
    let bytes = 0;
    for (const [id, entry] of this.inFlight) if (id <= seq) { bytes += entry.bytes; this.inFlight.delete(id); }
    if (!frame) return;
    const ackMs = Math.max(0, now - frame.at);
    this.rtt = ackMs;
    this.baseRtt = Math.min(this.baseRtt, Math.max(1, ackMs));
    // One slow acknowledgement after a healthy interval is jitter; a two-second window decides.
    if (!this.feedbackCount || now - this.lastAck >= 2000) { this.feedbackAt = now; this.feedbackCount = this.slowFeedback = this.feedbackBytes = 0; this.minFeedback = Infinity; }
    this.lastAck = now; this.feedbackCount++; this.feedbackBytes += bytes;
    if (ackMs > this.baseRtt + 350) this.slowFeedback++;
    this.minFeedback = Math.min(this.minFeedback, ackMs);
    const elapsed = now - this.feedbackAt;
    if (elapsed < 2000) return;
    const enough = this.feedbackCount >= 8, slow = this.slowFeedback / this.feedbackCount;
    if (enough && slow >= 0.75) { this.bitrate = Math.max(MIN_BITRATE, Math.round(this.bitrate * 0.75)); this.lastTune = now; }
    else if (enough && slow <= 0.1 && now - this.lastTune >= 5000 && this.minFeedback < this.baseRtt + 150 && (this.feedbackBytes * 8000) / elapsed > this.bitrate * 0.4) {
      // Tiny static deltas are no bandwidth probe: raise only with demand.
      this.bitrate = Math.min(MAX_BITRATE, Math.round(this.bitrate * 1.15)); this.lastTune = now;
    }
    this.feedbackCount = this.slowFeedback = this.feedbackBytes = 0; this.feedbackAt = undefined; this.minFeedback = Infinity;
  }

  snapshot(now) {
    const first = this.inFlight.values().next().value;
    return { sent: this.sent, acked: this.acked, in_flight_frames: this.inFlight.size, in_flight_bytes: this.inFlightBytes(), oldest_ms: first ? Math.round(now - first.at) : 0, rtt_ms: Math.round(this.rtt), base_rtt_ms: Math.round(this.baseRtt), bitrate: this.bitrate };
  }
}

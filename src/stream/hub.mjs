// The live screen of each phone, shared by its viewers.
//
// One native subscription per device (media_subscribe on its helper) feeds an HEVC track; viewers
// that cannot decode HEVC read an H.264 or JPEG track transcoded from it on demand. Each viewer
// has its own position and credit (flow.mjs) and a lease: a viewer not heard from for
// VIEWER_TTL_MS is closed, and when the last viewer of a device goes, its subscription ends and
// the phone's displayservice session (which holds the camera and microphone) is released.
import { randomBytes } from 'node:crypto';
import { nativeSubscribe, nativeKeyframe } from '../remote.mjs';
import { Track } from './track.mjs';
import { Flow, readLimits } from './flow.mjs';
import { Transcoder, ffmpegCodecs } from './transcode.mjs';

export const VIEWER_TTL_MS = 10_000;
export const KEYFRAME_INTERVAL_MS = 1000;
// How long an encoder waits for the phone to answer a key frame request, and how often it asks.
export const KEYFRAME_ANSWER_MS = 2000;
const KEYFRAME_ASKS = 3;
export const MAX_WAIT_MS = 1000;
const RETRY_MS = [1000, 2000, 5000];
// A transcoded track's encoder is restarted for a new bitrate at most this often, and only when
// the bitrate moved by at least a fifth.
const RETUNE_MS = 5000;
// An encoder that exits on its own is restarted at most this often a minute.
const ENCODER_RESTARTS = 3;

export const CODECS = ['hevc', 'h264', 'jpeg'];
export const MAX_VIEWERS = 8;
// Pictures a second a JPEG viewer reads over tool calls (POKI_SCREEN_JPEG_FPS, 0 for no limit).
export const jpegFps = (env = process.env) => { const value = Number(env.POKI_SCREEN_JPEG_FPS ?? 10); return Number.isFinite(value) && value >= 0 ? value : 10; };
// Minutes without input in the panel or a tool call on the device before a stream is paused
// (POKI_SCREEN_IDLE_MINUTES, 0 to never pause).
export const idleMinutes = (env = process.env) => { const value = Number(env.POKI_SCREEN_IDLE_MINUTES ?? 20); return Number.isFinite(value) && value >= 0 ? value : 20; };
// How long a WebRTC peer stays open after the view was told its stream ended, for that message to arrive.
const RTC_ENDED_CLOSE_MS = 250;

class ScreenHub {
  viewers = new Set(); tracks = new Map(); transcoders = new Map(); failed = new Map();
  subscription; starting; stopped = false; lastKeyframe = -Infinity; retry = 0; retryTimer; keyframeAsks = 0; keyframeAnswer;
  localSeq = 0; nativeBase; error;
  constructor(target, deps) {
    this.target = target; this.deps = deps;
    this.tracks.set('hevc', new Track('hevc'));
  }

  // Subscribes on the first viewer. Rejects when the phone cannot stream (no displayservice).
  // The subscription attempt is shared by every viewer opening meanwhile and has its own lifetime:
  // one caller's cancellation ends only its own wait, and the attempt ends once no caller waits.
  async start(signal) {
    if (this.subscription) return;
    // A caller cancelled already starts nothing.
    signal?.throwIfAborted();
    if (!this.starting) {
      const startup = this.startup = { controller: new AbortController(), waiters: 0, kept: false };
      this.starting = this.subscribe(startup).finally(() => { if (this.startup === startup) { this.starting = undefined; this.startup = undefined; } });
      // Observed even when every caller has gone: a rejection nobody awaits must not end the daemon.
      this.starting.catch(() => {});
    }
    const startup = this.startup, starting = this.starting;
    // A caller that cannot be cancelled (a reconnect) keeps the attempt going.
    if (!signal) { startup.kept = true; return starting; }
    startup.waiters++;
    let onAbort;
    try {
      signal.throwIfAborted();
      return await Promise.race([starting, new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); })]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      startup.waiters--;
      if (signal.aborted && !startup.waiters && !startup.kept) startup.controller.abort(signal.reason);
    }
  }

  async subscribe(startup) {
    const { signal } = startup.controller;
    // A new subscription numbers its frames afresh; the track must see a gap before them. Reset
    // before subscribing: the first frames can arrive in the same chunk as the reply, before
    // subscribe() resolves.
    this.nativeBase = undefined;
    const subscription = await this.deps.subscribe(this.target, frame => this.receive(frame), { signal });
    if (this.stopped) { subscription.close(); return; }
    const recovered = this.error !== undefined;
    this.subscription = subscription; this.retry = 0; this.error = undefined;
    this.reply = subscription.reply;
    if (recovered) this.sourceChanged();
    subscription.closed.then(() => { if (this.subscription === subscription) { this.subscription = undefined; this.error ??= 'The iPhone\'s screen stream stopped; reconnecting.'; this.sourceChanged(); this.reconnect(); } });
  }

  // The phone's stream dropped (Wi-Fi lost, the helper died): subscribe again with backoff while
  // anyone watches. Not while the device is unavailable (unpaired or being paired again): a new
  // subscription would start a helper from a configuration being replaced.
  reconnect() {
    if (this.stopped || !this.viewers.size) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      const unavailable = this.deps.unavailable?.(this.target.id);
      const attempt = unavailable ? Promise.reject(new Error(unavailable)) : this.start();
      attempt.catch(error => { this.error = error.message; this.sourceChanged(); this.reconnect(); });
    }, RETRY_MS[Math.min(this.retry++, RETRY_MS.length - 1)]);
    this.retryTimer.unref?.();
  }

  // Viewers on WebRTC are told when the phone's stream drops and comes back (screen_read replies
  // carry source_error).
  sourceChanged() {
    const error = this.subscription ? null : this.error ?? null;
    for (const viewer of this.viewers) viewer.rtc?.notify?.({ type: 'source', error });
  }

  receive(native) {
    // Local numbers keep increasing across subscriptions; a gap stays a gap.
    if (this.nativeBase === undefined) this.nativeBase = this.localSeq + 1 - native.seq + (this.localSeq ? 1 : 0);
    const seq = this.nativeBase + native.seq;
    if (seq <= this.localSeq) return;
    this.localSeq = seq;
    // A media restart (native.reset) begins with a key frame, which starts a new chain anyway.
    const frame = { seq, key: native.key, pts_us: native.pts_us, config: native.config, data: native.data, at: performance.now() };
    this.tracks.get('hevc').push(frame);
    // The key frame asked for came: no need to ask again.
    if (frame.key) { clearTimeout(this.keyframeAnswer); this.keyframeAnswer = undefined; this.keyframeAsks = 0; }
    this.pushed('hevc');
    for (const transcoder of this.transcoders.values()) transcoder.write(frame);
  }

  // Viewers on WebRTC are pushed to: they have no pending read to wake.
  pushed(codec) { for (const viewer of this.viewers) if (viewer.codec === codec) viewer.rtc?.pump(); }

  // The track a codec reads, starting its encoder when it is a transcoded one.
  track(codec) {
    if (codec === 'hevc') return this.tracks.get('hevc');
    if (!this.transcoders.has(codec)) {
      const track = new Track(codec, { latestOnly: codec === 'jpeg' });
      let seq = 0;
      const transcoder = new Transcoder(codec, {
        bitrate: this.bitrate(codec), spawn: this.deps.spawn,
        onFrame: frame => { track.push({ ...frame, seq: ++seq, at: performance.now() }); this.pushed(codec); },
        // It resumes only at a key frame, which a still screen sends only when asked.
        onStall: () => this.askSourceKeyframe(),
        onDrain: () => this.resumeEncoder(transcoder),
        onExit: ({ closed, code, stderr }) => {
          if (closed) return;
          transcoder.lastExit = stderr || `exit code ${code}`;
          track.reset(); seq++;
          // It died on its own: start a new one on the cached HEVC chain (a still screen sends no
          // new key frame), at most ENCODER_RESTARTS times a minute.
          const now = performance.now();
          transcoder.exits = (transcoder.exits ?? []).filter(at => now - at < 60000);
          transcoder.exits.push(now);
          if (transcoder.exits.length > ENCODER_RESTARTS) {
            this.failed.set(codec, `The ${codec} encoder keeps stopping (${transcoder.lastExit ?? 'no reason given'}).`);
            // Closed, so the frames that keep coming start no new ffmpeg.
            transcoder.close();
            this.pushed(codec); track.wake(); return;
          }
          const timer = setTimeout(() => { if (this.transcoders.get(codec) === transcoder && !transcoder.closed) this.startEncoder(transcoder, { placeholder: true }); }, 500);
          timer.unref?.();
        },
      });
      this.tracks.set(codec, track); this.transcoders.set(codec, transcoder);
      this.startEncoder(transcoder, { placeholder: true });
    }
    return this.tracks.get(codec);
  }

  // Starts (or restarts) an encoder without replaying the cached chain: the frames after its key
  // frame would come out again as new pictures, showing the past and, on a slow viewer, asking for
  // the next restart. When the newest key frame is the screen now, it alone is fed. Otherwise the
  // encoder starts at the phone's next key frame, which it is asked for; only a track with no
  // picture yet (placeholder) gets the older key frame's picture meanwhile.
  startEncoder(transcoder, { placeholder = false } = {}) {
    const hevc = this.tracks.get('hevc'), key = hevc.latestKey();
    if (key && hevc.latest === key.seq) { transcoder.write(key); return; }
    if (key && placeholder) { transcoder.write(key); transcoder.feeding = false; }
    this.askSourceKeyframe();
  }

  // Asks the phone for a key frame for an encoder, at most once a second: a request within that
  // second is deferred to its end, not dropped (the key frame asked for may itself be lost).
  askSourceKeyframe() {
    if (this.stopped || this.chainKeyframeTimer) return;
    const wait = (this.chainKeyframeAt ?? -Infinity) + KEYFRAME_INTERVAL_MS - performance.now();
    const ask = () => {
      this.chainKeyframeTimer = undefined;
      if (this.stopped) return;
      this.chainKeyframeAt = performance.now();
      // A failed request is a failed attempt: the answer check below asks again.
      this.deps.keyframe(this.target).catch(() => {});
      this.awaitKeyframe();
    };
    if (wait <= 0) { ask(); return; }
    this.chainKeyframeTimer = setTimeout(ask, wait);
    this.chainKeyframeTimer.unref?.();
  }

  // An encoder waiting for the phone's next key frame (after a start, a restart or a stall) asks
  // again when none came within KEYFRAME_ANSWER_MS, KEYFRAME_ASKS times in all. Past that (the
  // helper restarts the media session for an overdue key frame itself, so this is a last resort),
  // each waiting encoder is fed the cached chain once: an older picture catching up, rather than
  // none at all.
  awaitKeyframe() {
    if (this.keyframeAnswer) return;
    this.keyframeAnswer = setTimeout(() => {
      this.keyframeAnswer = undefined;
      const waiting = [...this.transcoders.values()].filter(transcoder => !transcoder.closed && !transcoder.feeding);
      if (this.stopped || !waiting.length) { this.keyframeAsks = 0; return; }
      if (++this.keyframeAsks < KEYFRAME_ASKS) { this.askSourceKeyframe(); return; }
      this.keyframeAsks = 0;
      const hevc = this.tracks.get('hevc'), key = hevc.latestKey();
      const chain = key ? hevc.since(key.seq - 1) ?? [] : [];
      if (!chain.length) { this.askSourceKeyframe(); return; }
      for (const transcoder of waiting) for (const frame of chain) transcoder.write(frame);
    }, KEYFRAME_ANSWER_MS);
    this.keyframeAnswer.unref?.();
  }

  // A backed-up encoder caught up: it resumes at the newest key frame if that is the screen now,
  // else at the phone's next key frame.
  resumeEncoder(transcoder) {
    if (transcoder.closed || transcoder.feeding || this.transcoders.get(transcoder.mode) !== transcoder) return;
    this.startEncoder(transcoder);
  }

  bitrate(codec) {
    const rates = [...this.viewers].filter(v => v.codec === codec).map(v => v.flow.bitrate);
    return rates.length ? Math.min(...rates) : undefined;
  }

  retune(codec, now) {
    const transcoder = this.transcoders.get(codec);
    if (codec !== 'h264' || !transcoder) return;
    const wanted = this.bitrate(codec), current = transcoder.options.bitrate;
    if (!wanted || !current || Math.abs(wanted - current) / current < 0.2 || now - (transcoder.tunedAt ?? 0) < RETUNE_MS) return;
    transcoder.tunedAt = now;
    this.restartEncoder(codec, { bitrate: wanted });
  }

  // A new encoder for a new bitrate, from the phone's next key frame.
  restartEncoder(codec, options) {
    const transcoder = this.transcoders.get(codec);
    if (!transcoder) return;
    transcoder.restart(options);
    this.startEncoder(transcoder);
  }

  // A viewer needs a key frame: the phone is asked (PLI/FIR, then a media restart in the helper).
  // The H.264 encoder makes a key frame of each of the phone's (-force_key_frames source), and each
  // JPEG picture stands alone, so no encoder restarts. At most once a second.
  requestKeyframe(codec, now = performance.now()) {
    if (now - this.lastKeyframe < KEYFRAME_INTERVAL_MS) return false;
    this.lastKeyframe = now;
    if (codec === 'hevc') this.deps.keyframe(this.target).catch(() => {});
    else if (codec === 'h264') this.askSourceKeyframe();
    return true;
  }

  // Ends encoders no viewer reads any more.
  prune() {
    for (const [codec, transcoder] of this.transcoders) {
      if ([...this.viewers].some(v => v.codec === codec)) continue;
      transcoder.close(); this.transcoders.delete(codec); this.tracks.get(codec)?.close(); this.tracks.delete(codec);
    }
  }

  stop() {
    this.stopped = true; clearTimeout(this.retryTimer); clearTimeout(this.chainKeyframeTimer); clearTimeout(this.keyframeAnswer);
    this.startup?.controller.abort(new DOMException('The screen stream ended', 'AbortError'));
    this.subscription?.close(); this.subscription = undefined;
    for (const transcoder of this.transcoders.values()) transcoder.close();
    for (const track of this.tracks.values()) track.close();
    this.transcoders.clear();
  }
}

class Viewer {
  constructor(screens, hub, codec) {
    this.id = randomBytes(16).toString('hex');
    Object.assign(this, { screens, hub, codec, device: hub.target.id });
    this.flow = new Flow({ latestOnly: codec === 'jpeg' });
    this.renew();
  }
  // Every sign of the view (a read, a WebRTC control message) keeps the stream, and through
  // onRenew a takeover, alive.
  renew() { const now = performance.now(); this.expires = now + this.screens.ttlMs; this.onRenew?.(now); }
  get track() { return this.hub.track(this.codec); }

  describe() {
    const track = this.track;
    const size = track.info ?? (this.hub.reply?.width ? { width: this.hub.reply.width, height: this.hub.reply.height } : undefined);
    return { stream: this.id, device: this.device, codec: this.codec, ...(track.info?.codec ? { codec_string: track.info.codec } : {}), ...(size ? { width: size.width, height: size.height } : {}), lease_ms: this.screens.ttlMs };
  }

  // The frames this viewer may receive now, without waiting.
  take({ credit, ...limits } = readLimits()) {
    const now = performance.now();
    const taken = this.flow.take(this.track, now, { credit: Number.isSafeInteger(credit) ? credit : undefined, ...limits });
    if (taken.recover) this.hub.requestKeyframe(this.codec);
    this.hub.retune(this.codec, now);
    return taken;
  }

  // Long poll: returns as soon as there are frames to send, or after wait_ms.
  async read({ cursor, ack, credit, wait_ms = MAX_WAIT_MS, resync = false, max_bytes } = {}, signal) {
    this.renew();
    const now = () => performance.now();
    if (Number.isSafeInteger(ack ?? cursor)) this.flow.acknowledge(ack ?? cursor, now());
    if (resync) { this.flow.resync(); this.hub.requestKeyframe(this.codec); }
    // A view whose reads fail (a relay's size limit, say) asks for smaller batches.
    const limits = readLimits();
    if (Number.isSafeInteger(max_bytes) && max_bytes >= 16 * 1024) limits.maxBytes = Math.min(limits.maxBytes, max_bytes);
    const deadline = now() + Math.min(Math.max(0, wait_ms), MAX_WAIT_MS);
    for (;;) {
      if (this.closed) return { stream: this.id, device: this.device, codec: this.codec, closed: true, ...(this.ended ? { reason: this.ended.reason, error: this.ended.message } : {}), frames: [] };
      // The codec cannot be served any more: the view opens the stream again in another one.
      if (this.hub.failed.has(this.codec)) return { ...this.describe(), codec_failed: true, error: this.hub.failed.get(this.codec), frames: [] };
      const track = this.track;
      // Several reads may be in flight and their replies may arrive out of order: `after` says
      // which frame a batch continues, so the view can put batches back in order.
      const after = this.flow.sent;
      // JPEG over tool calls: at most jpegFps() pictures a second cross the relay, however fast the
      // phone sends. The track keeps only the newest, so the last picture of a still screen still
      // goes, once the interval is over.
      const spacing = this.codec === 'jpeg' && jpegFps() ? (this.jpegNextAt ?? 0) - now() : 0;
      if (spacing > 0 && now() < deadline && !signal?.aborted) { await new Promise(resolve => setTimeout(resolve, Math.min(spacing, deadline - now()))); continue; }
      const taken = spacing > 0 ? { frames: [] } : this.take({ credit, ...limits });
      if (taken.frames.length && this.codec === 'jpeg' && jpegFps()) this.jpegNextAt = now() + 1000 / jpegFps();
      if (taken.frames.length || now() >= deadline || signal?.aborted) {
        return { ...this.describe(), after, ...(taken.discontinuity ? { discontinuity: true } : {}), ...(this.hub.error && !this.hub.subscription ? { source_error: this.hub.error } : {}), flow: this.flow.snapshot(now()),
          frames: taken.frames.map(frame => ({ seq: frame.seq, key: frame.key, pts_us: frame.pts_us, ...(frame.config ? { config: frame.config.toString('base64') } : {}), data: frame.data.toString('base64') })) };
      }
      await track.wait(deadline - now(), signal);
      this.renew();
    }
  }

  // ended: why the device's panels were ended on purpose (disconnect_device, unpair_device); a view
  // told so does not open the stream again on its own.
  close(ended) {
    if (this.closed) return;
    this.closed = true; this.ended = ended;
    if (ended) this.screens.remember(this.id, ended);
    const rtc = this.rtc;
    if (ended && rtc?.notify) {
      // Told on the control channel first: a closed peer is only noticed seconds later.
      rtc.notify({ type: 'ended', reason: ended.reason, error: ended.message });
      setTimeout(() => void rtc.close(), RTC_ENDED_CLOSE_MS).unref?.();
    } else void rtc?.close();
    this.screens.detach(this);
  }
}

// Every device's live screen in this daemon.
export class Screens {
  // disconnected: devices whose panels disconnect_device ended, so that a panel mounted again does
  // not reconnect the phone by itself.
  hubs = new Map(); viewers = new Map(); ended = new Map(); disconnected = new Map(); sweeper;
  // deps.ffmpeg: the codecs ffmpeg can transcode to (an array), or true/false for both or none.
  constructor({ ttlMs = VIEWER_TTL_MS, ...deps } = {}) { this.ttlMs = ttlMs; this.deps = { subscribe: nativeSubscribe, keyframe: nativeKeyframe, ffmpeg: ffmpegCodecs, ...deps }; }

  // The codecs this host can serve, in the order a view tries them.
  async codecs() {
    const transcoded = await this.deps.ffmpeg();
    const list = transcoded === true ? CODECS : Array.isArray(transcoded) ? transcoded : [];
    return CODECS.filter(codec => codec === 'hevc' || list.includes(codec));
  }

  // The daemon's view of its devices: unavailable(id) says why a device cannot be used now (unpaired
  // or being paired again), activity(id) when a tool last used it (performance.now() time).
  attach({ unavailable, activity }) { Object.assign(this.deps, { unavailable, activity }); }

  // A new viewer of target's screen in the first of `codecs` this host serves. A device whose panels
  // disconnect_device ended opens again only with reconnect (the person asked for it), or once a
  // tool has used the device since.
  async open(target, { codecs = CODECS, signal, reconnect = false } = {}) {
    const disconnected = this.disconnected.get(target.id);
    if (disconnected && !reconnect && (this.deps.activity?.(target.id) ?? 0) <= disconnected.at) throw Object.assign(new Error(disconnected.message), { reason: disconnected.reason });
    this.disconnected.delete(target.id);
    const asked = performance.now();
    // HEVC is served as the phone sends it: a view that wants nothing else needs no ffmpeg.
    const served = codecs.every(codec => codec === 'hevc') ? ['hevc'] : await this.codecs();
    // A disconnect that came while ffmpeg was being checked wins over this opening.
    const overtaken = this.disconnected.get(target.id);
    if (overtaken && overtaken.at >= asked) throw Object.assign(new Error(overtaken.message), { reason: overtaken.reason });
    // A codec whose encoder kept failing for this device is not offered again while its hub lives.
    const failed = this.hubs.get(target.id)?.failed ?? new Map();
    const codec = codecs.find(c => served.includes(c) && !failed.has(c));
    if (!codec) throw new Error(`None of the codecs ${codecs.join(', ')} can be served here${served.length < CODECS.length ? ` (this computer's ffmpeg serves ${served.join(' and ')}: H.264 needs ffmpeg with libx264, JPEG ffmpeg with mjpeg)` : ''}.`);
    let hub = this.hubs.get(target.id);
    // Each viewer holds reads, credit and possibly a WebRTC peer; an unrenewed one goes in 10 s.
    if (hub && hub.viewers.size >= MAX_VIEWERS) throw new Error(`${target.id} already has ${MAX_VIEWERS} screen viewers. Close a screen panel first.`);
    if (!hub) { hub = new ScreenHub(target, this.deps); this.hubs.set(target.id, hub); }
    const viewer = new Viewer(this, hub, codec);
    viewer.openedAt = performance.now();
    hub.viewers.add(viewer); this.viewers.set(viewer.id, viewer);
    this.sweep();
    // A cold start can take longer than the lease (the helper may open a tunnel and the media
    // session first): the lease starts once the stream is open.
    viewer.opening = true;
    try { await hub.start(signal); }
    catch (error) { viewer.close(); throw error; }
    finally { viewer.opening = false; }
    if (viewer.closed) throw Object.assign(new Error('This screen stream has ended. Open it again.'), { code: 'stream_closed' });
    viewer.renew();
    hub.track(codec);
    return viewer;
  }

  get(id) {
    const viewer = typeof id === 'string' ? this.viewers.get(id) : undefined;
    const ended = typeof id === 'string' ? this.ended.get(id) : undefined;
    if (!viewer && ended) throw Object.assign(new Error(ended.message), { code: ended.reason });
    if (!viewer || viewer.closed) throw Object.assign(new Error('This screen stream has ended. Open it again.'), { code: 'stream_closed' });
    return viewer;
  }

  // Why a stream was ended on purpose, for the view's later calls on it (a bounded memory).
  remember(id, ended) {
    this.ended.set(id, ended);
    for (const key of this.ended.keys()) { if (this.ended.size <= 64) break; this.ended.delete(key); }
  }

  detach(viewer) {
    this.viewers.delete(viewer.id);
    const hub = viewer.hub;
    hub.viewers.delete(viewer);
    hub.tracks.get(viewer.codec)?.wake();
    if (!hub.viewers.size) { hub.stop(); if (this.hubs.get(hub.target.id) === hub) this.hubs.delete(hub.target.id); }
    else hub.prune();
    if (!this.viewers.size) { clearInterval(this.sweeper); this.sweeper = undefined; }
  }

  // Closes viewers whose lease ran out: an abandoned panel must not keep the phone's camera and
  // microphone busy.
  // Closes viewers whose lease ran out, and viewers idle for idleMinutes(): nobody gave input in the
  // panel and no tool used the device. A panel left open on a screen nobody looks at must not keep
  // the iPhone's camera and microphone busy; the person resumes it with one click. While an agent
  // works on the device, its calls keep the panel going.
  sweep() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = performance.now(), idleMs = idleMinutes() * 60000;
      for (const viewer of [...this.viewers.values()]) {
        if (viewer.opening) continue;
        if (now >= viewer.expires) { viewer.close(); continue; }
        const active = Math.max(viewer.openedAt, viewer.inputAt ?? 0, this.deps.activity?.(viewer.device) ?? 0);
        if (idleMs && now - active >= idleMs) viewer.close({ reason: 'idle', message: `The screen was paused after ${idleMinutes()} minutes without activity, which frees the iPhone's camera and microphone. Resume to show it again.` });
      }
    }, Math.min(500, this.ttlMs / 4));
    this.sweeper.unref?.();
  }

  // Every viewer of a device ends: it was disconnected, unpaired or is being paired again. After a
  // disconnect or a new pairing, a panel opens the stream again only when the person asks.
  closeDevice(id, reason = 'device_disconnected') {
    const message = {
      device_unpaired: 'This iPhone was unpaired, so its screen is no longer shown.',
      device_repairing: 'This iPhone is being paired again. Reconnect to show its screen once pairing is done.',
    }[reason] ?? 'This iPhone was disconnected. Reconnect to show its screen again.';
    if (reason !== 'device_unpaired') this.disconnected.set(id, { reason, message, at: performance.now() });
    for (const viewer of [...this.viewers.values()]) if (viewer.device === id) viewer.close({ reason, message });
  }
  closeAll() { for (const viewer of [...this.viewers.values()]) viewer.close(); }
  get active() { return this.viewers.size; }
}

export const screens = new Screens();

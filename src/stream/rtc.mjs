// Transport A for the screen panel: a WebRTC peer per viewer, used when the view's browser can
// reach this computer (host or STUN candidates, or a TURN relay). Signaling is two app-only tool
// calls without trickle ICE (screen_rtc_config, screen_rtc_offer); every other view call still goes
// through the host. Transport B (screen_read) stays available when ICE does not connect.
//
// The view opens two ordered, reliable DataChannels: `media` (frames from here) and `control`
// (acknowledgements, keyframe requests and gestures from the view). Frames use lody's private
// packets (https://github.com/ImSingee/Lody, apps/cli/src/device-preview, Apache License 2.0),
// with Annex-B payloads and an HEVC variant:
//   LHVC / LAVC: u32 magic | u32 seq | u8 2=key 3=delta | u16 config length | config | Annex-B
//   LODY:        u32 magic | u32 seq | JPEG
// Each packet is split into chunks of at most RTC_CHUNK_BYTES: u32 total length | u32 offset | bytes.
import { createHmac } from 'node:crypto';

export const MAGIC = { hevc: 0x4c485643, h264: 0x4c415643, jpeg: 0x4c4f4459 };
export const RTC_CHUNK_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const BUFFERED_HIGH = 256 * 1024;
// A peer whose channels did not open by then is given up; the view falls back to screen_read.
const OPEN_TIMEOUT_MS = 20_000;

export function packet(codec, frame) {
  if (codec === 'jpeg') {
    const out = Buffer.allocUnsafe(8 + frame.data.length);
    out.writeUInt32BE(MAGIC.jpeg, 0); out.writeUInt32BE(frame.seq >>> 0, 4); frame.data.copy(out, 8);
    return out;
  }
  const config = frame.key ? frame.config ?? Buffer.alloc(0) : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(11 + config.length + frame.data.length);
  out.writeUInt32BE(MAGIC[codec], 0); out.writeUInt32BE(frame.seq >>> 0, 4); out[8] = frame.key ? 2 : 3;
  out.writeUInt16BE(config.length, 9); config.copy(out, 11); frame.data.copy(out, 11 + config.length);
  return out;
}

export function* chunks(frame) {
  if (frame.length < 1 || frame.length > MAX_FRAME_BYTES) throw new Error('Invalid RTC frame');
  for (let offset = 0; offset < frame.length; offset += RTC_CHUNK_BYTES - 8) {
    const payload = frame.subarray(offset, offset + RTC_CHUNK_BYTES - 8);
    const chunk = Buffer.allocUnsafe(payload.length + 8);
    chunk.writeUInt32BE(frame.length, 0); chunk.writeUInt32BE(offset, 4); payload.copy(chunk, 8);
    yield chunk;
  }
}

// The ICE servers both peers use. STUN defaults to a public server (POKI_STUN_URL, empty to turn it
// off); TURN is used only when POKI_TURN_URL is set, with time-limited credentials derived from
// POKI_TURN_SECRET (coturn's use-auth-secret) or the static POKI_TURN_USERNAME/POKI_TURN_PASSWORD.
export function iceServers(env = process.env, now = Date.now()) {
  const servers = [];
  const stun = env.POKI_STUN_URL ?? 'stun:stun.l.google.com:19302';
  if (stun.trim()) servers.push({ urls: stun.split(',').map(url => url.trim()).filter(Boolean) });
  const turn = env.POKI_TURN_URL?.trim();
  if (turn) {
    // werift uses only the first TURN URL, so the most widely reachable one (TLS on 443) goes first.
    const urls = turn.split(',').map(url => url.trim()).filter(Boolean)
      .sort((a, b) => Number(/^turns:.*:443(\?|$)/.test(b)) - Number(/^turns:.*:443(\?|$)/.test(a)));
    let username = env.POKI_TURN_USERNAME, credential = env.POKI_TURN_PASSWORD;
    if (env.POKI_TURN_SECRET) {
      username = `${Math.floor(now / 1000) + 3600}:poki`;
      credential = createHmac('sha1', env.POKI_TURN_SECRET).update(username).digest('base64');
    }
    servers.push({ urls, ...(username ? { username, credential } : {}) });
  }
  for (const server of servers) for (const url of server.urls) if (!/^(stun|turn|turns):/.test(url)) throw new Error(`Invalid ICE server URL ${url}: it must start with stun:, turn: or turns:.`);
  return servers;
}

// Answers a view's offer for `viewer`. Resolves with the answer SDP once ICE gathering is done (no
// trickle). Frames then flow on the media channel as fast as the viewer's credit allows; control
// messages are { type: 'ack', seq } | { type: 'keyframe' } | { type: 'input', ...screen_input args }.
export async function answer(viewer, sdp, { onInput, servers = iceServers() } = {}) {
  if (typeof sdp !== 'string' || !sdp.length || sdp.length > 64 * 1024) throw new Error('Invalid offer.');
  const { RTCPeerConnection } = await import('werift');
  // One peer per viewer: a new offer replaces the previous peer.
  await viewer.rtc?.close();
  const pc = new RTCPeerConnection({ iceServers: servers });
  let media, control, closing, sending = false;
  const subscriptions = [];
  const close = () => {
    if (closing) return closing;
    clearTimeout(expiry);
    for (const unsubscribe of subscriptions) unsubscribe();
    // Frames still on the closed channel never arrive: the view goes on over tool calls from a key frame.
    if (viewer.rtc?.close === close) {
      if (viewer.rtc.started) viewer.flow.resync();
      viewer.rtc = undefined;
    }
    closing = pc.close().catch(() => {});
    return closing;
  };
  const expiry = setTimeout(close, OPEN_TIMEOUT_MS);
  expiry.unref?.();
  const sendControl = value => { if (control?.readyState === 'open' && control.bufferedAmount < 128 * 1024) { try { control.send(JSON.stringify(value)); } catch { void close(); } } };

  // Sends what the viewer's flow allows, until nothing is left or the channel is full.
  const pump = async () => {
    if (sending || closing) return;
    sending = true;
    try {
      while (!closing && !viewer.closed && media?.readyState === 'open') {
        if (viewer.hub.failed.has(viewer.codec)) { sendControl({ type: 'codec-failed', error: viewer.hub.failed.get(viewer.codec) }); break; }
        const { frames, discontinuity } = viewer.take();
        if (!frames.length) break;
        if (discontinuity) sendControl({ type: 'discontinuity' });
        for (const frame of frames) {
          for (const chunk of chunks(packet(viewer.codec, frame))) {
            while (media.bufferedAmount > BUFFERED_HIGH) {
              if (closing || media.readyState !== 'open') return;
              await media.bufferedAmountLow.asPromise(5000).catch(() => {});
            }
            media.send(chunk);
          }
        }
      }
    } catch { void close(); }
    finally { sending = false; }
  };
  const start = () => {
    if (media?.readyState !== 'open' || control?.readyState !== 'open' || viewer.rtc?.close === close && viewer.rtc.started) return;
    clearTimeout(expiry);
    viewer.rtc = { close, pump, started: true };
    sendControl({ type: 'ready', ...viewer.describe() });
    void pump();
  };

  subscriptions.push(pc.onDataChannel.subscribe(channel => {
    if (!['media', 'control'].includes(channel.label) || !channel.ordered || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) return void close();
    if (channel.label === 'media') {
      if (media) return void close();
      media = channel; media.bufferedAmountLowThreshold = 128 * 1024;
      subscriptions.push(channel.onMessage.subscribe(() => void close()).unSubscribe);
    } else {
      if (control) return void close();
      control = channel;
      subscriptions.push(channel.onMessage.subscribe(message => {
        if (typeof message !== 'string' || message.length > 64 * 1024) return void close();
        let value;
        try { value = JSON.parse(message); } catch { return void close(); }
        viewer.renew();
        if (value?.type === 'ack') { viewer.flow.acknowledge(value.seq, performance.now()); void pump(); }
        else if (value?.type === 'keyframe') { viewer.flow.resync(); viewer.hub.requestKeyframe(viewer.codec); }
        else if (value?.type === 'input' && onInput) {
          const { type: _type, id, ...args } = value;
          onInput(args).then(result => sendControl({ type: 'input-result', id, ...result }), error => sendControl({ type: 'input-result', id, isError: true, error: error.message }));
        } else if (value?.type !== 'ping') return void close();
      }).unSubscribe);
    }
    subscriptions.push(channel.stateChanged.subscribe(state => { if (state === 'open') start(); if (state === 'closed') void close(); }).unSubscribe);
    start();
  }).unSubscribe);
  subscriptions.push(pc.connectionStateChange.subscribe(state => { if (['failed', 'closed', 'disconnected'].includes(state)) void close(); }).unSubscribe);
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    if (!pc.localDescription) throw new Error('No answer.');
    viewer.rtc = { close, pump, started: false };
    return { sdp: pc.localDescription.sdp, close };
  } catch (error) { await close(); throw error; }
}

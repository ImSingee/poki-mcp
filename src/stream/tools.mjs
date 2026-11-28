// The live screen's tools. show_screen is for the model and the view; the screen_* tools are for
// the screen view only (ui.visibility ["app"]). None of them waits in a device's queue: a view
// polling for frames must not stall behind an agent's long batch. screen_input still goes through
// the device's lease and input lock, so a person's tap never lands in the middle of the agent's input.
import { screens as defaultScreens } from './hub.mjs';
import { randomBytes } from 'node:crypto';
import { iceServers, answer } from './rtc.mjs';
import { nativeRequest } from '../remote.mjs';
import { work } from '../work.mjs';
export { screenTools, screenDefinitions, screenToolMeta, INPUT_WAIT_MS, TAKEOVER_TTL_SECONDS, TAKEOVER_TOKEN_MS } from './catalog.mjs';
import { INPUT_WAIT_MS, TAKEOVER_TTL_SECONDS, TAKEOVER_TOKEN_MS, screenDefinitions } from './catalog.mjs';

// A gesture from the WebRTC control channel is checked like a screen_input call.
const inputSchema = screenDefinitions.find(([name]) => name === 'screen_input')[2];
// Gestures queued on one viewer's control channel beyond this are refused, not kept.
const MAX_QUEUED_INPUT = 16;

// Lease checks made outside the calling tool's operation. Coordination.access records the device on
// the current operation, and a screen tool's operation deliberately names no device: recorded, it
// would count as another owner's work on the device, and a takeover would refuse itself.
const outsideCall = fn => work.run(undefined, fn);

const result = (value, summary) => ({ content: [{ type: 'text', text: summary ?? JSON.stringify(value) }], structuredContent: value });
const failure = (error, extra = {}) => ({ isError: true, content: [{ type: 'text', text: error }], structuredContent: { error, ...extra } });

// Who holds a device while a view has taken it over: an owner of its own, so the agent's session,
// which may be the very session the view's calls arrive on, is kept off.
class ViewerOwner {
  endings = new Set(); stoppedAt = new Map(); queues = new Map(); backgroundDevices = new Map();
  constructor(viewer) {
    this.label = `screen view ${viewer.id.slice(0, 8)}`;
    // What another session is told when it tries the device (Coordination.access).
    this.holdNotice = `Device is occupied: a person took over ${viewer.device} in the screen panel. Calls on it are refused until they close the panel (or it stays hidden); ask the user before trying again.`;
  }
  async cleanup() { return { recordings: [], locations: [] }; }
}

// A takeover token, given with a gesture refused because the agent holds the device: only a person
// who tried to use the panel, and then confirms, can take the device over.
function issueToken(viewer) {
  const now = performance.now();
  viewer.takeoverTokens ??= new Map();
  for (const [token, expires] of viewer.takeoverTokens) if (expires <= now) viewer.takeoverTokens.delete(token);
  const token = randomBytes(24).toString('base64url');
  viewer.takeoverTokens.set(token, now + TAKEOVER_TOKEN_MS);
  return token;
}
const busy = (viewer, error) => failure(error, { reason: 'busy', takeover_token: issueToken(viewer) });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const point = value => Math.round(clamp(value ?? 0.5, 0, 1) * 65535);
const BUTTONS = { home: 'home', lock: 'lock', volume_up: 'volume-up', volume_down: 'volume-down' };
const KEYS = new Set(['return', 'backspace', 'tab', 'escape', 'left', 'right', 'up', 'down', 'forward_delete', 'home', 'end', 'space']);

// The native request a view gesture becomes.
export function nativeInput(args) {
  const duration = args.t_ms;
  switch (args.kind) {
    case 'tap': return { op: 'tap', x: point(args.x), y: point(args.y), duration_ms: 50 };
    case 'long_press': return { op: 'long_press', x: point(args.x), y: point(args.y), duration_ms: Math.round(clamp(duration ?? 600, 500, 5000)) };
    case 'swipe': case 'drag': {
      if (args.x2 === undefined || args.y2 === undefined) throw new Error(`${args.kind} needs x2 and y2.`);
      return { op: 'drag', x1: point(args.x), y1: point(args.y), x2: point(args.x2), y2: point(args.y2), duration_ms: Math.round(clamp(duration ?? 300, args.kind === 'swipe' ? 60 : 200, 5000)) };
    }
    case 'pinch': {
      if (args.start_distance === undefined || args.end_distance === undefined) throw new Error('pinch needs start_distance and end_distance.');
      return { op: 'pinch', x: point(args.x), y: point(args.y), start_distance: clamp(args.start_distance, 0.02, 1.42) * 65535, end_distance: clamp(args.end_distance, 0.02, 1.42) * 65535, angle: args.angle ?? 0, duration_ms: Math.round(clamp(duration ?? 400, 150, 5000)) };
    }
    case 'button': {
      const button = BUTTONS[args.button];
      if (!button) throw new Error('button needs home, lock, volume_up or volume_down.');
      return { op: 'button', button };
    }
    case 'key': {
      const key = args.key?.toLowerCase();
      if (!key || !(KEYS.has(key) || /^[a-z0-9]$/.test(key))) throw new Error(`Unsupported key ${args.key}.`);
      return { op: 'key', key, modifiers: args.modifiers ?? [] };
    }
    case 'text': {
      if (!args.text) throw new Error('text needs text.');
      // Plain ASCII goes as key presses; anything else through the pasteboard.
      return /^[\x20-\x7e\n\t]*$/.test(args.text) ? { op: 'type_keys', text: args.text } : { op: 'type_text', text: args.text };
    }
  }
  throw new Error(`Unknown input kind ${args.kind}.`);
}

// One gesture from a view. Refused, with reason "busy", while another session holds the device's
// lease or its input lock for longer than INPUT_WAIT_MS: the view then offers to take over.
export async function screenInput(session, viewer, args, { signal, native = nativeRequest } = {}) {
  const coordinator = session.coordinator, target = viewer.hub.target;
  const request = nativeInput(args);
  // A person is using the panel: it is not idle.
  viewer.inputAt = performance.now();
  const taken = viewer.takeover && coordinator.leases.get(target.id)?.lease_id === viewer.takeover.lease_id;
  const owner = taken ? viewer.owner : session;
  // The view's calls may come on the agent's own MCP session (one stdio connection): a lease the
  // agent took on that session must still need a takeover. Only the view's own lease lets it in.
  const foreignLease = () => { const lease = coordinator.leases.get(target.id); return lease && lease.owner !== viewer.owner; };
  if (foreignLease()) return busy(viewer, 'The agent is using this iPhone (it holds the device). Take over to control it from here.');
  try { outsideCall(() => coordinator.access(owner, target)); }
  catch { return busy(viewer, 'The agent is using this iPhone (it holds the device). Take over to control it from here.'); }
  // Work on the device from here on, waiting for the lock included: cancel_device, a takeover or a
  // lease expiry stops it (the tool call's own operation names no device). While it only waits, a
  // lease may still be taken (the gesture is then refused below); once it holds the lock, none is.
  const dispatch = { owner, devices: new Set([target.id]), controller: new AbortController(), timings: [], yieldsToLease: true };
  let finished;
  dispatch.done = new Promise(resolve => { finished = resolve; });
  coordinator.operations.add(dispatch);
  const stop = signal ? AbortSignal.any([signal, dispatch.controller.signal]) : dispatch.controller.signal;
  try {
    let release;
    try { release = await coordinator.inputLock.acquire([target.id], { session: owner.label, tool: 'screen_input' }, stop, { waitMs: INPUT_WAIT_MS }); }
    catch (error) {
      if (dispatch.controller.signal.aborted) return failure('The gesture was stopped before it reached the iPhone.', { reason: 'stopped' });
      if (error.name !== 'InputLockTimeout') throw error;
      return busy(viewer, `The agent is using this iPhone right now. ${error.message.replace(/ Waited.*$/, '')} Take over to control it from here.`);
    }
    dispatch.yieldsToLease = false;
    try {
      // The panel closed (or another iPhone was chosen) while this gesture waited: it is not sent.
      if (viewer.closed) return failure('This screen stream has ended. Open it again.', { reason: 'stream_closed' });
      if (foreignLease()) return busy(viewer, 'The agent is using this iPhone (it holds the device). Take over to control it from here.');
      try { outsideCall(() => coordinator.access(owner, target)); }
      catch { return busy(viewer, 'The agent is using this iPhone (it holds the device). Take over to control it from here.'); }
      if (taken) coordinator.renew(viewer.owner, viewer.takeover.lease_id, TAKEOVER_TTL_SECONDS);
      const reply = await work.run({ signal: stop, timings: [] }, () => native(target, request));
      coordinator.changed(target.id);
      if (reply?.isError) return failure(reply.error ?? 'The input was not sent.', { outcome: reply.outcome });
      return result({ sent: reply?.sent !== false, kind: args.kind });
    } finally { release(); }
  } finally { coordinator.operations.delete(dispatch); finished(); }
}

// Stops every other session's work and lease on the device, then holds it for the view while its
// stream lasts. Needs a token from a refused gesture (so a person tried to use the panel) and the
// approval of approve(target): in ask mode a dialog on this computer, in host mode the client's own.
export async function takeOver(session, viewer, { token, approve } = {}) {
  const coordinator = session.coordinator, target = viewer.hub.target;
  const expires = viewer.takeoverTokens?.get(token);
  if (!token || expires === undefined || expires <= performance.now()) return failure('screen_takeover needs the takeover_token of a gesture the agent refused in the last two minutes: try the gesture in the panel first.', { reason: 'no_token' });
  viewer.takeoverTokens.delete(token);
  if (approve) {
    const approval = await approve(target);
    if (approval?.refused) return failure(approval.message ?? 'The takeover was not approved.', { reason: 'not_approved', ...approval.detail });
  }
  if (viewer.closed) return failure('The screen panel closed before the takeover was approved.', { reason: 'stream_closed' });
  viewer.inputAt = performance.now();
  viewer.owner ??= new ViewerOwner(viewer);
  // acquire() checks every session's background work on the device, as it does for any lease.
  viewer.owner.peers = () => session.peers?.() ?? [session];
  const owners = new Set([...coordinator.operations].filter(op => op.devices.has(target.id) && op.owner !== viewer.owner).map(op => op.owner));
  // A recording or simulated location runs on without a call in flight or a lease: it stops too.
  for (const peer of viewer.owner.peers()) if (peer !== viewer.owner && peer.backgroundDevices?.has(target.id)) owners.add(peer);
  const lease = coordinator.leases.get(target.id);
  if (lease && lease.owner !== viewer.owner) owners.add(lease.owner);
  await Promise.all([...owners].map(owner => coordinator.end(owner, 'taken_over', [target.id])));
  // The panel may have closed while the agent's work was stopping: no lease for a gone viewer.
  if (viewer.closed) return failure('The screen panel closed before the takeover finished; the agent\'s work was stopped, and the iPhone is free.', { reason: 'stream_closed' });
  // Release on close is in place before the lease exists.
  if (!viewer.releasesTakeover) {
    viewer.releasesTakeover = true;
    const end = viewer.close.bind(viewer);
    // Whatever the close carries (a disconnect's reason) goes through to the viewer.
    viewer.close = (...reason) => { if (viewer.takeover) void coordinator.end(viewer.owner, 'released', [target.id]).catch(() => {}); viewer.takeover = undefined; end(...reason); };
    // Held while the view keeps its stream (reads, WebRTC messages), renewed at most every few
    // seconds: a panel open and shown keeps the device, a closed or hidden one lets it go.
    let renewedAt = 0;
    viewer.onRenew = now => {
      if (!viewer.takeover || now - renewedAt < 5000) return;
      renewedAt = now;
      try { coordinator.renew(viewer.owner, viewer.takeover.lease_id, TAKEOVER_TTL_SECONDS); } catch { viewer.takeover = undefined; }
    };
  }
  if (coordinator.leases.get(target.id)?.owner !== viewer.owner) viewer.takeover = await outsideCall(() => coordinator.acquire(viewer.owner, target, TAKEOVER_TTL_SECONDS));
  return result({ taken_over: true, device: target.id, stopped_sessions: owners.size, expires_at: viewer.takeover.expires_at });
}

let rtcAvailable;
const weriftAvailable = () => rtcAvailable ??= import('werift').then(() => true, () => false);

// Runs one screen tool. `resolve(device)` gives a device's target; screen streams are for iPhones.
// approve(target): the takeover's approval (see takeOver).
export async function runScreenTool(session, name, args, { resolve, signal, screens = defaultScreens, native = nativeRequest, approve } = {}) {
  if (name === 'show_screen') {
    const device = args.device === undefined ? undefined : (await resolve(args.device)).id;
    return result({ ...(device ? { device } : {}), panel: 'ui://poki/screen' }, device ? `The live screen of ${device} is shown in the screen panel.` : 'The screen panel is open; the person chooses an iPhone there.');
  }
  if (name === 'screen_open') {
    const target = await resolve(args.device);
    if (target.kind !== 'physical' || target.wda) return failure('The live screen is available for iPhones only.');
    try {
      const viewer = await screens.open(target, { codecs: args.codecs, signal, reconnect: args.reconnect === true });
      return result({ ...viewer.describe(), rtc: (await weriftAvailable()) && process.env.POKI_SCREEN_RTC !== '0' });
    } catch (error) { return failure(error.message, error.reason ? { reason: error.reason } : {}); }
  }
  let viewer;
  try { viewer = screens.get(args.stream); }
  catch (error) { return failure(error.message, { reason: error.code ?? 'stream_closed' }); }
  switch (name) {
    case 'screen_read': {
      const reply = await viewer.read(args, signal);
      return result(reply, `${reply.frames.length} frame(s)`);
    }
    case 'screen_close': viewer.close(); return result({ closed: true });
    case 'screen_keyframe': viewer.flow.resync(); return result({ requested: viewer.hub.requestKeyframe(viewer.codec) });
    case 'screen_input': return screenInput(session, viewer, args, { signal, native });
    case 'screen_takeover': return takeOver(session, viewer, { token: args.token, approve });
    case 'screen_rtc_config': {
      const enabled = (await weriftAvailable()) && process.env.POKI_SCREEN_RTC !== '0';
      return result({ enabled, ...(enabled ? { ice_servers: iceServers(process.env, Date.now(), { label: `poki-${viewer.id.slice(0, 8)}` }) } : {}) });
    }
    case 'screen_rtc_offer': {
      if (!(await weriftAvailable())) return failure('WebRTC is not available on this computer.');
      const { sdp } = await answer(viewer, args.sdp, { onInput: input => rtcInput(session, viewer, input, native) });
      return result({ sdp }, 'answer');
    }
  }
  throw new Error(`Unknown screen tool ${name}.`);
}

// A gesture from the view's WebRTC control channel: checked with screen_input's schema and run one
// at a time per viewer, in the order sent, as the view's screen_input calls are.
function rtcInput(session, viewer, input, native) {
  const parsed = inputSchema.safeParse({ ...input, stream: viewer.id });
  if (!parsed.success) return Promise.resolve({ isError: true, error: `Invalid input: ${parsed.error.issues.map(i => i.message).join('; ')}` });
  if ((viewer.inputQueued ?? 0) >= MAX_QUEUED_INPUT) return Promise.resolve({ isError: true, error: 'Too many gestures are waiting to be sent.', reason: 'busy' });
  viewer.inputQueued = (viewer.inputQueued ?? 0) + 1;
  // A gesture still queued when the device's work is stopped (cancel_device, a takeover, an unpair)
  // is not sent afterwards: it counts as received work of the session, as an accepted call does.
  const received = performance.now(), device = viewer.device;
  const stopped = () => [session, viewer.owner].some(owner => [owner?.stoppedAt?.get(device), owner?.stoppedAt?.get('*')].some(stop => stop && stop.at >= received));
  const run = () => stopped()
    ? { isError: true, error: 'The gesture was stopped before it reached the iPhone.', reason: 'stopped' }
    : screenInput(session, viewer, parsed.data, { native }).then(r => ({ ...r.structuredContent, ...(r.isError ? { isError: true } : {}) }));
  const next = (viewer.inputChain ?? Promise.resolve()).then(run, run);
  viewer.inputChain = next.catch(() => {}).finally(() => { viewer.inputQueued--; });
  return next;
}

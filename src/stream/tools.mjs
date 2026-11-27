// The live screen's tools. show_screen is for the model and the view; the screen_* tools are for
// the screen view only (ui.visibility ["app"]). None of them waits in a device's queue: a view
// polling for frames must not stall behind an agent's long batch. screen_input still goes through
// the device's lease and input lock, so a person's tap never lands in the middle of the agent's input.
import { screens as defaultScreens } from './hub.mjs';
import { iceServers, answer } from './rtc.mjs';
import { nativeRequest } from '../remote.mjs';
import { work } from '../work.mjs';
export { screenTools, screenDefinitions, screenToolMeta, INPUT_WAIT_MS, TAKEOVER_TTL_SECONDS } from './catalog.mjs';
import { INPUT_WAIT_MS, TAKEOVER_TTL_SECONDS } from './catalog.mjs';

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
  constructor(viewer) { this.label = `screen view ${viewer.id.slice(0, 8)}`; }
  async cleanup() { return { recordings: [], locations: [] }; }
}

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
      return { op: 'pinch', x: point(args.x), y: point(args.y), start_distance: clamp(args.start_distance, 0.02, 1) * 65535, end_distance: clamp(args.end_distance, 0.02, 1) * 65535, duration_ms: Math.round(clamp(duration ?? 400, 150, 5000)) };
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
  const taken = viewer.takeover && coordinator.leases.get(target.id)?.lease_id === viewer.takeover.lease_id;
  const owner = taken ? viewer.owner : session;
  try { outsideCall(() => coordinator.access(owner, target)); }
  catch { return failure('The agent is using this iPhone (it holds the device). Take over to control it from here.', { reason: 'busy' }); }
  let release;
  try { release = await coordinator.inputLock.acquire([target.id], { session: owner.label, tool: 'screen_input' }, signal, { waitMs: INPUT_WAIT_MS }); }
  catch (error) {
    if (error.name !== 'InputLockTimeout') throw error;
    return failure(`The agent is using this iPhone right now. ${error.message.replace(/ Waited.*$/, '')} Take over to control it from here.`, { reason: 'busy' });
  }
  // Recorded as work on the device while it is sent, so no lease can be taken from under it.
  const dispatch = { owner, devices: new Set([target.id]), controller: new AbortController(), timings: [] };
  try {
    // Someone may have taken the device's lease while this gesture waited for the lock.
    try { outsideCall(() => coordinator.access(owner, target)); }
    catch { return failure('The agent is using this iPhone (it holds the device). Take over to control it from here.', { reason: 'busy' }); }
    let finished;
    dispatch.done = new Promise(resolve => { finished = resolve; });
    coordinator.operations.add(dispatch);
    try {
      if (taken) coordinator.renew(viewer.owner, viewer.takeover.lease_id, TAKEOVER_TTL_SECONDS);
      const reply = await native(target, request);
      coordinator.changed(target.id);
      if (reply?.isError) return failure(reply.error ?? 'The input was not sent.', { outcome: reply.outcome });
      return result({ sent: reply?.sent !== false, kind: args.kind });
    } finally { coordinator.operations.delete(dispatch); finished(); }
  } finally { release(); }
}

// Stops every other session's work and lease on the device, then holds it for the view.
export async function takeOver(session, viewer) {
  const coordinator = session.coordinator, target = viewer.hub.target;
  viewer.owner ??= new ViewerOwner(viewer);
  const owners = new Set([...coordinator.operations].filter(op => op.devices.has(target.id) && op.owner !== viewer.owner).map(op => op.owner));
  const lease = coordinator.leases.get(target.id);
  if (lease && lease.owner !== viewer.owner) owners.add(lease.owner);
  await Promise.all([...owners].map(owner => coordinator.end(owner, 'taken_over', [target.id])));
  if (coordinator.leases.get(target.id)?.owner !== viewer.owner) viewer.takeover = await outsideCall(() => coordinator.acquire(viewer.owner, target, TAKEOVER_TTL_SECONDS));
  const end = viewer.close.bind(viewer);
  viewer.close = () => { if (viewer.takeover) void coordinator.end(viewer.owner, 'released', [target.id]).catch(() => {}); viewer.takeover = undefined; end(); };
  return result({ taken_over: true, device: target.id, stopped_sessions: owners.size, expires_at: viewer.takeover.expires_at });
}

let rtcAvailable;
const weriftAvailable = () => rtcAvailable ??= import('werift').then(() => true, () => false);

// Runs one screen tool. `resolve(device)` gives a device's target; screen streams are for iPhones.
export async function runScreenTool(session, name, args, { resolve, signal, screens = defaultScreens, native = nativeRequest } = {}) {
  if (name === 'show_screen') {
    const device = args.device === undefined ? undefined : (await resolve(args.device)).id;
    return result({ ...(device ? { device } : {}), panel: 'ui://poki/screen' }, device ? `The live screen of ${device} is shown in the screen panel.` : 'The screen panel is open; the person chooses an iPhone there.');
  }
  if (name === 'screen_open') {
    const target = await resolve(args.device);
    if (target.kind !== 'physical' || target.wda) return failure('The live screen is available for iPhones only.');
    try {
      const viewer = await screens.open(target, { codecs: args.codecs, signal });
      return result({ ...viewer.describe(), rtc: (await weriftAvailable()) && process.env.POKI_SCREEN_RTC !== '0' });
    } catch (error) { return failure(error.message, error.reason ? { reason: error.reason } : {}); }
  }
  let viewer;
  try { viewer = screens.get(args.stream); }
  catch (error) { return failure(error.message, { reason: 'stream_closed' }); }
  switch (name) {
    case 'screen_read': {
      const reply = await viewer.read(args, signal);
      return result(reply, `${reply.frames.length} frame(s)`);
    }
    case 'screen_close': viewer.close(); return result({ closed: true });
    case 'screen_keyframe': viewer.flow.resync(); return result({ requested: viewer.hub.requestKeyframe(viewer.codec) });
    case 'screen_input': return screenInput(session, viewer, args, { signal, native });
    case 'screen_takeover': return takeOver(session, viewer);
    case 'screen_rtc_config': {
      const enabled = (await weriftAvailable()) && process.env.POKI_SCREEN_RTC !== '0';
      return result({ enabled, ...(enabled ? { ice_servers: iceServers() } : {}) });
    }
    case 'screen_rtc_offer': {
      if (!(await weriftAvailable())) return failure('WebRTC is not available on this computer.');
      const { sdp } = await answer(viewer, args.sdp, { onInput: input => screenInput(session, viewer, { ...input, stream: viewer.id }, { native }).then(r => r.structuredContent ?? {}) });
      return result({ sdp }, 'answer');
    }
  }
  throw new Error(`Unknown screen tool ${name}.`);
}

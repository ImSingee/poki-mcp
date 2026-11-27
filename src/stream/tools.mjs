// The live screen's tools. show_screen is for the model and the view; the screen_* tools are for
// the screen view only (ui.visibility ["app"]). None of them waits in a device's queue: a view
// polling for frames must not stall behind an agent's long batch. screen_input still goes through
// the device's lease and input lock, so a person's tap never lands in the middle of the agent's input.
import { z } from 'zod';
import { screens, CODECS } from './hub.mjs';
import { iceServers, answer } from './rtc.mjs';
import { nativeRequest } from '../remote.mjs';

export const screenTools = new Set(['show_screen', 'screen_open', 'screen_read', 'screen_close', 'screen_keyframe', 'screen_input', 'screen_takeover', 'screen_rtc_config', 'screen_rtc_offer']);
// How long a screen_input waits for the device's input lock before telling the view the agent is busy.
export const INPUT_WAIT_MS = 1500;
// A takeover's lease, renewed by each input from the view.
export const TAKEOVER_TTL_SECONDS = 60;

const stream = z.string().min(1).max(64).describe('The stream id screen_open returned.');
const unit = z.number().min(0).max(1);
export const screenDefinitions = [
  ['show_screen', 'Show the live screen of a paired iPhone in a panel where the person can watch it and tap, swipe and type on it. Clients with MCP Apps open the panel; the screen video keeps the iPhone\'s camera and microphone busy while it is shown. Pass device to choose the iPhone; without it the panel lets the person choose.', z.object({ device: z.string().min(1).optional().describe('The iPhone to show: its id from list_devices.') }), true],
  ['screen_open', 'Start a live screen stream of a device for the screen view. codecs lists what the view can decode, most preferred first (hevc, h264, jpeg); the reply names the codec chosen.', z.object({ device: z.string().min(1), codecs: z.array(z.enum(CODECS)).min(1).max(3).optional() }), true],
  ['screen_read', 'The screen view\'s next frames (long poll). ack is the last frame decoded, which returns credit; wait_ms is at most 1000.', z.object({ stream, cursor: z.number().int().min(0).optional(), ack: z.number().int().min(0).optional(), credit: z.number().int().min(1).max(64).optional(), wait_ms: z.number().int().min(0).max(1000).optional(), resync: z.boolean().optional(), max_bytes: z.number().int().min(16384).max(4194304).optional() }), true],
  ['screen_close', 'End a screen stream. The iPhone\'s camera and microphone are released when no stream of it remains.', z.object({ stream }), false],
  ['screen_keyframe', 'Ask for a key frame on a screen stream (at most once a second).', z.object({ stream }), false],
  ['screen_input', 'One gesture or key from the screen view, at coordinates normalized to the screen (0..1), sent through the device\'s lease and input lock.', z.object({
    stream, kind: z.enum(['tap', 'long_press', 'swipe', 'drag', 'pinch', 'button', 'key', 'text']),
    x: unit.optional(), y: unit.optional(), x2: unit.optional(), y2: unit.optional(), t_ms: z.number().min(0).max(10000).optional(),
    start_distance: unit.optional(), end_distance: unit.optional(),
    button: z.enum(['home', 'lock', 'volume_up', 'volume_down']).optional(), key: z.string().min(1).max(20).optional(),
    modifiers: z.array(z.enum(['command', 'control', 'option', 'shift'])).max(4).optional(), text: z.string().min(1).max(2000).optional(),
  }), false],
  ['screen_takeover', 'Take the device from the agent for the screen view, after the person confirmed it: stops the agent\'s work on this device and holds it for the view.', z.object({ stream, confirm: z.literal(true) }), false],
  ['screen_rtc_config', 'Whether a screen stream can use WebRTC, and the ICE servers to use.', z.object({ stream }), true],
  ['screen_rtc_offer', 'Answer the screen view\'s WebRTC offer (complete, without trickle ICE).', z.object({ stream, sdp: z.string().min(1).max(65536) }), false],
];

// _meta for the PR2 view registry: show_screen opens the panel (LobeHub's side panel), the rest are
// for the view only.
export const screenToolMeta = {
  show_screen: { ui: { resourceUri: 'ui://poki/screen', visibility: ['model', 'app'] }, 'ui/resourceUri': 'ui://poki/screen', 'lobehub/ui': { preferredModelDisplayMode: 'fullscreen' } },
  ...Object.fromEntries([...screenTools].filter(name => name !== 'show_screen').map(name => [name, { ui: { visibility: ['app'] } }])),
};

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
  try { coordinator.access(owner, target); }
  catch { return failure('The agent is using this iPhone (it holds the device). Take over to control it from here.', { reason: 'busy' }); }
  let release;
  try { release = await coordinator.inputLock.acquire([target.id], { session: owner.label, tool: 'screen_input' }, signal, { waitMs: INPUT_WAIT_MS }); }
  catch (error) {
    if (error.name !== 'InputLockTimeout') throw error;
    return failure(`The agent is using this iPhone right now. ${error.message.replace(/ Waited.*$/, '')} Take over to control it from here.`, { reason: 'busy' });
  }
  try {
    if (taken) coordinator.renew(viewer.owner, viewer.takeover.lease_id, TAKEOVER_TTL_SECONDS);
    const reply = await native(target, request);
    coordinator.changed(target.id);
    if (reply?.isError) return failure(reply.error ?? 'The input was not sent.', { outcome: reply.outcome });
    return result({ sent: reply?.sent !== false, kind: args.kind });
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
  if (coordinator.leases.get(target.id)?.owner !== viewer.owner) viewer.takeover = await coordinator.acquire(viewer.owner, target, TAKEOVER_TTL_SECONDS);
  const end = viewer.close.bind(viewer);
  viewer.close = () => { if (viewer.takeover) void coordinator.end(viewer.owner, 'released', [target.id]).catch(() => {}); viewer.takeover = undefined; end(); };
  return result({ taken_over: true, device: target.id, stopped_sessions: owners.size, expires_at: viewer.takeover.expires_at });
}

let rtcAvailable;
const weriftAvailable = () => rtcAvailable ??= import('werift').then(() => true, () => false);

// Runs one screen tool. `resolve(device)` gives a device's target; screen streams are for iPhones.
export async function runScreenTool(session, name, args, { resolve, signal } = {}) {
  if (name === 'show_screen') {
    const device = args.device === undefined ? undefined : (await resolve(args.device)).id;
    return result({ ...(device ? { device } : {}), panel: 'ui://poki/screen' }, device ? `The live screen of ${device} is shown in the screen panel.` : 'The screen panel is open; the person chooses an iPhone there.');
  }
  if (name === 'screen_open') {
    const target = await resolve(args.device);
    if (target.kind !== 'physical' || target.wda) return failure('The live screen is available for iPhones only.');
    try {
      const viewer = await screens.open(target, { codecs: args.codecs });
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
    case 'screen_input': return screenInput(session, viewer, args, { signal });
    case 'screen_takeover': return takeOver(session, viewer);
    case 'screen_rtc_config': {
      const enabled = (await weriftAvailable()) && process.env.POKI_SCREEN_RTC !== '0';
      return result({ enabled, ...(enabled ? { ice_servers: iceServers() } : {}) });
    }
    case 'screen_rtc_offer': {
      if (!(await weriftAvailable())) return failure('WebRTC is not available on this computer.');
      const { sdp } = await answer(viewer, args.sdp, { onInput: input => screenInput(session, viewer, { ...input, stream: viewer.id }).then(r => r.structuredContent ?? {}) });
      return result({ sdp }, 'answer');
    }
  }
  throw new Error(`Unknown screen tool ${name}.`);
}

// The screen tools' names, schemas and MCP Apps _meta. Loaded by every stdio process to answer
// tools/list, so it imports nothing but zod; the tools themselves are in tools.mjs.
import { z } from 'zod';

const CODECS = ['hevc', 'h264', 'jpeg'];
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


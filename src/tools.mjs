import * as cua from './cua.mjs';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { version } from './build-info.mjs';
import { views, toolMeta, readView, RESOURCE_MIME_TYPE } from './views/index.mjs';
import { screenTools, screenDefinitions } from './stream/catalog.mjs';

const catalog = JSON.parse(readFileSync(new URL('./data/tools.json', import.meta.url), 'utf8'));
const defaultTools = new Set([
  'poki_mcp_status', 'list_devices', 'list_elements', 'take_screenshot',
  'get_foreground_app', 'launch_app', 'open_url', 'tap', 'tap_text', 'fill', 'type_text',
  'scroll', 'swipe', 'press_key', 'go_back', 'wait_for', 'handle_alert', 'batch_commands',
  'long_press', 'double_tap', 'drag', 'hide_keyboard', 'press_button',
  'scroll_to', 'terminate_app', 'pinch', 'list_apps', 'get_clipboard',
]);
const instructions = 'When the request already says what to do on the device, use batch_commands for launch_app and steps whose targets are already known; use fill without field for a single visible input, and use exact observed labels when a selector is needed; it is usually the only device call needed. Tapping steps wait for their target, and the reply ends with the visible text. Every device tool takes device: call list_devices once and pass the id it reports (its default when it names one) on every call. Calls to different devices may run at the same time; calls to one device run in the order sent. Consecutive calls do not require an explicit device lease. Single-step tools remain for exploring an unknown screen.';
// The tools that need approval before they run (approvedTools). Their annotations let an MCP client
// ask instead of Poki, which is how POKI_MCP_APPROVAL_MODE=host works. They are set in every mode, so
// tools/list does not depend on which process answers it. get_clipboard reads, but what it reads
// leaves the device, so a client that runs read-only tools without asking must not take it as one.
export const approvalHints = {
  install_app: { destructiveHint: true, openWorldHint: false },
  uninstall_app: { destructiveHint: true, openWorldHint: false },
  build_and_run: { destructiveHint: true, openWorldHint: false },
  open_url: { destructiveHint: true, openWorldHint: true },
  download_app_container: { destructiveHint: false, openWorldHint: true },
  get_clipboard: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  set_clipboard: { destructiveHint: true, openWorldHint: true },
  // Deletes a saved pairing and stops every session's work on that phone.
  unpair_device: { destructiveHint: true, openWorldHint: false },
};
export const approvedTools = new Set(Object.keys(approvalHints));
// In host mode only the client approves, and it sees only the tool it is asked about. A gated tool
// inside batch_commands or run_code would run under the wrapper's approval, so there it is refused.
export const hostGated = (tool, mode) => mode === 'host' && approvedTools.has(tool)
  ? `${tool} needs approval, and in host approval mode the MCP client gives it. Inside batch_commands or run_code the client would not be asked, so it does not run there: call ${tool} on its own.`
  : null;
const readOnly = new Set(['observe_device','list_devices', 'get_device_info', 'take_screenshot', 'get_foreground_app', 'list_elements', 'list_apps', 'get_clipboard', 'list_crashes', 'get_crash', 'wait_for', 'wait']);
const guidance = {
  acquire_device: 'Only needed to keep other sessions off a device across several calls. One batch_commands call already runs without interruption, so a single-call task needs no lease. If you take one, keep the returned lease_id, renew before expiry, then release.',
  wait_for: 'The timeout covers device capture, AX, OCR and polling. Success includes the matching observation and its image, so a second screenshot is not needed to inspect the matched state.',
  batch_commands: `Batch known operations. A single visible input can be filled without field. Field and button labels come from observed screen text, in its original language; guesses such as a translated Search label or an unobserved New Tab button require an observation first.

Example:
{"commands":[
  {"tool":"launch_app","arguments":{"bundle_id":"com.example.app"}},
  {"tool":"fill","arguments":{"text":"hello","submit":true}},
  {"tool":"tap_text","arguments":{"text":"Open"}},
  {"tool":"go_back","arguments":{}},
  {"tool":"tap_text","arguments":{"text":"Show Alert"}},
  {"tool":"handle_alert","arguments":{"button":"OK"}}
]}

Arguments of common steps: launch_app {bundle_id or name}; tap_text {text}; tap {x, y}; fill {text, field (optional when one text field is visible), submit}; type_text {text}; press_key {key, modifiers, count}; scroll {direction}; scroll_to {text, direction}; swipe {from_x, from_y, to_x, to_y}; go_back {}; handle_alert {button or action}; wait_for {text, gone, timeout_seconds}; wait {seconds}; take_screenshot {}. Use tool names without any client prefix.`,
  fill: 'Omit field when only one text input is visible. When selecting among fields, copy the exact observed label or use a current ref; field labels are not translated. Prefer fill over separate tap + type_text when the target field is known: it uses the field already being edited or taps it once, confirms that exact field before clearing anything, and reads the text back from it before any Return. When the field cannot be confirmed, nothing is typed. Use submit=true only when sending is already authorized; otherwise inspect the draft first.',
  type_text: 'Requires an already focused field. When the target field is known, use fill instead to avoid focus mistakes. To send text already entered, use press_key key=return; do not call type_text with empty text. text_verified confirms input only, not delivery.',
  press_key: 'Use key=return to submit existing text after it has been checked; do not re-enter the text. A sent result only confirms key dispatch, so verify the app result before reporting delivery.',
  touch_path: 'For a circle, make one touch_path call that goes once around and runs about 10 degrees past its first point, so the ends meet even when an app ignores the first few points of movement. Measure the center and radius in points from a current screenshot and keep the whole shape inside the drawing area. Give about one point every 10 to 16 ms; a circle drawn over 1500 ms with 120 points looks smooth. Do not build a circle from several drags or a few corner points. Inspect a screenshot afterwards, and do not erase or redraw automatically.',
  draw_strokes: 'Plan every letter before the call: nothing generates lettering for you. Write cursive or block letters as curves sampled about every 10 to 16 ms, one stroke per pen lift, left to right, sized from a current screenshot of the canvas. Use it only on a canvas that does not scroll or pan when touched; when the canvas or tool must be checked between strokes, use separate touch_path calls. Inspect a screenshot afterwards.',
  launch_app: 'On a simulator it returns once the app shows readable elements, and on a physical device once the app is in front; either way its text is in screen, so there is no need to look again. resumed=true means the app was already running and kept its state; use fresh=true to start it anew. If launch fails with CoreDeviceError 4016, inspect the current screen and use the observed Home Screen or app switcher controls. Avoid repeating the same failing launch until device conditions change.',
};
// JSON Schema cannot say that time_ms increases, so the parsed arguments are checked before any device is touched.
const checkStroke = (points, ctx, path) => {
  if (points[0].time_ms !== 0) ctx.addIssue({ code: 'custom', path: [...path, 0, 'time_ms'], message: 'time_ms of the first point must be 0.' });
  const back = points.findIndex((point, index) => index > 0 && point.time_ms <= points[index - 1].time_ms);
  if (back > 0) ctx.addIssue({ code: 'custom', path: [...path, back, 'time_ms'], message: `time_ms must increase at every point; point ${back} has ${points[back].time_ms} after ${points[back - 1].time_ms}.` });
};
const strokeChecks = {
  touch_path: (args, ctx) => checkStroke(args.points, ctx, ['points']),
  draw_strokes: (args, ctx) => {
    args.strokes.forEach((stroke, index) => checkStroke(stroke.points, ctx, ['strokes', index, 'points']));
    const total = args.strokes.reduce((sum, stroke) => sum + stroke.points.at(-1).time_ms, 0);
    if (total > 60000) ctx.addIssue({ code: 'custom', path: ['strokes'], message: `The strokes together must last at most 60000 ms; these last ${total} ms.` });
  },
};
// Additive observation arguments: legacy clients retain their existing schema
// behavior and the upstream stroke timing refinements are preserved.
const actionObservationTools = new Set(['tap', 'double_tap', 'long_press', 'tap_text', 'swipe',
  'drag', 'scroll', 'pinch', 'type_text', 'fill', 'press_key', 'press_button', 'go_back', 'handle_alert']);
// A batch step runs on its batch's device, so its schema has no device.
const withoutDevice = schema => {
  const { device: _device, ...properties } = schema.properties ?? {};
  return { ...schema, properties, ...(schema.required ? { required: schema.required.filter(name => name !== 'device') } : {}) };
};
const schemaOf = (tool, { step = false } = {}) => {
  tool = step ? { ...tool, inputSchema: withoutDevice(tool.inputSchema) } : tool;
  const schemaWithObservations = actionObservationTools.has(tool.name)
    ? { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
      return_observation: { type: 'boolean', description: 'Request a ref-bearing post-input observation when available.' },
      post_action_ocr: { type: 'boolean', description: 'Capture after stable AX and check image OCR prompts (default false).' } } }
    : tool.name === 'observe_device'
      ? { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
        include_image: { type: 'boolean', description: 'Attach PNG (default true); false retains capture and prompt checks.' } } }
      : tool.inputSchema;
  const schema = z.fromJSONSchema(schemaWithObservations);
  return strokeChecks[tool.name] ? schema.superRefine(strokeChecks[tool.name]) : schema;
};
export const definitions = catalog.tools.map(tool => [tool.name, [tool.description, guidance[tool.name]].filter(Boolean).join('\n\n'), schemaOf(tool), readOnly.has(tool.name)]);
// Built on first use: every stdio process imports this module, and most never run a batch.
const stepSchemas = new Map(catalog.tools.map(tool => [tool.name, () => schemaOf(tool, { step: true })]));
const device = z.string().min(1).describe('The device to act on: its id from list_devices (or its exact name).');
const extra = [
  ['disconnect_device', 'Close the device\'s remote connection and its local helper. Cellular reconnection may require returning the iPhone to Wi-Fi. Does not undo input.', z.object({ device }), false],
  ['reconnect_device', 'Re-establish the device\'s RemotePairing tunnel. Does not replay input. A new session may require Wi-Fi when iOS closes its remote pairing listener.', z.object({ device }), false],
  ['poki_mcp_status', 'Report Poki MCP version, current Git commit, native bridge build time, tool count, connected-device count, approval mode, and any available Poki update with release notes and the update command.', z.object({}), true],
  ['pair_device', 'Pair a new iPhone with this computer over Wi-Fi (iOS 27 or newer, same local network; no USB cable). Returns at once with a pairing job: the iPhone then shows "Pair with <name>" in Settings › Privacy & Security › Developer Mode, and a PIN appears in pairing_status for the person to type on the iPhone. After pairing, Poki installs the developer disk image over Wi-Fi, which input needs. Only one pairing runs at a time; a second call returns the running job. Clients with MCP Apps show a pairing view; otherwise relay the instruction and PIN from pairing_status to the person.', z.object({ name: z.string().trim().min(1).max(40).optional().describe('The name the iPhone shows for this computer. Defaults to its host name.'), device: z.string().min(1).optional().describe('An iPhone already paired over Wi-Fi: skip pairing and only install its developer disk image again (use it when list_devices reports display_service false for that device).') }), false],
  ['pairing_status', 'Report a pairing job from pair_device: its state (starting, advertising, pin, paired, registering, mounting_ddi, ready, failed, cancelled), the PIN to type on the iPhone while the state is pin, the paired device id once known, and for a failure its reason and the action to take. Poll it about every two seconds until terminal is true.', z.object({ job: z.string().min(1).describe('The job id pair_device returned.') }), true],
  ['pairing_cancel', 'Cancel a pairing job (for the pairing view). The iPhone stops offering this computer, and nothing is saved unless the iPhone had already paired.', z.object({ job: z.string().min(1) }), false],
  ['unpair_device', 'Remove a wirelessly paired (RemotePairing) iPhone from this computer: stops its pairing job, ends every session\'s work and leases on it, closes its connection and helper, and deletes its saved pairing. It disappears from list_devices at once. USB pairing is not changed. The reply says how to remove this computer on the iPhone too.', z.object({ device }), false],
];
// Pairing tools act on this computer's pairing state, not inside a device's queue (see unqueuedTools).
export const pairingTools = new Set(['pair_device', 'pairing_status', 'pairing_cancel', 'unpair_device']);
for (const definition of extra) { definitions.push(definition); if (!pairingTools.has(definition[0])) stepSchemas.set(definition[0], () => definition[0] === 'poki_mcp_status' ? definition[2] : z.object({})); }
// The live screen (src/stream): show_screen for the model, the screen_* tools for the screen view.
for (const definition of screenDefinitions) definitions.push(definition);
export { screenTools };

// The computer-use profile (POKI_TOOL_PROFILE=cua, cua.mjs): look and do, plus device and status tools.
for (const [name, description, schema, readOnlyHint] of cua.definitions) { definitions.push([name, description, z.fromJSONSchema(schema), readOnlyHint]); stepSchemas.set(name, () => z.fromJSONSchema(withoutDevice(schema))); }
// The arguments a tool takes once its device is known: inside a batch step, or after a call was routed to its device.
export const stepSchema = name => {
  const schema = stepSchemas.get(name);
  if (typeof schema !== 'function') return schema;
  const built = schema();
  stepSchemas.set(name, built);
  return built;
};
// Tools that act on no device (and so take none), and tools that name several.
export const sessionTools = new Set(['poki_mcp_status', 'list_devices']);
// Full annotations for the pairing tools. pair_device advertises this computer on the local network;
// unpair_device deletes a saved pairing.
const pairingHints = {
  pair_device: { title: 'Pair an iPhone over Wi-Fi', destructiveHint: false, idempotentHint: true, openWorldHint: true },
  pairing_status: { title: 'Pairing progress', destructiveHint: false, idempotentHint: true, openWorldHint: false },
  pairing_cancel: { title: 'Cancel pairing', destructiveHint: false, idempotentHint: true, openWorldHint: false },
  unpair_device: { title: 'Remove a wireless pairing', destructiveHint: true, idempotentHint: true, openWorldHint: false },
  show_screen: { title: 'Show the iPhone screen', destructiveHint: false, idempotentHint: true, openWorldHint: false },
  screen_input: { title: 'Touch the iPhone screen', destructiveHint: true, idempotentHint: false, openWorldHint: false },
  screen_takeover: { title: 'Take over the iPhone', destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
const annotationsOf = (name, readOnlyHint) => ({ readOnlyHint, ...approvalHints[name], ...pairingHints[name] });
const metaOf = name => toolMeta[name] ? { _meta: toolMeta[name] } : {};
const profile = (env = process.env) => env.POKI_TOOL_PROFILE ?? 'default';
// The pairing tools are listed in every profile: a view calls pairing_cancel, and hosts show each
// tool only to whom its ui.visibility names.
// So are the screen tools: show_screen for the agent, the others for the screen view.
const listedFor = name => new Set([...(name === 'cua' ? cua.tools : defaultTools), ...pairingTools, ...screenTools]);

export function createServer(call) {
  const computerUse = profile() === 'cua', listed = listedFor(profile());
  const server = new McpServer({ name: 'poki-mcp', version }, { instructions: computerUse ? cua.instructions : instructions });
  for (const [name, description, inputSchema, readOnlyHint] of definitions) {
    server.registerTool(name, { description, inputSchema, annotations: annotationsOf(name, readOnlyHint), ...metaOf(name) }, async (args, extra) => {
      try { return await call(name, args, { signal: extra.mcpReq?.signal ?? extra.signal, requestId: extra.mcpReq?._meta?.['poki/request_id'], order: extra.mcpReq?._meta?.['poki/order'] }); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  if (process.env.POKI_MCP_TOOLS !== 'all') {
    server.server.setRequestHandler('tools/list', () => ({
      tools: definitions.filter(([name]) => listed.has(name)).map(([name, description, inputSchema, readOnlyHint]) => ({
        name, description, inputSchema: z.toJSONSchema(inputSchema, { io: 'input', target: 'draft-2020-12' }),
        annotations: annotationsOf(name, readOnlyHint), ...metaOf(name),
      })),
    }));
  }
  // MCP Apps views: static files, so whichever process answers (the stdio shim or the daemon) reads them.
  for (const view of views) {
    server.registerResource(view.name, view.uri, { title: view.title, description: view.description, mimeType: RESOURCE_MIME_TYPE, _meta: view.meta }, () => readView(view.uri));
  }
  return server;
}

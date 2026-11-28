// The screen view (src/views/screen.html) in a mock MCP Apps host: ext-apps' AppBridge in the outer
// page (served from 127.0.0.1, a secure context like LobeHub's https), the view in a sandboxed
// srcdoc iframe without allow-same-origin, and Poki's real stream code behind its tool calls (the
// screen hub, the flow control, ffmpeg when installed, werift) with a stand-in phone that sends the
// sample HEVC stream. Runs in Google Chrome when installed (its WebCodecs decode H.264, and HEVC on
// macOS), else in Playwright's Chromium, which decodes neither and shows JPEG.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { readView } from '../src/views/index.mjs';
import { Coordination } from '../src/coordination.mjs';
import { Screens } from '../src/stream/hub.mjs';
import { runScreenTool } from '../src/stream/tools.mjs';
import { ffmpegAvailable } from '../src/stream/transcode.mjs';
import { sampleFrames, fakeNative } from './stream-fixture.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
// POKI_VIEW_BROWSER=chromium runs in Playwright's Chromium even where Chrome is installed.
async function launch() {
  if (process.env.POKI_VIEW_BROWSER === 'chromium') return { browser: await chromium.launch(), channel: 'chromium' };
  try { return { browser: await chromium.launch({ channel: 'chrome' }), channel: 'chrome' }; }
  catch { return { browser: await chromium.launch(), channel: 'chromium' }; }
}
const browserReady = chromium && (existsSync(chromium.executablePath()) || ['/Applications/Google Chrome.app', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].some(existsSync));
const skip = !browserReady && !process.env.CI && 'Neither Google Chrome nor Playwright Chromium is installed';

const bridgeBundle = skip ? '' : (await build({
  stdin: { contents: "export { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';", resolveDir: process.cwd(), loader: 'js' },
  bundle: true, format: 'iife', globalName: 'MockHost', write: false, platform: 'browser',
})).outputFiles[0].text;
const viewHtml = skip ? '' : (await readView('ui://poki/screen')).contents[0].text;

const hostPage = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif}iframe{border:0;width:100%;display:block}</style></head><body><div id="slot"></div>
<script>${bridgeBundle}</script>
<script>
  window.mount = async (toolResult, context = {}) => {
    const slot = document.getElementById('slot');
    slot.replaceChildren();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    frame.srcdoc = window.viewHtml;
    slot.append(frame);
    const bridge = new MockHost.AppBridge(null, { name: 'mock-host', version: '1' }, { serverTools: {} }, { hostContext: { theme: 'light', displayMode: 'fullscreen', ...context } });
    bridge.oncalltool = params => window.hostCall(params.name, params.arguments ?? {});
    bridge.onsizechange = ({ height }) => { if (height) frame.style.height = height + 'px'; };
    bridge.oninitialized = () => { if (toolResult) bridge.sendToolResult(toolResult); };
    await bridge.connect(new MockHost.PostMessageTransport(frame.contentWindow, frame.contentWindow));
    window.bridge = bridge;
  };
  window.unmount = () => document.getElementById('slot').replaceChildren();
</script></body></html>`;

// Poki's stream tools over a stand-in phone that sends the sample stream in a loop, 10 frames a second.
function backend({ rtcConfig, rtcConfigDelayMs = 0, noFrames = false, busy = false, garbleHevc = false, rtcOffer, openCodecString, inputDelayMs = 0, onlyFirstKey = false, delayFirstFramesMs = 0, firstPhoneOnly = false, garbleJpegAfterFirst = false, loseReads = 0, devices = [{ id: 'fixture-phone', name: 'Lab iPhone', kind: 'physical', connection: 'RemotePairing' }] } = {}) {
  const native = fakeNative();
  const screens = new Screens({ subscribe: native.subscribe, keyframe: native.keyframe });
  const session = { coordinator: new Coordination(), label: 'view session' };
  const calls = [], inputs = [];
  let inFlight = 0, maxInFlight = 0, seq = 0, firstFramesSent = false, jpegBatches = 0, lost = 0;
  const delivered = [];
  const frames = sampleFrames();
  const feeder = setInterval(() => {
    const subscription = native.subscriptions.at(-1);
    if (!subscription?.open || noFrames) return;
    // firstPhoneOnly: a phone chosen later sends nothing yet, as one still starting its stream.
    if (firstPhoneOnly && native.subscriptions.length > 1) return;
    // onlyFirstKey: one key frame, then deltas only, as a still screen after its first picture.
    const frame = onlyFirstKey && seq > 0 ? frames[1 + (seq - 1) % 3] : frames[seq % frames.length];
    seq++;
    subscription.send({ ...frame, seq, data: garbleHevc ? Buffer.alloc(frame.data.length, 0x55) : frame.data });
  }, 100);
  const handle = async (name, args) => {
    calls.push({ name, args, at: Date.now() });
    if (name === 'list_devices') return { content: [{ type: 'text', text: '{}' }], structuredContent: { devices } };
    if (name === 'screen_rtc_offer' && rtcOffer) return rtcOffer(args);
    if (name === 'screen_rtc_config' && rtcConfigDelayMs) await delay(rtcConfigDelayMs);
    if (name === 'screen_rtc_config' && rtcConfig) { calls.at(-1).args = args; return { content: [{ type: 'text', text: '{}' }], structuredContent: rtcConfig }; }
    if (name === 'screen_input' && busy) { inputs.push(args); return { isError: true, content: [{ type: 'text', text: 'The agent is using this iPhone right now.' }], structuredContent: { reason: 'busy', error: 'The agent is using this iPhone right now.' } }; }
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    let delayed = false;
    try {
      const result = await runScreenTool(session, name, args, {
        screens, resolve: async id => ({ id, kind: 'physical' }),
        native: async (target, request) => { inputs.push({ ...args, device: target.id, request }); if (inputDelayMs) await delay(inputDelayMs); return { sent: true }; },
      });
      // The reply carrying the first frames is slow: the next read's later frames overtake it.
      if (name === 'screen_read' && delayFirstFramesMs && !firstFramesSent && result.structuredContent?.frames?.length) { firstFramesSent = true; delayed = true; await delay(delayFirstFramesMs); }
      if (name === 'screen_read' && result.structuredContent?.frames?.length) {
        // garbleJpegAfterFirst: one picture decodes, every later one is not a JPEG.
        if (garbleJpegAfterFirst && result.structuredContent.codec === 'jpeg' && jpegBatches++ > 0) for (const frame of result.structuredContent.frames) frame.data = Buffer.from('not a jpeg').toString('base64');
        delivered.push(...result.structuredContent.frames.map(f => f.seq));
        // loseReads: replies the server sent that never reach the view (a relay dropped them).
        if (lost < loseReads) { lost++; throw new Error('The relay dropped this reply.'); }
      }
      // A codec string the browser cannot configure, to make the first decoder fail at once.
      if (name === 'screen_open' && openCodecString && result.structuredContent?.codec === 'hevc') result.structuredContent.codec_string = openCodecString;
      // Through the bridge, as JSON: a Buffer would not survive.
      return JSON.parse(JSON.stringify(result));
    } finally { inFlight--; }
  };
  return { handle, calls, inputs, native, screens, session, delivered, count: name => calls.filter(c => c.name === name).length, get maxInFlight() { return maxInFlight; }, stop: () => { clearInterval(feeder); screens.closeAll(); } };
}

let shared, server;
test.after(async () => { await shared?.then(({ browser }) => browser.close()); server?.close(); });
async function open(t, { settings = {}, width = 720, height = 1000, context, backendOptions } = {}) {
  shared ??= launch();
  const { browser, channel } = await shared;
  server ??= await new Promise(resolve => { const s = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(hostPage); }).listen(0, '127.0.0.1', () => resolve(s)); });
  const browserContext = await browser.newContext({ viewport: { width, height } });
  const poki = backend(backendOptions);
  t.after(async () => { poki.stop(); await browserContext.close(); });
  const page = await browserContext.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('hostCall', (name, args) => poki.handle(name, args));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(html => { window.viewHtml = html; }, viewHtml.replace('<head>', `<head><script>globalThis.pokiScreenSettings=${JSON.stringify(settings)}</script>`));
  const view = page.frameLocator('iframe');
  const frame = () => page.frames().find(f => f !== page.mainFrame());
  const mount = result => page.evaluate(([r, c]) => window.mount(r, c), [result, context]);
  const screen = () => frame().evaluate(() => ({ codec: globalThis.pokiScreen.codec, transport: globalThis.pokiScreen.transport, stream: globalThis.pokiScreen.stream, stats: globalThis.pokiScreen.stats }));
  return { page, view, frame, poki, mount, errors, channel, screen };
}
const until = async (predicate, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await predicate(); } catch {}
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await delay(100);
  }
};
// Whether the canvas shows a picture: the sample's colour bars, not a blank or black canvas.
const painted = frame => frame.evaluate(() => {
  const canvas = document.getElementById('screen');
  if (canvas.hidden || !canvas.width) return false;
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  for (let i = 0; i < data.length; i += 4 * 97) if (data[i] + data[i + 1] + data[i + 2] > 120) lit++;
  return lit > 20;
});
const showResult = { content: [{ type: 'text', text: 'shown' }], structuredContent: { device: 'fixture-phone', panel: 'ui://poki/screen' } };

test('the view decodes the best codec this browser supports and streams over pipelined screen_read calls', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false } });
  await h.mount(showResult);
  const served = (await ffmpegAvailable()) ? ['hevc', 'h264', 'jpeg'] : ['hevc'];
  const supported = await until(() => h.frame()?.evaluate(async () => {
    const check = codec => VideoDecoder.isConfigSupported({ codec }).then(r => r.supported, () => false);
    return [...(await check('hvc1.1.6.L120.90') ? ['hevc'] : []), ...(await check('avc1.42E01F') ? ['h264'] : []), 'jpeg'];
  }));
  const expected = supported.find(codec => served.includes(codec));
  if (!expected) return t.skip(`${h.channel} decodes only ${supported.join(', ')}, and ffmpeg is not installed`);
  await until(() => painted(h.frame()));
  const state = await h.screen();
  assert.equal(state.codec, expected, `${h.channel} should show ${expected}`);
  assert.equal(state.transport, 'tool-calls');
  assert.equal(h.poki.count('screen_open'), 1);
  assert.deepEqual(h.poki.calls.find(c => c.name === 'screen_open').args.codecs, supported);
  // Several reads in flight at once, each acknowledging what was decoded.
  await until(() => h.poki.maxInFlight >= 2);
  await until(() => h.poki.calls.filter(c => c.name === 'screen_read').some(c => c.args.ack > 0));
  await until(async () => (await h.view.locator('#stats').textContent()).includes('tool calls'));
  t.diagnostic(`${h.channel}: ${expected}, ${(await h.screen()).stats?.fps} fps`);
  assert.deepEqual(h.errors, []);
});

test('transport A is used when ICE connects, and the view falls back to tool calls when it does not', { skip, timeout: 90000 }, async t => {
  const direct = await open(t, { settings: { rtc: true, codecs: ['jpeg'] } });
  if (!(await ffmpegAvailable())) return t.skip('ffmpeg is not installed, so no JPEG to stream');
  await direct.mount(showResult);
  await until(async () => (await direct.screen()).transport === 'webrtc');
  await until(() => painted(direct.frame()));
  assert.equal(direct.poki.count('screen_rtc_offer'), 1);
  const reads = direct.poki.count('screen_read');
  await delay(1500);
  assert.equal(direct.poki.count('screen_read'), reads, 'frames still came over tool calls while WebRTC worked');

  // An answer that never connects: tool calls take over within the view's three seconds.
  const blocked = await open(t, { settings: { rtc: true, codecs: ['jpeg'] }, backendOptions: { rtcOffer: async () => ({ isError: true, content: [{ type: 'text', text: 'blocked' }] }) } });
  const started = Date.now();
  await blocked.mount(showResult);
  await until(async () => (await blocked.screen()).transport === 'tool-calls');
  await until(() => painted(blocked.frame()));
  assert.ok(Date.now() - started < 10000);
});

test('a codec the browser fails to decode falls back to the next one', { skip, timeout: 60000 }, async t => {
  if (!(await ffmpegAvailable())) return t.skip('ffmpeg is not installed, so there is no codec to fall back to');
  // The phone's HEVC is garbage here: whatever the browser tries first for it fails.
  const h = await open(t, { settings: { rtc: false, codecs: ['hevc', 'jpeg'] }, backendOptions: { garbleHevc: true } });
  await h.mount(showResult);
  await until(async () => (await h.screen()).codec === 'jpeg', 30000).catch(async error => { throw new Error(`${error.message}: ${JSON.stringify(await h.screen())} ${JSON.stringify(h.poki.calls.filter(c => c.name !== 'screen_read').map(c => [c.name, c.args.codecs]))} reads=${h.poki.count('screen_read')} ${h.errors}`); });
  const opens = h.poki.calls.filter(c => c.name === 'screen_open').map(c => c.args.codecs);
  assert.deepEqual(opens[0], ['hevc', 'jpeg']);
  assert.deepEqual(opens.at(-1), ['jpeg']);
});

test('pointer gestures and keys become screen_input calls with normalized coordinates', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined } });
  await h.mount(showResult);
  await until(() => painted(h.frame())).catch(async error => { console.log(JSON.stringify(h.poki.calls.map(c => [c.name, c.args.codecs ?? c.args.ack]).slice(0, 30)), h.errors, await h.screen()); throw error; });
  const canvas = h.view.locator('#screen');
  const box = await canvas.boundingBox();

  const at = (x, y) => [box.x + box.width * x, box.y + box.height * y];
  const mouse = h.page.mouse;
  await mouse.click(...at(0.5, 0.25));
  await mouse.move(...at(0.5, 0.8)); await mouse.down(); await mouse.move(...at(0.5, 0.2), { steps: 3 }); await mouse.up();
  await mouse.move(...at(0.2, 0.3)); await mouse.down(); await delay(700); await mouse.up();
  await mouse.move(...at(0.1, 0.5)); await mouse.down(); await mouse.move(...at(0.3, 0.5), { steps: 2 }); await delay(450); await mouse.move(...at(0.9, 0.5), { steps: 8 }); await mouse.up();
  await canvas.focus();
  await h.page.keyboard.type('hi');
  await h.page.keyboard.press('Enter');
  await until(() => h.poki.inputs.length >= 6).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(h.poki.inputs)} ${JSON.stringify(h.poki.calls.filter(c => c.name === 'screen_input'))} ${h.errors}`); });
  const [tap, swipe, press, drag, text, key] = h.poki.inputs;
  const near = (value, expected) => Math.abs(value - expected) < 0.03;
  assert.equal(tap.kind, 'tap'); assert.ok(near(tap.x, 0.5) && near(tap.y, 0.25), JSON.stringify(tap));
  assert.deepEqual(tap.request, { op: 'tap', x: Math.round(tap.x * 65535), y: Math.round(tap.y * 65535), duration_ms: 50 });
  assert.equal(swipe.kind, 'swipe'); assert.ok(near(swipe.y, 0.8) && near(swipe.y2, 0.2), JSON.stringify(swipe));
  assert.equal(swipe.request.op, 'drag');
  assert.equal(press.kind, 'long_press'); assert.ok(press.t_ms >= 600);
  assert.equal(drag.kind, 'drag'); assert.ok(near(drag.x2, 0.9));
  assert.deepEqual([text.kind, text.text, text.request.op], ['text', 'hi', 'type_keys']);
  assert.deepEqual([key.kind, key.key], ['key', 'return']);
  // Gestures arrive one at a time, in the order they were made.
  const at2 = h.poki.calls.filter(c => c.name === 'screen_input').map(c => c.at);
  assert.deepEqual(at2, [...at2].sort((a, b) => a - b));
});

test('a busy device offers a takeover, which needs the person to confirm', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined }, backendOptions: { busy: true } });
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  const box = await h.view.locator('#screen').boundingBox();
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await h.view.getByText('The agent is using this iPhone right now.').waitFor();
  assert.equal(h.poki.count('screen_takeover'), 0);
  await h.view.locator('#takeover').click();
  await h.view.getByText(/Taking over stops what it is doing/).waitFor();
  assert.equal(h.poki.count('screen_takeover'), 0, 'the takeover ran before the person confirmed');
  await h.view.locator('#confirm-yes').click();
  await until(() => h.poki.count('screen_takeover') === 1);
  assert.equal(h.poki.calls.find(c => c.name === 'screen_takeover').args.confirm, true);
});

test('a remounted view opens its stream again, and a narrow inline view stays within its width', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { width: 375, height: 812, context: { displayMode: 'inline', platform: 'mobile' }, settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined } });
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  const first = (await h.screen()).stream;
  const layout = await h.frame().evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth, stage: document.getElementById('stage').getBoundingClientRect().width }));
  assert.ok(layout.scroll <= layout.width, `horizontal overflow: ${JSON.stringify(layout)}`);
  assert.ok(layout.stage <= 375);
  // Scrolled out of view (unmounted) and back: a new stream starts and frames flow again.
  await h.page.evaluate(() => window.unmount());
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  await until(() => h.poki.count('screen_open') === 2);
  assert.notEqual((await h.screen()).stream, first);
});

test('a gesture still queued when the person switches iPhones is dropped, not sent to the other one', { skip, timeout: 60000 }, async t => {
  const devices = [{ id: 'phone-a', name: 'Phone A', kind: 'physical', connection: 'RemotePairing' }, { id: 'phone-b', name: 'Phone B', kind: 'physical', connection: 'RemotePairing' }];
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined }, backendOptions: { devices, inputDelayMs: 1500 } });
  await h.mount({ content: [{ type: 'text', text: 'shown' }], structuredContent: { device: 'phone-a' } });
  await until(() => painted(h.frame()));
  const box = await h.view.locator('#screen').boundingBox();
  // The first tap takes 1.5 s to reach the phone; the second waits behind it.
  await h.page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await until(() => h.poki.inputs.length === 1);
  await h.page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await h.view.locator('#device').selectOption('phone-b');
  await until(async () => h.poki.calls.some(c => c.name === 'screen_open' && c.args.device === 'phone-b'));
  await delay(2500);
  assert.deepEqual(h.poki.inputs.map(i => i.device), ['phone-a'], `a queued gesture went to ${JSON.stringify(h.poki.inputs.map(i => i.device))}`);
});

test('choosing another iPhone closes the previous stream', { skip, timeout: 60000 }, async t => {
  const devices = [{ id: 'phone-a', name: 'Phone A', kind: 'physical', connection: 'RemotePairing' }, { id: 'phone-b', name: 'Phone B', kind: 'physical', connection: 'RemotePairing' }];
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined }, backendOptions: { devices } });
  await h.mount({ content: [{ type: 'text', text: 'shown' }], structuredContent: { device: 'phone-a' } });
  await until(() => painted(h.frame()));
  const first = (await h.screen()).stream;
  await h.view.locator('#device').selectOption('phone-b');
  await until(() => h.poki.calls.some(c => c.name === 'screen_close' && c.args.stream === first));
  // Phone A's subscription ends with its only viewer, so its camera and microphone are released.
  await until(() => h.poki.native.subscriptions[0].open === false);
});

test('while another iPhone\'s stream starts, the previous phone\'s picture is gone and taps on it go nowhere', { skip, timeout: 60000 }, async t => {
  const devices = [{ id: 'phone-a', name: 'Phone A', kind: 'physical', connection: 'RemotePairing' }, { id: 'phone-b', name: 'Phone B', kind: 'physical', connection: 'RemotePairing' }];
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined }, backendOptions: { devices, firstPhoneOnly: true } });
  await h.mount({ content: [{ type: 'text', text: 'shown' }], structuredContent: { device: 'phone-a' } });
  await until(() => painted(h.frame()));
  const box = await h.view.locator('#screen').boundingBox();
  await h.view.locator('#device').selectOption('phone-b');
  await until(() => h.poki.calls.some(c => c.name === 'screen_open' && c.args.device === 'phone-b'));
  assert.equal(await h.frame().evaluate(() => document.getElementById('screen').hidden), true, 'Phone A\'s picture still shows for Phone B');
  assert.equal(await h.frame().evaluate(() => document.getElementById('placeholder').hidden), false);
  // Where Phone A's picture was: nothing is there to aim at on Phone B yet.
  await h.page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await delay(1000);
  assert.deepEqual(h.poki.inputs, [], `a tap on the old picture reached ${JSON.stringify(h.poki.inputs.map(i => i.device))}`);
});

test('JPEG pictures that fail to decode after one that did still return their credit, until the codec is given up', { skip, timeout: 60000 }, async t => {
  if (!(await ffmpegAvailable())) return t.skip('ffmpeg is not installed, so there is no JPEG track');
  const h = await open(t, { settings: { rtc: false, codecs: ['jpeg'] }, backendOptions: { garbleJpegAfterFirst: true } });
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  // Two undecodable pictures fill the JPEG window; without their credit back nothing more comes.
  await until(() => h.poki.delivered.length >= 5, 12000).catch(() => {});
  assert.ok(h.poki.delivered.length >= 5, `only ${h.poki.delivered.length} pictures were sent: the failed ones kept their credit`);
});

test('pictures whose read replies were lost return their credit, and the stream goes on', { skip, timeout: 60000 }, async t => {
  if (!(await ffmpegAvailable())) return t.skip('ffmpeg is not installed, so there is no JPEG track');
  const h = await open(t, { settings: { rtc: false, codecs: ['jpeg'] }, backendOptions: { loseReads: 2 } });
  await h.mount(showResult);
  await until(() => h.poki.delivered.length >= 2);
  await until(() => painted(h.frame()), 10000).catch(() => {});
  assert.ok(await painted(h.frame()), `no picture after two lost replies (${h.poki.delivered.length} sent)`);
});

test('an iPhone disconnected on purpose is not reconnected by the panel until the person asks', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined } });
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  assert.equal(h.poki.count('screen_open'), 1);
  // disconnect_device ends the phone's panels.
  h.poki.screens.closeDevice('fixture-phone');
  await until(async () => (await h.view.locator('#notice').textContent()).includes('disconnected'));
  await delay(2000);
  assert.equal(h.poki.count('screen_open'), 1, 'the panel opened the stream again, reconnecting the phone');
  assert.equal(h.poki.native.subscriptions.at(-1).open, false);
  // The person reconnects.
  await h.view.locator('#notice button', { hasText: 'Reconnect' }).click();
  await until(() => h.poki.count('screen_open') === 2);
  await until(() => painted(h.frame()));
});

test('over WebRTC the panel learns of a disconnect at once, not when the peer times out', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: true } });
  await h.mount(showResult);
  await until(async () => (await h.screen()).transport === 'webrtc');
  await until(() => painted(h.frame()));
  const started = Date.now();
  h.poki.screens.closeDevice('fixture-phone');
  await until(async () => (await h.view.locator('#notice').textContent()).includes('disconnected'), 10000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `the disconnect was shown after ${elapsed} ms`);
  assert.equal(await h.frame().evaluate(() => document.getElementById('stats').hidden), true, 'the badge still shows the ended stream');
  await delay(1500);
  assert.equal(h.poki.count('screen_open'), 1);
});

test('a JPEG picture that finishes decoding after a newer one is not shown over it', { skip, timeout: 60000 }, async t => {
  if (!(await ffmpegAvailable())) return t.skip('ffmpeg is not installed, so there is no JPEG track');
  const h = await open(t, { settings: { rtc: false, codecs: ['jpeg'] }, backendOptions: { noFrames: true } });
  await h.mount(showResult);
  await until(() => h.frame().evaluate(() => globalThis.pokiScreenInternals.decoder()?.codec === 'jpeg'));
  const centre = await h.frame().evaluate(async () => {
    const jpeg = async colour => { const c = new OffscreenCanvas(90, 195); const g = c.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, 90, 195); return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer()); };
    const older = await jpeg('#ff0000'), newer = await jpeg('#0000ff');
    // The older picture's decode finishes last.
    const original = globalThis.createImageBitmap;
    let calls = 0;
    globalThis.createImageBitmap = async blob => { const first = calls++ === 0; const bitmap = await original(blob); if (first) await new Promise(r => setTimeout(r, 300)); return bitmap; };
    const decoder = globalThis.pokiScreenInternals.decoder();
    await Promise.all([decoder.decode({ seq: 1, key: true, data: older }), decoder.decode({ seq: 2, key: true, data: newer })]);
    await new Promise(r => setTimeout(r, 300));
    globalThis.createImageBitmap = original;
    const canvas = document.getElementById('screen');
    const [r, , b] = canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
    return { r, b };
  });
  assert.ok(centre.b > 200 && centre.r < 60, `the older picture is shown over the newer one: ${JSON.stringify(centre)}`);
});

test('a decoder that fails while WebRTC is still connecting falls back to the next codec', { skip, timeout: 60000 }, async t => {
  if (!(await ffmpegAvailable())) return t.skip('ffmpeg is not installed, so there is no codec to fall back to');
  const h = await open(t, { settings: { rtc: true, codecs: ['hevc', 'jpeg'] }, backendOptions: {
    openCodecString: 'hvc1.99.not-a-codec',
    // The answer takes 4 s: the decoder fails well before it.
    rtcOffer: async () => { await delay(4000); return { isError: true, content: [{ type: 'text', text: 'no peer' }] }; },
  } });
  await h.mount(showResult);
  await until(() => h.poki.calls.filter(c => c.name === 'screen_open').length >= 2, 30000);
  const [first, second] = h.poki.calls.filter(c => c.name === 'screen_open');
  assert.deepEqual(second.args.codecs, ['jpeg']);
  // Not after the 4 s answer, and not by the decoder watchdog later: as soon as the decoder failed.
  assert.ok(second.at - first.at < 3000, `the fallback waited ${second.at - first.at} ms`);
  await until(async () => (await h.screen()).codec === 'jpeg', 30000);
  await until(() => painted(h.frame()));
});

test('a WebRTC offer that never gets an answer falls back to tool calls', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: true, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined }, backendOptions: { rtcOffer: () => new Promise(() => {}) } });
  const started = Date.now();
  await h.mount(showResult);
  await until(async () => (await h.screen()).transport === 'tool-calls', 15000);
  assert.ok(Date.now() - started < 10000, `fell back after ${Date.now() - started} ms`);
  await until(() => painted(h.frame()));
});

test('frames that overtake the first batch wait for it instead of blanking the screen', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false }, backendOptions: { onlyFirstKey: true, delayFirstFramesMs: 800 } });
  await h.mount(showResult);
  const codec = await until(async () => (await h.screen()).codec);
  if (codec === 'jpeg') return t.skip('JPEG pictures are all key frames; the chain order does not matter there');
  await until(() => painted(h.frame()), 8000);
});

test('characters typed just before a tap reach the phone before the tap', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined } });
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  const box = await h.view.locator('#screen').boundingBox();
  await h.view.locator('#screen').focus();
  await h.page.keyboard.type('hi');
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(() => h.poki.inputs.length >= 2);
  assert.deepEqual(h.poki.inputs.map(i => i.kind), ['text', 'tap']);
});

test('a vertical pinch keeps its axis, and typing buffered before switching iPhones is dropped', { skip, timeout: 60000 }, async t => {
  const devices = [{ id: 'phone-a', name: 'Phone A', kind: 'physical', connection: 'RemotePairing' }, { id: 'phone-b', name: 'Phone B', kind: 'physical', connection: 'RemotePairing' }];
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined }, backendOptions: { devices } });
  await h.mount({ content: [{ type: 'text', text: 'shown' }], structuredContent: { device: 'phone-a' } });
  await until(() => painted(h.frame()));
  // Two fingers at (0.1, 0.25) and (0.1, 0.75): a vertical pinch at the left edge.
  const gesture = await h.frame().evaluate(() => globalThis.pokiGesture([{ x: 0.1, y: 0.25, t: 0 }, { x: 0.1, y: 0.25, t: 300 }], [{ x: 0.1, y: 0.75, t: 0 }, { x: 0.1, y: 0.7, t: 300 }]));
  assert.equal(Math.round(gesture.angle), 90);
  // Characters typed on phone A, then phone B chosen within the typing debounce.
  await h.view.locator('#screen').focus();
  await h.page.keyboard.type('ab');
  await h.view.locator('#device').selectOption('phone-b');
  await until(() => h.poki.calls.some(c => c.name === 'screen_open' && c.args.device === 'phone-b'));
  await delay(1500);
  assert.deepEqual(h.poki.inputs.filter(i => i.kind === 'text'), [], 'typing from phone A reached phone B');
});

test('over WebRTC a key frame resumes the chain, and a late discontinuity notice does not undo it', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined } });
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  const state = await h.frame().evaluate(() => {
    const packet = (seq, key) => { const p = new Uint8Array(11 + 4); const v = new DataView(p.buffer); v.setUint32(0, 0x4c485643); v.setUint32(4, seq); p[8] = key ? 2 : 3; v.setUint16(9, 0); return p; };
    const r = globalThis.pokiScreenInternals;
    const base = r.lastSeq() + 1000;
    // The recovery key frame arrives on the media channel before the control channel's notice.
    r.receivePacket(packet(base, true));
    r.receiveControl({ type: 'discontinuity' });
    r.receivePacket(packet(base + 1, false));
    return { last: r.lastSeq() - base, held: r.held() };
  });
  assert.deepEqual(state, { last: 1, held: 0 }, 'the delta after the recovery key frame was held');
});

test('a codec string that arrives after the first key frame does not tear down a decoding chain', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false, codecs: ['hevc'] }, backendOptions: { noFrames: true } });
  await h.mount(showResult);
  await until(async () => (await h.screen()).codec === 'hevc');
  const hevc = await h.frame().evaluate(() => VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L60.90' }).then(r => r.supported));
  if (!hevc) return t.skip('this browser does not decode HEVC');
  const [key, delta] = sampleFrames().map(f => f.data.toString('base64'));
  const waiting = await h.frame().evaluate(async ([key, delta]) => {
    const bytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
    const packet = (seq, isKey, data) => { const p = new Uint8Array(11 + data.length); const v = new DataView(p.buffer); v.setUint32(0, 0x4c485643); v.setUint32(4, seq); p[8] = isKey ? 2 : 3; v.setUint16(9, 0); p.set(data, 11); return p; };
    const r = globalThis.pokiScreenInternals;
    r.receivePacket(packet(5000, true, bytes(key)));
    // WebRTC's ready (with the real codec string) comes after the key frame on the media channel.
    r.receiveControl({ type: 'ready', codec_string: 'hvc1.1.6.L60.90' });
    r.receivePacket(packet(5001, false, bytes(delta)));
    await new Promise(resolve => setTimeout(resolve, 300));
    return r.waitingKey();
  }, [key, delta]);
  assert.equal(waiting, false, 'the decoder was reset and waits for another key frame');
});

test('frames decoded before the WebRTC peer is ready are acknowledged once it is, and a replaced decoder\'s late picture is dropped', { skip, timeout: 60000 }, async t => {
  const h = await open(t, { settings: { rtc: false, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined } });
  await h.mount(showResult);
  await until(() => painted(h.frame()));
  const result = await h.frame().evaluate(async () => {
    const r = globalThis.pokiScreenInternals;
    // Frames were decoded (acknowledged nowhere: no peer yet); then the peer becomes ready.
    const sent = [];
    const seq = r.decodedSeq();
    r.installPeer({ pc: { close() {} }, send: value => sent.push(value) });
    // A decoder replaced while it was decoding a JPEG.
    const old = r.decoder();
    old.close();
    const canvas = Object.assign(document.createElement('canvas'), { width: 4, height: 4 });
    const jpeg = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'))).arrayBuffer());
    await old.decode({ seq: seq + 100000, key: true, data: jpeg });
    return { seq, sent, after: r.decodedSeq() };
  });
  assert.ok(result.seq > 0);
  assert.deepEqual(result.sent, [{ type: 'ack', seq: result.seq }], 'the credit of frames decoded before readiness never came back');
  assert.ok(result.after < result.seq + 100000, 'a closed decoder\'s late picture moved the acknowledgement past the new stream');
});

test('a WebRTC attempt still setting up when the person chooses another iPhone does not offer for the new stream', { skip, timeout: 60000 }, async t => {
  const devices = [{ id: 'phone-a', name: 'Phone A', kind: 'physical', connection: 'RemotePairing' }, { id: 'phone-b', name: 'Phone B', kind: 'physical', connection: 'RemotePairing' }];
  // An unreachable STUN server keeps ICE gathering busy for its 1.5 s: the person switches then.
  const h = await open(t, { settings: { rtc: true, codecs: (await ffmpegAvailable()) ? ['jpeg'] : undefined }, backendOptions: { devices, rtcConfig: { enabled: true, ice_servers: [{ urls: ['stun:192.0.2.1:3478'] }] } } });
  await h.mount({ content: [{ type: 'text', text: 'shown' }], structuredContent: { device: 'phone-a' } });
  await until(() => h.poki.calls.some(c => c.name === 'screen_rtc_config'));
  const streamA = h.poki.calls.find(c => c.name === 'screen_rtc_config').args.stream;
  await delay(200);
  await h.view.locator('#device').selectOption('phone-b');
  await until(() => h.poki.calls.some(c => c.name === 'screen_open' && c.args.device === 'phone-b'));
  await delay(6000);
  const offers = h.poki.calls.filter(c => c.name === 'screen_rtc_offer').map(c => c.args.stream);
  const configs = h.poki.calls.filter(c => c.name === 'screen_rtc_config').map(c => c.args.stream);
  const streamB = h.poki.calls.find(c => c.name === 'screen_open' && c.args.device === 'phone-b') && configs.at(-1);
  assert.deepEqual(offers.filter(s => s === streamA), [], 'an offer was sent for the closed stream');
  assert.ok(offers.filter(s => s === streamB).length <= 1, `phone A's attempt offered for phone B's stream: offers ${JSON.stringify(offers)}, configs ${JSON.stringify(configs)}`);
});

// The pairing view (src/views/pairing.html) in a mock MCP Apps host: ext-apps' own AppBridge in the
// outer page, the view in a sandboxed srcdoc iframe without allow-same-origin (origin null, as in
// LobeHub), and a scripted Poki backend answering its tool calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readView } from '../src/views/index.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
const browserReady = chromium && existsSync(chromium.executablePath());
// Skipped locally without Chromium; in CI a missing browser is a failure, never a silent skip.
const skip = !browserReady && !process.env.CI && 'Playwright Chromium is not installed (npx playwright install chromium)';

const bridgeBundle = skip ? '' : (await build({
  stdin: { contents: "export { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';", resolveDir: process.cwd(), loader: 'js' },
  bundle: true, format: 'iife', globalName: 'MockHost', write: false, platform: 'browser',
})).outputFiles[0].text;
const viewHtml = skip ? '' : (await readView('ui://poki/pairing')).contents[0].text;

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
    const bridge = new MockHost.AppBridge(null, { name: 'mock-host', version: '1' }, { serverTools: {} }, { hostContext: { theme: 'light', displayMode: 'inline', ...context } });
    bridge.oncalltool = params => window.hostCall(params.name, params.arguments ?? {});
    bridge.onsizechange = ({ height }) => { if (height) frame.style.height = height + 'px'; };
    bridge.oninitialized = () => { if (toolResult) bridge.sendToolResult(toolResult); };
    await bridge.connect(new MockHost.PostMessageTransport(frame.contentWindow, frame.contentWindow));
    window.bridge = bridge;
  };
  window.unmount = () => document.getElementById('slot').replaceChildren();
</script></body></html>`;

// A scripted stand-in for the daemon: jobs move only when the test says so.
function backend() {
  const calls = [];
  const state = {
    jobState: 'advertising',
    devices: [
      { id: 'wireless-1', name: 'Lab iPhone', kind: 'physical', connection: 'RemotePairing', model: 'iPhone17,1', osVersion: '27.0', readiness: 'remote services connected', display_service: true },
      { id: 'usb-1', name: 'Cable iPhone', kind: 'physical', connection: 'USB' },
    ],
    job: undefined,
    // Developer-image jobs by device id; each is its own job beside the pairing.
    prepares: new Map(),
  };
  const prepareView = id => {
    const p = state.prepares.get(id);
    const terminal = ['ready', 'failed', 'cancelled'].includes(p.state);
    const device = state.devices.find(d => d.id === id) ?? { id, name: id === 'wireless-2' ? 'New iPhone' : id };
    return { job: `prep-${id}`, kind: 'prepare', state: p.state, host_name: 'Poki Lab', terminal, device: { id, name: device.name }, started_at: p.started_at, updated_at: new Date().toISOString(),
      ...(p.state === 'failed' ? { stage: 'ddi', reason: 'ddi_tunnel_install_failed', error: 'cryptexd refused', action: 'Connect the iPhone with a USB cable once.', paired: true } : {}),
      instruction: { mounting_ddi: 'Preparing developer services.', ready: 'Paired and ready.', failed: 'Connect the iPhone with a USB cable once.', cancelled: 'Pairing was cancelled.' }[p.state] };
  };
  // Like the service, a job's updated_at moves only when its state changes.
  let stamped;
  const stampFor = st => { if (stamped?.state !== st) stamped = { state: st, at: new Date().toISOString() }; return stamped.at; };
  const jobView = () => {
    const s = state.jobState;
    const terminal = ['ready', 'failed', 'cancelled'].includes(s);
    return {
      job: 'pair-1', kind: 'pair', state: s, host_name: 'Poki Lab', terminal, updated_at: stampFor(s),
      ...(s === 'pin' ? { pin: '482916' } : {}),
      ...(['mounting_ddi', 'ready', 'failed'].includes(s) ? { device: { id: 'wireless-2', name: 'New iPhone', host: '192.0.2.2', model: 'iPhone17,1' } } : {}),
      ...(s === 'failed' ? { stage: 'ddi', reason: 'ddi_tunnel_install_failed', error: 'cryptexd refused', action: 'Connect the iPhone with a USB cable once.', paired: true } : {}),
      instruction: { advertising: 'On the iPhone, open Settings › Privacy & Security › Developer Mode and tap “Pair with Poki Lab”.', pin: 'Enter this code on the iPhone: 482916.', mounting_ddi: 'Preparing developer services.', ready: 'Paired and ready.', cancelled: 'Pairing was cancelled.', failed: 'Connect the iPhone with a USB cable once.' }[s],
    };
  };
  const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const handle = async (name, args) => {
    calls.push({ name, args, at: Date.now() });
    if (name === 'list_devices') {
      for (const [id, p] of state.prepares) { const device = state.devices.find(d => d.id === id); if (device) device.display_service = p.state === 'ready' ? true : device.display_service; }
      return ok({ devices: [...state.devices, ...(['ready', 'failed'].includes(state.jobState) && state.job ? [{ id: 'wireless-2', name: 'New iPhone', connection: 'RemotePairing', readiness: 'remote services connected', display_service: state.prepares.get('wireless-2')?.state === 'ready' || state.jobState === 'ready' }] : [])], pairing: { host: { name: 'Poki Lab', advertising: Boolean(state.job) && ['advertising', 'pin'].includes(state.jobState) }, jobs: [...(state.job ? [jobView()] : []), ...[...state.prepares.keys()].map(prepareView)] } });
    }
    if (name === 'pair_device' && args.device) { state.prepares.set(args.device, { state: 'mounting_ddi', started_at: new Date().toISOString() }); return ok({ job: prepareView(args.device), existing: false }); }
    if (name === 'pair_device') { state.job = true; state.jobState = 'advertising'; return ok({ job: jobView(), existing: false }); }
    if (name === 'pairing_status' && args.job?.startsWith('prep-')) return ok(prepareView(args.job.slice(5)));
    if (name === 'pairing_status') return state.job ? ok(jobView()) : { isError: true, content: [{ type: 'text', text: 'No pairing job "pair-1".' }] };
    if (name === 'pairing_cancel' && args.job?.startsWith('prep-')) { state.prepares.get(args.job.slice(5)).state = 'cancelled'; return ok(prepareView(args.job.slice(5))); }
    if (name === 'pairing_cancel') { state.jobState = 'cancelled'; return ok(jobView()); }
    if (name === 'unpair_device') { state.devices = state.devices.filter(d => d.id !== args.device); return ok({ unpaired: true, device: { id: args.device, name: 'Lab iPhone' }, phone_cleanup: 'Remove this computer on the iPhone too.' }); }
    return { isError: true, content: [{ type: 'text', text: `unexpected ${name}` }] };
  };
  return { calls, state, handle, jobView, count: name => calls.filter(c => c.name === name).length, polled: job => calls.filter(c => c.name === 'pairing_status' && c.args.job === job).length };
}

// One browser for the file: closing a headless Chromium can take seconds on some hosts.
let shared;
test.after(() => shared?.then(browser => browser.close()));
async function open(t, { width = 720, height = 900, context } = {}) {
  const browser = await (shared ??= chromium.launch());
  const browserContext = await browser.newContext({ viewport: { width, height } });
  t.after(() => browserContext.close());
  const page = await browserContext.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const server = backend();
  await page.exposeFunction('hostCall', (name, args) => server.handle(name, args));
  await page.setContent(hostPage);
  await page.evaluate(html => { window.viewHtml = html; }, viewHtml);
  const view = page.frameLocator('iframe');
  const mount = result => page.evaluate(([r, c]) => window.mount(r, c), [result, context]);
  return { page, view, server, mount, errors };
}

const until = async (predicate, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test('the view shows the PIN, keeps polling, and lists the new iPhone when it is ready', { skip, timeout: 60000 }, async t => {
  const { view, server, mount, errors } = await open(t);
  server.state.job = true;
  await mount({ content: [{ type: 'text', text: 'Pairing started.' }], structuredContent: { job: server.jobView(), existing: false } });
  await view.getByText('Waiting for the iPhone').waitFor();
  await view.getByText(/Pair with Poki Lab/).waitFor();
  server.state.jobState = 'pin';
  await view.getByRole('img', { name: 'PIN 4 8 2 9 1 6' }).waitFor();
  assert.equal(await view.locator('.pin span').count(), 6);
  const polled = server.count('pairing_status');
  await until(() => server.count('pairing_status') > polled + 1);
  await view.getByText('Advertising as Poki Lab').waitFor();
  server.state.jobState = 'mounting_ddi';
  await view.getByText('Preparing developer services').first().waitFor();
  // The header follows the job, not the list_devices answer from before it advanced.
  assert.equal(await view.getByText('Advertising as Poki Lab').count(), 0);
  server.state.jobState = 'ready';
  await view.getByText('Ready', { exact: true }).waitFor();
  await view.locator('.device', { hasText: 'New iPhone' }).waitFor();
  const settled = server.count('pairing_status');
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(server.count('pairing_status'), settled, 'polling stops at a terminal state');
  assert.deepEqual(errors, []);
});

test('Cancel calls pairing_cancel and stops polling', { skip, timeout: 60000 }, async t => {
  const { view, server, mount } = await open(t);
  server.state.job = true;
  server.state.jobState = 'pin';
  await mount({ content: [], structuredContent: { job: server.jobView(), existing: false } });
  await view.getByRole('button', { name: 'Cancel' }).click();
  await view.getByText('Pairing cancelled').waitFor();
  assert.deepEqual(server.calls.find(c => c.name === 'pairing_cancel').args, { job: 'pair-1' });
  const after = server.count('pairing_status');
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(server.count('pairing_status'), after);
  await view.getByRole('button', { name: 'Pair again' }).waitFor();
});

test('a remounted view restores the running job from the service, not the stale tool result', { skip, timeout: 60000 }, async t => {
  const { page, view, server, mount } = await open(t);
  server.state.job = true;
  const stale = { content: [], structuredContent: { job: server.jobView(), existing: false } };
  await mount(stale);
  await view.getByText('Waiting for the iPhone').waitFor();
  await page.evaluate(() => window.unmount());
  server.state.jobState = 'pin';
  // The host replays the original result on mount; the view must still show the PIN.
  await mount(stale);
  await view.getByRole('img', { name: 'PIN 4 8 2 9 1 6' }).waitFor();
  // A job the service no longer knows (restarted or expired) falls back to the device list.
  await page.evaluate(() => window.unmount());
  server.state.job = undefined;
  await mount(stale);
  await view.locator('.device', { hasText: 'Lab iPhone' }).waitFor();
  await view.getByRole('button', { name: 'Pair an iPhone' }).waitFor();
  assert.equal(await view.locator('#job').isHidden(), true);
});

test('Pair an iPhone starts a job; Unpair asks once more before removing', { skip, timeout: 60000 }, async t => {
  const { view, server, mount } = await open(t);
  await mount(undefined);
  await view.locator('.device', { hasText: 'Lab iPhone' }).waitFor();
  assert.equal(await view.locator('#others').textContent(), '1 other device (USB or simulator) is not managed here.');
  await view.getByRole('button', { name: 'Unpair' }).click();
  assert.equal(server.count('unpair_device'), 0, 'the first click only asks');
  await view.getByRole('button', { name: 'Remove pairing' }).click();
  await view.getByText(/Removed Lab iPhone\. Remove this computer on the iPhone too\./).waitFor();
  assert.deepEqual(server.calls.find(c => c.name === 'unpair_device').args, { device: 'wireless-1' });
  await view.getByRole('button', { name: 'Pair an iPhone' }).click();
  await view.getByText('Waiting for the iPhone').waitFor();
  assert.equal(server.count('pair_device'), 1);
});

test('the view fits a phone-width inline frame without horizontal scrolling', { skip, timeout: 60000 }, async t => {
  const { page, view, server, mount } = await open(t, { width: 360, height: 780, context: { theme: 'dark' } });
  server.state.job = true;
  server.state.jobState = 'pin';
  await mount({ content: [], structuredContent: { job: server.jobView(), existing: false } });
  await view.getByRole('img', { name: 'PIN 4 8 2 9 1 6' }).waitFor();
  await view.locator('.device').first().waitFor();
  const frame = page.frames().find(f => f !== page.mainFrame());
  const layout = await frame.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth,
    pinRight: Math.max(...[...document.querySelectorAll('.pin span')].map(e => e.getBoundingClientRect().right)),
    buttonsInside: [...document.querySelectorAll('button')].filter(b => b.offsetParent).every(b => b.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5),
    theme: document.documentElement.dataset.theme ?? document.documentElement.style.colorScheme,
  }));
  assert.ok(layout.scroll <= layout.width, JSON.stringify(layout));
  assert.ok(layout.pinRight <= layout.width, JSON.stringify(layout));
  assert.ok(layout.buttonsInside, JSON.stringify(layout));
  assert.match(layout.theme, /dark/);
  await page.screenshot({ path: process.env.POKI_VIEW_SCREENSHOT ?? '/dev/null', fullPage: true }).catch(() => {});
});

test('a failed developer image offers a retry that needs no new PIN, and a phone missing displayservice offers an install', { skip, timeout: 60000 }, async t => {
  const { view, server, mount } = await open(t);
  server.state.devices[0].display_service = false;
  server.state.devices[0].readiness = 'connected; developer services missing';
  server.state.job = true;
  server.state.jobState = 'failed';
  await mount({ content: [], structuredContent: server.jobView() });
  await view.getByText('Pairing failed').waitFor();
  assert.equal(await view.getByRole('button', { name: 'Pair again' }).count(), 0, 'a paired phone is not sent back to the PIN');
  // The USB advice is the fallback after a retry, not an alternative shown beside it.
  await view.getByText('Try installing the developer image again over Wi-Fi. If it fails again: Connect the iPhone with a USB cable once.').waitFor();
  await view.getByRole('button', { name: 'Retry developer image' }).click();
  const retry = view.locator('[data-prepare="wireless-2"]');
  await retry.getByText('Preparing developer services', { exact: true }).waitFor();
  assert.deepEqual(server.calls.find(c => c.name === 'pair_device').args, { device: 'wireless-2' });
  await view.getByText('The developer image is being installed again for this iPhone; see its card below.').waitFor();
  // The pairing card shows the retry, not the failure it is retrying.
  assert.equal(await view.locator('#job .row strong').innerText(), 'Preparing developer services');
  assert.equal(await view.locator('#job .note').count(), 0, 'the old error is not shown while the retry runs');
  server.state.prepares.get('wireless-2').state = 'ready';
  await retry.getByText('Ready', { exact: true }).waitFor();
  await view.getByRole('button', { name: 'Pair again' }).waitFor();
  // The pairing card follows how the retry ended, not that one started.
  const pairing = view.locator('#job');
  await pairing.getByText('The developer image was installed again; the iPhone is ready. Pass device: "wireless-2" to the device tools.').waitFor();
  assert.equal(await pairing.getByText(/being installed again|see its card below/).count(), 0, 'the finished retry is not described as running');
  assert.equal(await pairing.locator('.row strong').innerText(), 'Ready');
  assert.equal(await pairing.locator('.note').count(), 0, 'the old failure is not shown beside the ready state');
  await retry.getByRole('button', { name: 'Done' }).click();
  assert.equal(await retry.count(), 0);
  assert.equal(await pairing.getByText(/see its card below/).count(), 0, 'no card below is pointed to once it is closed');
  await pairing.getByText('The developer image was installed again', { exact: false }).waitFor();
  await view.getByRole('button', { name: 'Install developer image' }).click();
  await until(() => server.calls.filter(c => c.name === 'pair_device').length === 2);
  assert.deepEqual(server.calls.filter(c => c.name === 'pair_device')[1].args, { device: 'wireless-1' });
});

test('a developer image retry that fails again sends the pairing card back to its retry', { skip, timeout: 60000 }, async t => {
  const { view, server, mount } = await open(t);
  server.state.job = true;
  server.state.jobState = 'failed';
  await mount({ content: [], structuredContent: server.jobView() });
  const pairing = view.locator('#job');
  await pairing.getByRole('button', { name: 'Retry developer image' }).click();
  const retry = view.locator('[data-prepare="wireless-2"]');
  await retry.getByText('Preparing developer services', { exact: true }).waitFor();
  await pairing.getByText('The developer image is being installed again for this iPhone; see its card below.').waitFor();
  server.state.prepares.get('wireless-2').state = 'failed';
  await retry.getByText('Developer image failed', { exact: true }).waitFor();
  await pairing.getByRole('button', { name: 'Retry developer image' }).waitFor();
  assert.equal(await pairing.locator('.row strong').innerText(), 'Pairing failed');
  await pairing.getByText('Try installing the developer image again over Wi-Fi. If it fails again: Connect the iPhone with a USB cable once.').waitFor();
  assert.equal(await pairing.getByText(/being installed again|see its card below/).count(), 0, 'the failed retry is not described as running');
});

test('preparing another phone keeps a running pairing and its PIN on screen, and both are followed', { skip, timeout: 60000 }, async t => {
  const { view, server, mount } = await open(t);
  server.state.devices[0].display_service = false;
  server.state.job = true;
  server.state.jobState = 'pin';
  await mount({ content: [], structuredContent: { job: server.jobView(), existing: false } });
  const pin = view.getByRole('img', { name: 'PIN 4 8 2 9 1 6' });
  await pin.waitFor();
  await view.getByRole('button', { name: 'Install developer image' }).click();
  const prepare = view.locator('[data-prepare="wireless-1"]');
  await prepare.getByText('Preparing developer services', { exact: true }).waitFor();
  assert.equal(await pin.isVisible(), true, 'the PIN stays while the other phone is prepared');
  const [pairingPolls, preparePolls] = [server.polled('pair-1'), server.polled('prep-wireless-1')];
  await until(() => server.polled('pair-1') >= pairingPolls + 2 && server.polled('prep-wireless-1') >= preparePolls + 2);
  server.state.prepares.get('wireless-1').state = 'ready';
  await prepare.getByText('Ready', { exact: true }).waitFor();
  assert.equal(await pin.isVisible(), true);
  server.state.jobState = 'mounting_ddi';
  await view.locator('#job').getByText('Preparing developer services', { exact: true }).waitFor();
  server.state.jobState = 'ready';
  // The title and instruction, not the stepper's "Ready" label that every state shows.
  await view.locator('#job .row strong').getByText('Ready', { exact: true }).waitFor();
  await view.locator('#job .instruction').getByText('Paired and ready.', { exact: true }).waitFor();
  await prepare.getByRole('button', { name: 'Done' }).click();
  assert.equal(await prepare.count(), 0, 'a finished preparation card can be closed');
});

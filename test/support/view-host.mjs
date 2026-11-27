#!/usr/bin/env node
// A mock MCP Apps host for Poki's views, for trying them in a browser and for acceptance runs:
// ext-apps' own AppBridge in the page, each view in a sandboxed srcdoc iframe without
// allow-same-origin (origin null, as in LobeHub), and every resources/read and tools/call sent to a
// real Poki stdio server (src/stdio.mjs) through MCP.
//
//   node test/support/view-host.mjs [--port 4790] [--stub]
//   GET /calls lists every tools/call with its time, its source (agent, view, direct) and the job state.
//
// --stub runs Poki from a temporary copy of this checkout with a stand-in poki-native
// (test/support/pairing-native.mjs) and one iPhone already paired, so pairing can be walked through
// without an iPhone: the page's "iPhone accepts the PIN" button plays the phone's part.
import http from 'node:http';
import { mkdtemp, cp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root } from '../../src/config.mjs';
import { pairingNative } from './pairing-native.mjs';

const { values: options } = parseArgs({ options: { port: { type: 'string', default: '4790' }, stub: { type: 'boolean', default: false } } });

let pokiRoot = root, env = { ...process.env }, stubDir;
if (options.stub) {
  stubDir = await mkdtemp(join(tmpdir(), 'poki-view-host-'));
  await cp(join(root, 'src'), join(stubDir, 'src'), { recursive: true });
  await cp(join(root, 'package.json'), join(stubDir, 'package.json'));
  await symlink(join(root, 'node_modules'), join(stubDir, 'node_modules'));
  for (const directory of ['build', 'bin', 'state/remote/lab-iphone', 'ddi']) await mkdir(join(stubDir, directory), { recursive: true });
  await writeFile(join(stubDir, 'build/poki-native'), pairingNative, { mode: 0o755 });
  // No USB devices and no simulators: only the wireless ones.
  await writeFile(join(stubDir, 'bin/python3'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  await writeFile(join(stubDir, 'bin/xcrun'), '#!/bin/sh\necho \'{"devices":{}}\'\n', { mode: 0o755 });
  await writeFile(join(stubDir, 'ddi/BuildManifest.plist'), 'stub');
  await writeFile(join(stubDir, 'fixture.json'), '{}');
  await writeFile(join(stubDir, 'commands.jsonl'), '');
  await writeFile(join(stubDir, 'pairing.json'), JSON.stringify({
    pairHost: [{ event: 'advertising', port: 53124 }, { event: 'connected', peer: '192.0.2.27' }, { event: 'pin', pin: '482916' }, { await: 'accept' },
      { event: 'paired', device: { udid: 'new-iphone', name: 'New iPhone', model: 'iPhone17,1' }, peer: '192.0.2.27' }],
    names: { 'lab-iphone': 'Lab iPhone', 'new-iphone': 'New iPhone' },
    // Long enough to see the view's "Preparing developer services" step.
    remote: { installDelayMs: 4000 },
  }));
  const labConfig = join(stubDir, 'state/remote/lab-iphone/config.json');
  await writeFile(labConfig, JSON.stringify({ id: 'lab-iphone', host: '192.0.2.10', port: 49152, pairing_file: join(stubDir, 'state/remote/lab-iphone/pairing.plist') }));
  await writeFile(join(stubDir, 'state/remote-devices.json'), JSON.stringify([{ id: 'lab-iphone', name: 'Lab iPhone', config_path: labConfig }]));
  pokiRoot = stubDir;
  env = { ...env, HOME: stubDir, PATH: `${join(stubDir, 'bin')}:${process.env.PATH}`, POKI_MCP_STATE_DIR: join(stubDir, 'state'), POKI_NO_UPDATE_CHECK: '1',
    POKI_DDI_DIR: join(stubDir, 'ddi'), FIXTURE_STATE: join(stubDir, 'fixture.json'), FIXTURE_LOG: join(stubDir, 'commands.jsonl'), POKI_MCP_APPROVAL_MODE: 'host' };
}

const client = new Client({ name: 'poki-view-host', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(pokiRoot, 'src/stdio.mjs')], env, stderr: 'inherit' }));

const bridge = (await build({
  stdin: { contents: "export { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';", resolveDir: root, loader: 'js' },
  bundle: true, format: 'iife', globalName: 'MockHost', write: false, platform: 'browser',
})).outputFiles[0].text;

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Poki view host</title>
<style>
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #eef0f3; color: #1c1f24; }
  header { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 12px; background: #fff; border-bottom: 1px solid #d8dbe0; }
  header button, header select { font: inherit; padding: 4px 8px; }
  .chat { padding: 16px; display: grid; gap: 10px; justify-items: start; }
  .bubble { background: #fff; border: 1px solid #d8dbe0; border-radius: 10px; padding: 8px 12px; max-width: 100%; white-space: pre-wrap; }
  .frame { background: #fff; border-radius: 12px; overflow: hidden; border: 1px solid #d8dbe0; }
  iframe { border: 0; display: block; width: 100%; }
  #log { font: 11px ui-monospace, monospace; color: #555; padding: 0 16px 16px; white-space: pre-wrap; }
</style></head><body>
<header>
  <button id="call">Agent calls pair_device</button>
  <button id="remount" disabled>Remount view</button>
  <button id="unmount" disabled>Unmount view</button>
  ${options.stub ? '<button id="accept">iPhone accepts the PIN</button>' : ''}
  <label>Width <select id="width"><option>360</option><option>520</option><option selected>760</option></select></label>
  <label>Theme <select id="theme"><option>light</option><option>dark</option></select></label>
</header>
<div class="chat"><div class="bubble" id="text">The tool's text result appears here.</div><div class="frame" id="slot"></div></div>
<div id="log"></div>
<script>${bridge}</script>
<script>
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());
  let lastResult, viewHtml, bridge;
  const log = line => { document.getElementById('log').textContent = new Date().toISOString().slice(11, 19) + ' ' + line + '\\n' + document.getElementById('log').textContent; };
  async function mount() {
    const slot = document.getElementById('slot');
    slot.style.width = document.getElementById('width').value + 'px';
    slot.replaceChildren();
    viewHtml ??= (await post('/resource', { uri: 'ui://poki/pairing' })).contents[0].text;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    frame.srcdoc = viewHtml;
    slot.append(frame);
    const theme = document.getElementById('theme').value;
    bridge = new MockHost.AppBridge(null, { name: 'poki-view-host', version: '1' }, { serverTools: {} }, { hostContext: { theme, displayMode: 'inline', platform: 'web' } });
    bridge.oncalltool = async params => { log('view → ' + params.name + ' ' + JSON.stringify(params.arguments ?? {})); return post('/call', { ...params, source: 'view' }); };
    bridge.onsizechange = ({ height }) => { if (height) frame.style.height = height + 'px'; };
    bridge.oninitialized = () => { if (lastResult) bridge.sendToolResult(lastResult); };
    await bridge.connect(new MockHost.PostMessageTransport(frame.contentWindow, frame.contentWindow));
    document.getElementById('remount').disabled = document.getElementById('unmount').disabled = false;
  }
  document.getElementById('call').onclick = async () => {
    log('agent → pair_device');
    lastResult = await post('/call', { name: 'pair_device', arguments: {}, source: 'agent' });
    document.getElementById('text').textContent = (lastResult.content ?? []).filter(b => b.type === 'text').map(b => b.text)[0] ?? '';
    await mount();
  };
  document.getElementById('remount').onclick = mount;
  document.getElementById('unmount').onclick = () => { document.getElementById('slot').replaceChildren(); document.getElementById('unmount').disabled = true; };
  document.getElementById('accept')?.addEventListener('click', async () => { await post('/stub/accept'); log('iPhone accepted the PIN'); });
  for (const id of ['width', 'theme']) document.getElementById(id).onchange = mount;
  window.mountView = mount;
</script></body></html>`;

// Every tools/call with its time (ms), who made it (agent, view, direct) and the job state it returned:
// GET /calls.
const calls = [];
const body = request => new Promise(resolve => { let data = ''; request.on('data', chunk => { data += chunk; }); request.on('end', () => resolve(data ? JSON.parse(data) : {})); });
const json = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); return; }
    if (request.method === 'GET' && request.url === '/calls') return json(response, calls);
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    const input = await body(request);
    if (request.url === '/call') {
      const entry = { at: new Date().toISOString(), source: input.source ?? 'direct', name: input.name, arguments: input.arguments ?? {} };
      calls.push(entry);
      const result = await client.callTool({ name: input.name, arguments: input.arguments ?? {} });
      entry.ms = Date.parse(new Date().toISOString()) - Date.parse(entry.at);
      entry.state = result.structuredContent?.state ?? result.structuredContent?.job?.state;
      return json(response, result);
    }
    if (request.url === '/resource') return json(response, await client.readResource({ uri: input.uri }));
    if (request.url === '/stub/accept' && stubDir) { await writeFile(join(stubDir, 'accept'), ''); return json(response, { accepted: true }); }
    response.writeHead(404); response.end();
  } catch (error) { json(response, { isError: true, content: [{ type: 'text', text: error.message }] }, 500); }
});
server.listen(Number(options.port), '127.0.0.1', () => console.log(JSON.stringify({ event: 'ready', url: `http://127.0.0.1:${server.address().port}/`, stub: Boolean(stubDir), root: pokiRoot })));

async function stop() {
  server.close();
  await client.close().catch(() => {});
  // The stub copy's own service (started by its stdio server) stops on its idle timer; its files go now.
  if (stubDir) {
    const endpoint = await import('node:fs/promises').then(fs => fs.readFile(join(stubDir, 'state/mcp.json'), 'utf8')).then(JSON.parse).catch(() => null);
    if (endpoint?.pid) { try { process.kill(endpoint.pid, 'SIGTERM'); } catch {} }
    // RemotePairing helpers run detached from the service, as real ones do; stop the stand-ins.
    const started = await import('node:fs/promises').then(fs => fs.readFile(join(stubDir, 'commands.jsonl'), 'utf8')).catch(() => '');
    for (const line of started.split('\n')) { try { const event = JSON.parse(line); if (event.helper && event.pid) process.kill(event.pid, 'SIGTERM'); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 500));
    await rm(stubDir, { recursive: true, force: true });
  }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

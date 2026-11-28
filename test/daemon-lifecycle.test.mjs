import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixture, value } from './fixture.mjs';
import { olderRelease, pidNamespace } from '../src/daemon-launch.mjs';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const endpointOf = f => readFile(join(f.dir, 'state/mcp.json'), 'utf8').then(JSON.parse).catch(() => null);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readyLines = async f => (await readFile(join(f.dir, 'state/daemon.log'), 'utf8').catch(() => '')).split('\n').filter(line => line.includes('"event":"ready"'));
const status = async client => { const result = await client.callTool({ name: 'poki_mcp_status', arguments: {} }); assert.ok(!result.isError, result.content?.[0]?.text); return value(result); };
async function until(predicate, ms = 10000, what = 'condition') {
  const end = performance.now() + ms;
  while (!(await predicate())) {
    if (performance.now() >= end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}
// Changes the code marker the way an update does, so a running daemon no longer matches the checkout.
const touchCode = f => utimes(join(f.dir, 'src/work.mjs'), new Date(), new Date(Date.now() + 60000));

test('a stdio call succeeds with no service running: the shim starts one', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false });
  assert.equal(await endpointOf(f), null);
  const report = await status(f.a);
  assert.match(report.implementation, /Poki MCP/);
  const entry = await endpointOf(f);
  assert.ok(entry && alive(entry.pid), 'the started service is running and recorded in mcp.json');
  assert.equal((await readyLines(f)).length, 1);
  assert.match((await readyLines(f))[0], /"auto":true/);
});

test('listing tools does not start a service', { timeout: 20000 }, async t => {
  const f = await fixture(t, { daemon: false });
  assert.ok((await f.a.listTools()).tools.length > 0);
  await sleep(200);
  assert.equal(await endpointOf(f), null);
});

test('several shims started at once share one service', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  const clients = [f.a, ...await Promise.all([1, 2, 3, 4].map(() => f.connect()))];
  await Promise.all(clients.map(status));
  const entry = await endpointOf(f);
  assert.equal((await readyLines(f)).length, 1, 'exactly one service became ready');
  // A second call from each still reaches that same service.
  await Promise.all(clients.map(status));
  assert.equal((await endpointOf(f)).pid, entry.pid);
});

test('after the service is killed, the next call starts it again', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await status(f.a);
  const first = await endpointOf(f);
  process.kill(first.pid, 'SIGKILL');
  await until(() => !alive(first.pid), 5000, 'the service to die');
  // mcp.json still names the dead service.
  assert.equal((await endpointOf(f)).pid, first.pid);
  await status(f.a);
  const second = await endpointOf(f);
  assert.notEqual(second.pid, first.pid);
  assert.ok(alive(second.pid));
});

test('a service started with npm start that was stopped is replaced by one the shim starts', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await status(f.a);
  await f.daemon.stop('SIGKILL');
  const report = await status(f.a);
  assert.match(report.implementation, /Poki MCP/);
  assert.match((await readyLines(f)).at(-1), /"auto":true/);
});

test('an automatic service exits once idle, and stays while a client is connected', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false, extraEnv: () => ({ POKI_DAEMON_IDLE_EXIT_MS: '400' }) });
  await status(f.a);
  const { pid } = await endpointOf(f);
  await sleep(1500);
  assert.ok(alive(pid), 'a connected client keeps it running');
  await f.a.close();
  await until(() => !alive(pid), 10000, 'idle exit');
  assert.equal(await endpointOf(f), null, 'mcp.json is removed on exit');
  assert.match(await readFile(join(f.dir, 'state/daemon.log'), 'utf8'), /"event":"idle-exit"/);
});

test('a shim killed without closing its session does not keep the service running', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false, extraEnv: () => ({ POKI_DAEMON_IDLE_EXIT_MS: '400', POKI_MCP_HEARTBEAT_MS: '200' }) });
  await f.a.close();
  // A shim the client pool reaps with SIGKILL never sends /session/close.
  const child = spawn(process.execPath, [join(f.dir, 'src/stdio.mjs')], { env: f.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
  await until(() => output.includes('"id":1'), 10000, 'initialize');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'poki_mcp_status', arguments: {} } });
  await until(() => output.includes('"id":2'), 20000, 'the status call');
  const { pid } = await endpointOf(f);
  child.kill('SIGKILL'); await exited;
  await until(() => !alive(pid), 10000, 'idle exit after the dead shim\'s session is dropped');
});

test('an idle automatic service running older code is replaced by the next shim', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await status(f.a);
  const old = await endpointOf(f);
  await f.a.close();
  await touchCode(f);
  const b = await f.connect();
  await status(b);
  const current = await endpointOf(f);
  assert.notEqual(current.pid, old.pid);
  await until(() => !alive(old.pid), 10000, 'the old service to stop');
  assert.match(await readFile(join(f.dir, 'state/daemon.log'), 'utf8'), /"event":"replaced"/);
});

test('a busy automatic service running older code is left alone, and the call says why', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await f.set({ label: 'Ready' });
  const lease = await f.a.callTool({ name: 'acquire_device', arguments: { device: 'fixture-phone', ttl_seconds: 60 } });
  assert.ok(!lease.isError, lease.content[0].text);
  const old = await endpointOf(f);
  await touchCode(f);
  const b = await f.connect();
  const result = await b.callTool({ name: 'poki_mcp_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /older code/);
  assert.match(result.content[0].text, /device lease/);
  assert.ok(alive(old.pid), 'the busy service keeps running');
  assert.equal((await endpointOf(f)).pid, old.pid);
});

test('a service started with npm start that runs older code is reported, not restarted', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await status(f.a);
  const old = await endpointOf(f);
  await touchCode(f);
  const b = await f.connect();
  const result = await b.callTool({ name: 'poki_mcp_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /npm start/);
  assert.ok(alive(old.pid));
});

test('a token the running service rejects is reported quickly, without the token', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const entry = await endpointOf(f);
  await writeFile(join(f.dir, 'state/mcp.json'), JSON.stringify({ ...entry, token: 'f'.repeat(64) }));
  const started = performance.now();
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(f.dir, 'src/stdio.mjs')], env: f.env });
  const client = new Client({ name: 'rejected', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  const result = await client.callTool({ name: 'poki_mcp_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rejected the token/);
  assert.ok(!result.content[0].text.includes(entry.token));
  assert.ok(performance.now() - started < 10000);
});

test('a daemon from an earlier release counts as older; a later one does not', () => {
  assert.equal(olderRelease('0.1.1', '0.2.0'), true);
  assert.equal(olderRelease('0.2.0', '0.10.0'), true);
  assert.equal(olderRelease('0.2.0', '0.2.0'), false);
  assert.equal(olderRelease('0.3.0', '0.2.0'), false);
  assert.equal(olderRelease('dev', '0.2.0'), true);
});

test('a connected client whose automatic service turns out to run older code gets the call through a new one', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await f.set({ label: 'Ready' });
  assert.notEqual((await f.call('list_elements')).isError, true);
  const old = await endpointOf(f);
  await touchCode(f);
  // The same client, still connected to the old service.
  const result = await f.call('list_elements');
  assert.notEqual(result.isError, true, result.content[0].text);
  const current = await endpointOf(f);
  assert.notEqual(current.pid, old.pid);
  await until(() => !alive(old.pid), 10000, 'the old service to stop');
});

test('a service from before 0.2.0, which has no /version, is reported at once as one to restart', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.daemon.stop();
  // Answers like an old daemon: every unknown path is 404.
  const old = createServer((req, res) => { res.writeHead(404); res.end(); });
  old.listen(0, '127.0.0.1'); await once(old, 'listening');
  t.after(() => old.close());
  // A live process stands in for the old daemon's pid (the fixture's cleanup kills that pid).
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await writeFile(join(f.dir, 'state/mcp.json'), JSON.stringify({ url: `http://127.0.0.1:${old.address().port}/mcp`, port: old.address().port, token: 'a'.repeat(64), enabled: true, pid: holder.pid }));
  const started = performance.now();
  const result = await f.a.callTool({ name: 'poki_mcp_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /started with npm start and runs older code \(before 0\.2\.0/);
  assert.ok(performance.now() - started < 10000);
});

test('a shim that exits after its service died does not start another one to close its session', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await status(f.a);
  const { pid } = await endpointOf(f);
  process.kill(pid, 'SIGKILL');
  await until(() => !alive(pid), 5000, 'the service to die');
  await f.a.close();
  await sleep(1000);
  assert.equal((await readyLines(f)).length, 1, 'no service was started for the close');
});

test('shims that find the same stale start lock at once still start one service', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  // The lock of a shim that died while starting the service.
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(dead, 'exit');
  await mkdir(join(f.dir, 'state'), { recursive: true });
  await writeFile(join(f.dir, 'state/daemon.lock'), JSON.stringify({ pid: dead.pid, ...(pidNamespace ? { pid_ns: pidNamespace } : {}), nonce: 'dead' }));
  const clients = [f.a, ...await Promise.all([1, 2, 3, 4, 5].map(() => f.connect()))];
  await Promise.all(clients.map(status));
  assert.equal((await readyLines(f)).length, 1, 'exactly one service became ready');
  const { pid } = await endpointOf(f);
  await Promise.all(clients.map(status));
  assert.equal((await endpointOf(f)).pid, pid);
});

test('a shim whose client leaves while its first call still waits for a service exits cleanly', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await f.a.close();
  // A live process holds the start lock, so the first call waits for a service that does not come.
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await mkdir(join(f.dir, 'state'), { recursive: true });
  await writeFile(join(f.dir, 'state/daemon.lock'), JSON.stringify({ pid: holder.pid, nonce: 'held' }));
  const child = spawn(process.execPath, [join(f.dir, 'src/stdio.mjs')], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
  await until(() => output.includes('"id":1'), 10000, 'initialize');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'poki_mcp_status', arguments: {} } });
  await sleep(300);
  const ended = performance.now();
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.ok(performance.now() - ended < 5000, 'it does not wait for the service');
  assert.doesNotMatch(errors, /TypeError/);
  assert.equal((await readyLines(f)).length, 0);
});

test('a shim killed while its session records the screen: the recording is stopped and the service still exits', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false, extraEnv: () => ({ POKI_DAEMON_IDLE_EXIT_MS: '400', POKI_MCP_HEARTBEAT_MS: '200' }) });
  await f.a.close();
  const child = spawn(process.execPath, [join(f.dir, 'src/stdio.mjs')], { env: f.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
  await until(() => output.includes('"id":1'), 10000, 'initialize');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_recording', arguments: { device: 'fixture-phone' } } });
  await until(() => output.includes('"id":2'), 20000, 'start_recording');
  assert.match(output, /\\"recording\\": true/);
  const { pid } = await endpointOf(f);
  child.kill('SIGKILL'); await exited;
  await until(() => !alive(pid), 15000, 'the service to stop the dead shim\'s recording and exit');
});

test('run_code through a connected client whose automatic service turns out to run older code runs on a new one', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await f.set({ label: 'Ready' });
  assert.notEqual((await f.call('list_elements')).isError, true);
  const old = await endpointOf(f);
  await touchCode(f);
  const result = await f.call('run_code', { code: `return (await tools.list_elements({ device: 'fixture-phone' })).elements.length;` });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.notEqual((await endpointOf(f)).pid, old.pid);
});

// Only a tool call starts the service. The MCP client keeps a background stream open and reconnects it
// on its own; those reconnections must not bring back a service the user stopped.
test('a stopped service stays stopped while a client stays connected, until the next tool call', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await status(f.a);
  await f.daemon.stop('SIGTERM');
  await sleep(8000);
  assert.deepEqual(await readyLines(f), [], 'no service started without a tool call');
  assert.equal(await endpointOf(f), null);
  // The client still works: its next call starts a service.
  const report = await status(f.a);
  assert.match(report.implementation, /Poki MCP/);
  assert.match((await readyLines(f)).at(-1), /"auto":true/);
});

// A client in another PID namespace (a container sharing the state directory) sends a pid that means
// nothing to the daemon. Its session, and the lease it holds, outlast other clients checking /version.
test('a session whose client runs in another PID namespace keeps its lease when other shims start', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  const endpoint = await endpointOf(f);
  const http = (session, headers = {}) => { const client = new Client({ name: 'http', version: '1' }); t.after(() => client.close()); return client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}`, 'x-poki-mcp-session': session, ...headers } } })).then(() => client); };
  // A pid no process here has, as a client in another container would send it.
  const telegram = await http('telegram-task', { 'x-poki-mcp-client-pid': '3999999' });
  const lease = await telegram.callTool({ name: 'acquire_device', arguments: { device: 'fixture-phone', ttl_seconds: 60 } });
  assert.ok(!lease.isError, lease.content?.[0]?.text);
  const other = await http('other-task');
  const refusedBefore = await other.callTool({ name: 'acquire_device', arguments: { device: 'fixture-phone' } });
  assert.ok(refusedBefore.isError);
  // Another client starting up asks /version, as every shim does.
  await status(await f.connect());
  const response = await fetch(new URL('/version', endpoint.url), { headers: { Authorization: `Bearer ${endpoint.token}` } });
  assert.ok((await response.json()).sessions >= 2);
  const refusedAfter = await other.callTool({ name: 'acquire_device', arguments: { device: 'fixture-phone' } });
  assert.ok(refusedAfter.isError, 'the other session still cannot take the leased phone');
  assert.match(refusedAfter.content[0].text, /occupied/);
});

// The daemon in mcp.json may run in another PID namespace, where its pid names no process here. It is
// found by its answer to /version, so no second daemon is started beside it.
test('a running service whose pid is not visible from the shim is still used', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const entry = await endpointOf(f);
  await writeFile(join(f.dir, 'state/mcp.json'), JSON.stringify({ ...entry, pid: 3999999, pid_ns: 'pid:[1]' }), { mode: 0o600 });
  const client = await f.connect();
  const report = await status(client);
  assert.match(report.implementation, /Poki MCP/);
  assert.deepEqual(await readyLines(f), [], 'no automatic service was started');
  assert.equal((await endpointOf(f)).port, entry.port);
});

// The start lock records its holder's pid, which a later process can reuse. A lock its holder stopped
// touching is stale whatever that pid now names.
test('a start lock whose pid now belongs to a live process is broken once it goes untouched', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false });
  const lock = join(f.dir, 'state/daemon.lock');
  await mkdir(join(f.dir, 'state'), { recursive: true });
  // This test's own pid: alive, but not a shim starting a service.
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'left-behind' }));
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  // The old code waited for that pid until the start timeout and failed.
  const report = await status(f.a);
  assert.match(report.implementation, /Poki MCP/);
});

test('a call that cannot start the service because of a held lock names that lock', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false });
  const lock = join(f.dir, 'state/daemon.lock');
  await mkdir(join(f.dir, 'state'), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'held' }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { ensureDaemon } from ${JSON.stringify(join(f.dir, 'src/daemon-launch.mjs'))}; await ensureDaemon({ timeoutMs: 1500 }).catch(error => { console.log(error.message); });`], { env: f.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  await once(child, 'exit');
  assert.match(output, /did not become reachable/);
  assert.ok(output.includes(lock), output);
  assert.match(output, new RegExp(`held by pid ${process.pid}`));
});

// The daemon a shim starts outlives that client and serves every other one, so the client's secrets
// stay with the client. Its helpers inherit its environment, which shows what it got.
test('a service a shim starts does not take the client\'s secrets', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false, extraEnv: () => ({ POKI_IPHONE_PASSCODE: '123456', OPENAI_API_KEY: 'sk-test-fixture', POKI_MCP_TOKEN: 'x'.repeat(40), FIXTURE_LOG_ENV: '1' }) });
  await status(f.a);
  const helper = (await f.events()).find(event => event.tool === 'python3' && event.env);
  assert.ok(helper, 'a helper of the service ran');
  for (const secret of ['POKI_IPHONE_PASSCODE', 'OPENAI_API_KEY', 'POKI_MCP_TOKEN', 'POKI_PARENT_PID', 'POKI_MCP_SESSION']) assert.ok(!helper.env.includes(secret), `${secret} reached the service`);
  for (const needed of ['PATH', 'HOME', 'POKI_MCP_STATE_DIR', 'FIXTURE_STATE']) assert.ok(helper.env.includes(needed), `${needed} is passed`);
  const entry = await endpointOf(f);
  assert.notEqual(entry.token, 'x'.repeat(40), 'the service made its own token');
});

// The daemon's own code reads process.env.POKI_*; the native helpers it runs (build/ocr, poki-native,
// the simulator helper) read the same environment, through helpers that take the name as a string.
test('every POKI_ setting the service or its native helpers read reaches a service a shim starts', async () => {
  const { readdir } = await import('node:fs/promises');
  const { daemonSettings } = await import('../src/daemon-launch.mjs');
  const repo = join(import.meta.dirname, '..');
  const files = async (dir, pattern) => (await readdir(join(repo, dir), { recursive: true })).filter(file => pattern.test(file) && !file.split('/').includes('target')).map(file => join(repo, dir, file));
  const read = new Set();
  for (const file of await files('src', /\.mjs$/)) for (const [, name] of (await readFile(file, 'utf8')).matchAll(/env\.(POKI_[A-Z0-9_]+)/g)) read.add(name);
  const native = await files('native', /\.(rs|swift|m|py)$/);
  assert.ok(native.some(file => file.endsWith('ocr.rs')), 'the native sources were scanned');
  for (const file of native) for (const [, name] of (await readFile(file, 'utf8')).matchAll(/"(POKI_[A-Z0-9_]+)"/g)) read.add(name);
  assert.ok(read.has('POKI_OCR_LANGS') && read.has('POKI_TYPE_KEY_MS'));
  const shimOnly = new Set(['POKI_MCP_TOKEN', 'POKI_PARENT_PID', 'POKI_MCP_SESSION', 'POKI_MCP_HEARTBEAT_MS', 'POKI_MCP_AUTOSTART', 'POKI_DAEMON_ENV']);
  assert.deepEqual([...read].filter(name => !shimOnly.has(name) && !daemonSettings.has(name)), []);
});

test('with POKI_MCP_AUTOSTART=0 a call fails instead of starting a service, and uses one that runs', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false, extraEnv: () => ({ POKI_MCP_AUTOSTART: '0' }) });
  const result = await f.a.callTool({ name: 'poki_mcp_status', arguments: {} });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /POKI_MCP_AUTOSTART=0/);
  await sleep(300);
  assert.deepEqual(await readyLines(f), []);
  await f.startDaemon();
  assert.match((await status(f.a)).implementation, /Poki MCP/);
});

// A call refused by a service that died is sent again to the new one. It takes its place there before
// any call made after it, instead of keeping a number from the old service's stream.
test('a call sent again after the service restarts runs before a call made after it', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false });
  await status(f.a);
  await f.set({ tapDelayMs: 400 });
  const first = await endpointOf(f);
  process.kill(first.pid, 'SIGKILL');
  await until(() => !alive(first.pid), 5000, 'the service to die');
  const earlier = f.call('tap', { x: 11, y: 10 });
  await until(async () => (await readyLines(f)).length === 2, 20000, 'the new service');
  // By now the shim has found the new service and sent the earlier call there.
  await sleep(200);
  const later = f.call('tap', { x: 12, y: 10 });
  for (const result of await Promise.all([earlier, later])) assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const starts = (await f.events()).filter(event => event.op === 'tap_start').map(event => event.x);
  // x arrives scaled to the device's input range, which keeps the order of the two taps.
  assert.equal(starts.length, 2);
  assert.ok(starts[0] < starts[1], `the earlier call's tap (x 11) started first: ${starts}`);
});

// The shared service's approval mode comes from the client that started it. A client that asks for a
// stricter one explicitly gets its device calls refused, and status says why.
test('a client asking for a stricter approval mode than the running service gets device calls refused', { timeout: 40000 }, async t => {
  const f = await fixture(t, { approvalMode: 'allow' });
  const strict = new Client({ name: 'strict', version: '1' });
  await strict.connect(new StdioClientTransport({ command: process.execPath, args: [join(f.dir, 'src/stdio.mjs')], env: { ...f.env, POKI_MCP_APPROVAL_MODE: 'ask' } }));
  t.after(() => strict.close());
  const tap = await strict.callTool({ name: 'tap', arguments: { device: 'fixture-phone', x: 10, y: 10 } });
  assert.equal(tap.isError, true);
  assert.match(tap.content[0].text, /approval mode ask.*uses allow/s);
  const report = await strict.callTool({ name: 'poki_mcp_status', arguments: {} });
  assert.notEqual(report.isError, true);
  assert.match(report.content.at(-1).text, /device tools are refused/);
  assert.equal((await f.events()).filter(event => event.op === 'tap').length, 0);
  // A client asking for a looser mode runs under the service's stricter one, and status says so.
  const g = await fixture(t, { approvalMode: 'host' });
  const loose = new Client({ name: 'loose', version: '1' });
  await loose.connect(new StdioClientTransport({ command: process.execPath, args: [join(g.dir, 'src/stdio.mjs')], env: { ...g.env, POKI_MCP_APPROVAL_MODE: 'allow' } }));
  t.after(() => loose.close());
  assert.notEqual((await loose.callTool({ name: 'tap', arguments: { device: 'fixture-phone', x: 10, y: 10 } })).isError, true);
  assert.match((await loose.callTool({ name: 'poki_mcp_status', arguments: {} })).content.at(-1).text, /The service's mode applies\./);
});

test('POKI_DAEMON_ENV cannot pass the client\'s secrets or the shim\'s own variables', async () => {
  const { daemonEnvironment } = await import('../src/daemon-launch.mjs');
  const warnings = [];
  const env = daemonEnvironment({ PATH: '/bin', POKI_DAEMON_ENV: 'POKI_IPHONE_PASSCODE, OPENAI_API_KEY,POKI_PARENT_PID,POKI_MCP_TOKEN,POKI_MCP_SESSION,FIXTURE_STATE',
    POKI_IPHONE_PASSCODE: '123456', OPENAI_API_KEY: 'sk-x', POKI_PARENT_PID: '1', POKI_MCP_TOKEN: 'x'.repeat(40), POKI_MCP_SESSION: 's', FIXTURE_STATE: '/f',
    POKI_OCR_LANGS: 'eng', POKI_TYPE_KEY_MS: '20', TESSDATA_PREFIX: '/tess' }, message => warnings.push(message));
  assert.deepEqual(Object.keys(env).sort(), ['FIXTURE_STATE', 'PATH', 'POKI_OCR_LANGS', 'POKI_TYPE_KEY_MS', 'TESSDATA_PREFIX']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /POKI_IPHONE_PASSCODE, OPENAI_API_KEY, POKI_PARENT_PID, POKI_MCP_TOKEN, POKI_MCP_SESSION/);
});

// A session kept by heartbeats alone (no request open, as when a client's background stream is gone)
// must not be dropped because the daemon itself was stopped for longer than the heartbeat window:
// the daemon read no heartbeats meanwhile.
test('a daemon that was stopped for a while keeps the sessions whose heartbeats it could not read', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  const endpoint = await endpointOf(f);
  const headers = session => ({ Authorization: `Bearer ${endpoint.token}`, 'x-poki-mcp-session': session, 'x-poki-mcp-heartbeat-ms': '300', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
  const call = async (session, name, args) => {
    const response = await fetch(endpoint.url, { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await response.json()).result;
  };
  const lease = await call('beating', 'acquire_device', { device: 'fixture-phone', ttl_seconds: 60 });
  assert.notEqual(lease.isError, true, lease.content?.[0]?.text);
  let beating = true, paused = false;
  const beats = (async () => { while (beating) { if (!paused) await fetch(new URL('/session/heartbeat', endpoint.url), { method: 'POST', headers: headers('beating') }).then(r => r.body?.cancel(), () => {}); await sleep(300); } })();
  t.after(async () => { beating = false; await beats; });
  await sleep(600);
  // Longer than 3 heartbeats + 1 s. No heartbeat waits in the socket meanwhile (a shim's times out),
  // so on waking the daemon checks its sessions before it reads the next one.
  paused = true; await sleep(350);
  process.kill(f.daemon.pid, 'SIGSTOP');
  await sleep(3000);
  process.kill(f.daemon.pid, 'SIGCONT');
  await sleep(200); paused = false;
  await sleep(1500);
  const intruder = await call('intruder', 'acquire_device', { device: 'fixture-phone' });
  assert.equal(intruder.isError, true, 'the beating session still holds the phone');
  assert.match(intruder.content[0].text, /occupied/);
  beating = false; await beats;
});

// The shim is what keeps its session: it sends a heartbeat while it lives, also with no call made.
test('a connected shim sends heartbeats', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'poki-heartbeat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { createServer: mcpServer } = await import('../src/tools.mjs');
  const { NodeStreamableHTTPServerTransport } = await import('@modelcontextprotocol/node');
  const { version } = await import('../src/build-info.mjs');
  const beats = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/version') { res.end(JSON.stringify({ version, stale: false, auto: false, pid: process.pid, approval_mode: 'ask', busy: false, busy_reasons: [] })); return; }
    if (req.url === '/session/heartbeat') { beats.push({ session: req.headers['x-poki-mcp-session'], every: req.headers['x-poki-mcp-heartbeat-ms'] }); res.end('{}'); return; }
    if (req.url !== '/mcp') { res.end('{}'); return; }
    const mcp = mcpServer(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => void mcp.close());
    await mcp.connect(transport); await transport.handleRequest(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await mkdir(join(dir, 'state'), { recursive: true });
  await writeFile(join(dir, 'state/mcp.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, token: 'heartbeat-fixture', enabled: true, pid: process.pid }), { mode: 0o600 });
  const client = new Client({ name: 'beats', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '../src/stdio.mjs')], env: { ...process.env, POKI_MCP_STATE_DIR: join(dir, 'state'), POKI_MCP_SESSION: 'beats', POKI_MCP_HEARTBEAT_MS: '200', POKI_NO_UPDATE_CHECK: '1' } }));
  t.after(() => client.close());
  await client.callTool({ name: 'poki_mcp_status', arguments: {} });
  await until(() => beats.length >= 3, 5000, 'three heartbeats');
  assert.ok(beats.every(beat => beat.session === 'beats' && beat.every === '200'));
});

// The stricter-mode check also holds for the call that finds the service replaced by one with a weaker
// mode: it is refused before it is sent there.
test('a call that finds the service replaced by one with a weaker approval mode is refused', { timeout: 40000 }, async t => {
  const f = await fixture(t, { approvalMode: 'ask' });
  await f.set({ simulatorOnly: true, simulatorBooted: true });
  assert.match((await status(f.a)).implementation, /Poki MCP/);
  await f.daemon.stop('SIGTERM');
  const weaker = spawn(process.execPath, [join(f.dir, 'src/daemon.mjs'), '--port', '0'], { env: { ...f.env, POKI_MCP_APPROVAL_MODE: 'allow' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => weaker.kill('SIGKILL'));
  await new Promise(resolve => weaker.stdout.on('data', chunk => { if (String(chunk).includes('"ready"')) resolve(); }));
  const opened = await f.call('open_url', { url: 'https://example.com' });
  assert.equal(opened.isError, true);
  assert.match(opened.content[0].text, /approval mode ask.*uses allow/s);
  assert.equal((await f.events()).filter(event => event.args?.includes('openurl')).length, 0, 'nothing was opened under the weaker mode');
});

// An outdated automatic service refuses the call, and the shim sends it again to whatever service runs
// now. If that one has a weaker approval mode, the call is refused there too.
test('a call sent again after an outdated service refused it is refused when the new service has a weaker approval mode', { timeout: 40000 }, async t => {
  const f = await fixture(t, { daemon: false, approvalMode: 'ask' });
  await f.set({ simulatorOnly: true, simulatorBooted: true });
  assert.match((await status(f.a)).implementation, /Poki MCP/);
  // The automatic service now runs outdated code, and another client started one with allow.
  await touchCode(f);
  const weaker = spawn(process.execPath, [join(f.dir, 'src/daemon.mjs'), '--port', '0'], { env: { ...f.env, POKI_MCP_APPROVAL_MODE: 'allow' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => weaker.kill('SIGKILL'));
  await new Promise(resolve => weaker.stdout.on('data', chunk => { if (String(chunk).includes('"ready"')) resolve(); }));
  const opened = await f.call('open_url', { url: 'https://example.com' });
  assert.equal(opened.isError, true);
  assert.match(opened.content[0].text, /approval mode ask.*uses allow/s);
  assert.equal((await f.events()).filter(event => event.args?.includes('openurl')).length, 0, 'nothing was opened under the weaker mode');
});

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
  const started = performance.now();
  const report = await status(f.a);
  assert.match(report.implementation, /Poki MCP/);
  assert.ok(performance.now() - started < 15000, 'the call did not wait for the start timeout');
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

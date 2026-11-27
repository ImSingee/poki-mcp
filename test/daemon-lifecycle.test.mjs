import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixture, value } from './fixture.mjs';
import { olderRelease, removeIf } from '../src/daemon-launch.mjs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const f = await fixture(t, { daemon: false, extraEnv: () => ({ POKI_DAEMON_IDLE_EXIT_MS: '400' }) });
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

test('removeIf removes only the content it was asked about, and puts anything else back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'poki-remove-if-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'lock');
  await writeFile(file, 'theirs');
  assert.equal(await removeIf(file, content => content === 'mine'), false);
  assert.equal(await readFile(file, 'utf8'), 'theirs');
  assert.equal(await removeIf(file, content => content === 'theirs'), true);
  assert.equal(await readFile(file, 'utf8').catch(() => null), null);
  assert.equal(await removeIf(file, () => true), false, 'a missing file is not an error');
});

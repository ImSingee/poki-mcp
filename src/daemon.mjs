import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, rename, chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation, hostHeaderValidation } from '@modelcontextprotocol/node';
import { createServer, definitions } from './tools.mjs';
import { withCallLog } from './call-log.mjs';
import { Coordination } from './coordination.mjs';
import { Session } from './device.mjs';
import { stateDir, endpointFile } from './config.mjs';
import { startUpdateChecks } from './update-check.mjs';
import { warnIfNativeStale } from './build-info.mjs';
import { closeLocalHelpers, remoteDevices, warmRemote } from './remote.mjs';
import { version, codeFingerprint, currentCodeFingerprint, setServiceStart } from './build-info.mjs';
import { approvalMode } from './human.mjs';
import { runningDaemon, alive, removeIf } from './daemon-launch.mjs';

// --auto: started by a stdio shim (src/daemon-launch.mjs). It takes a free port unless --port says
// otherwise, leaves when another daemon already serves this state directory, and exits once it has
// been idle for POKI_DAEMON_IDLE_EXIT_MS. Started with npm start, it keeps running until stopped.
const auto = process.argv.includes('--auto');
if (auto) setServiceStart('auto');
const portIndex = process.argv.indexOf('--port');
const port = portIndex < 0 ? (auto ? 0 : 47825) : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const idleExitMs = Number(process.env.POKI_DAEMON_IDLE_EXIT_MS ?? 600000);
if (!Number.isFinite(idleExitMs) || idleExitMs <= 0) throw new Error('POKI_DAEMON_IDLE_EXIT_MS must be a positive number of milliseconds.');
const approval = approvalMode();
if (auto) {
  const other = await runningDaemon().catch(() => undefined);
  if (other && other.endpoint.pid !== process.pid) {
    console.log(JSON.stringify({ event: 'already-running', pid: other.endpoint.pid }));
    process.exit(0);
  }
}
await warnIfNativeStale();
const sessions = new Map();
const coordinator = new Coordination();
const token = process.env.POKI_MCP_TOKEN?.trim() || randomBytes(32).toString('hex');
// A short token is the only thing standing between the network and the device, and it is cheap
// to type in a shell by mistake.
if (token.length < 32) throw new Error('POKI_MCP_TOKEN must be at least 32 characters long.');
const expected = Buffer.from(`Bearer ${token}`);
const requestedBind = process.env.POKI_BIND_HOST?.trim() ?? '';
if (process.env.POKI_BIND_HOST !== undefined && !requestedBind) throw new Error('POKI_BIND_HOST is empty. Unset it to listen on 127.0.0.1.');
// Local clients are pinned to one name. `src/stdio.mjs` reads mcp.json, refuses any endpoint whose
// hostname is not `127.0.0.1`, and then sends `Host: 127.0.0.1:PORT`. `localhost` and `::1` are
// different addresses as far as that request and the Host check are concerned, so only `127.0.0.1`
// - or a wildcard, which answers on it too - keeps the local clients reachable.
const localHost = '127.0.0.1';
const wildcard = new Set(['0.0.0.0', '::']);
const answersLocalClients = host => host === localHost || wildcard.has(host);
const requested = (requestedBind || localHost).split(',').map(part => part.trim()).filter(Boolean);
if (!requested.length) throw new Error('POKI_BIND_HOST must name at least one address.');
if (requested.some(host => wildcard.has(host)) && requested.length > 1) throw new Error('POKI_BIND_HOST: a wildcard address already covers every interface, so it cannot be combined with another one.');
const bindHosts = [...new Set(requested.some(answersLocalClients) ? requested : [...requested, localHost])];
const hostAllow = (process.env.POKI_HOST_ALLOW ?? '').split(',').map(part => part.trim()).filter(Boolean);
// Binding beyond loopback without an allowlist answers 403 to every client, which reads as
// "the daemon is broken" rather than "you forgot a variable".
if (!hostAllow.length && bindHosts.some(host => !answersLocalClients(host))) throw new Error(`POKI_BIND_HOST=${bindHosts.join(',')} serves beyond ${localHost}, so POKI_HOST_ALLOW must list the Host headers your clients send.`);
const uncovered = hostAllow.length ? bindHosts.filter(host => !wildcard.has(host) && !hostAllow.includes(host)) : [];
// The same one-name rule applies to the allowlist: an entry for `localhost` or `::1` does not cover
// the `Host: 127.0.0.1:PORT` that every local client sends. Checked before `uncovered` so the error
// names the rule instead of reporting the automatically added 127.0.0.1 as an odd bind address.
if (hostAllow.length && !hostAllow.includes(localHost)) throw new Error(`POKI_HOST_ALLOW (${hostAllow.join(',')}) must include ${localHost}, because local clients connect through http://${localHost} and send that Host header.`);
if (uncovered.length) throw new Error(`POKI_HOST_ALLOW (${hostAllow.join(',')}) does not cover POKI_BIND_HOST=${uncovered.join(',')}; every request to ${uncovered.length === 1 ? 'that address' : 'those addresses'} would be rejected.`);
// A listener that other machines can reach would carry the bearer token in plain HTTP, where anyone on
// the path can copy and replay it. Those listeners serve HTTPS with POKI_TLS_CERT and POKI_TLS_KEY;
// plain HTTP beyond this machine needs POKI_ALLOW_PLAINTEXT_BIND=1, for a network that is already
// encrypted end to end. Loopback stays plain HTTP: local clients only ever dial http://127.0.0.1.
const loopback = host => host === '::1' || /^127\./.test(host);
const exposed = bindHosts.filter(host => !loopback(host));
const tlsCert = process.env.POKI_TLS_CERT?.trim(), tlsKey = process.env.POKI_TLS_KEY?.trim();
if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error('POKI_TLS_CERT and POKI_TLS_KEY must be set together.');
if (tlsCert && exposed.some(host => wildcard.has(host))) throw new Error(`POKI_BIND_HOST=${bindHosts.join(',')}: with POKI_TLS_CERT, list the addresses to serve HTTPS on instead of a wildcard. A wildcard listener would also take 127.0.0.1, where local clients speak plain HTTP.`);
if (exposed.length && !tlsCert && process.env.POKI_ALLOW_PLAINTEXT_BIND !== '1') throw new Error(`POKI_BIND_HOST=${exposed.join(',')} serves beyond this machine, where the bearer token would cross the network in plain HTTP and anyone on the path could reuse it. Set POKI_TLS_CERT and POKI_TLS_KEY to serve HTTPS there, or set POKI_ALLOW_PLAINTEXT_BIND=1 only when that network is already encrypted end to end (Tailscale, WireGuard).`);
const tls = tlsCert ? { cert: await readFile(tlsCert), key: await readFile(tlsKey) } : undefined;
const validHost = hostAllow.length ? hostHeaderValidation(hostAllow) : localhostHostValidation();
const validOrigin = localhostOriginValidation();
const active = new Set();
// MCP requests (POST /mcp) still being read or answered. A client's open GET stream is not one.
let posting = 0;
// Each session's shim sends its pid, so a shim that died without closing its session (a pool that
// reaps idle stdio processes with SIGKILL) does not keep the session, or this daemon, alive forever.
// A session without one is dropped after being idle for as long as an automatic daemon waits.
const lastSeen = new Map(), clientPids = new Map();
let lastActivity = performance.now();
const sessionBusy = session => [...coordinator.operations].some(op => op.owner === session)
  || [...coordinator.leases.values()].some(lease => lease.owner === session) || session.backgroundDevices?.size > 0;
const busyReasons = () => {
  const reasons = [];
  if (coordinator.leases.size) reasons.push(`${coordinator.leases.size} device lease(s)`);
  if (coordinator.operations.size) reasons.push(`${coordinator.operations.size} tool call(s) in progress`);
  const background = [...sessions.values()].reduce((count, session) => count + (session.backgroundDevices?.size ?? 0), 0);
  if (background) reasons.push(`background work (recording or simulated location) on ${background} device(s)`);
  return reasons;
};
async function pruneSessions() {
  for (const [id, session] of [...sessions]) {
    const pid = clientPids.get(id);
    const gone = pid ? !alive(pid) : performance.now() - (lastSeen.get(id) ?? 0) > idleExitMs;
    if (gone && !sessionBusy(session)) {
      sessions.delete(id); lastSeen.delete(id); clientPids.delete(id);
      await session.close().catch(() => {});
    }
  }
}
const versionInfo = async () => {
  const reasons = busyReasons();
  // stale: this checkout's files changed after this process loaded them.
  return { version, code: codeFingerprint, stale: await currentCodeFingerprint() !== codeFingerprint, pid: process.pid, auto, approval_mode: approval, sessions: sessions.size, busy: reasons.length > 0, busy_reasons: reasons };
};

async function handle(req, res) {
  if (!validHost(req, res) || !validOrigin(req, res)) return;
  const received = Buffer.from(req.headers.authorization ?? '');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authorization required' }));
    return;
  }
  lastActivity = performance.now();
  if (req.url === '/version') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    await pruneSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(await versionInfo())); return;
  }
  if (req.url === '/shutdown') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    // Only an automatic daemon with nothing to lose stops this way; it is how a newer shim replaces it.
    await pruneSessions();
    const reasons = busyReasons();
    // Another client's request still being read or answered counts too.
    if (posting) reasons.push(`${posting} request(s) in progress`);
    if (!auto || reasons.length) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stopped: false, auto, busy_reasons: reasons })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stopped: true }));
    console.log(JSON.stringify({ event: 'replaced' }));
    void stop();
    return;
  }
  if (!['/mcp', '/session/close', '/request/cancel'].includes(req.url)) { res.writeHead(404); res.end(); return; }
  const session = req.headers['x-poki-mcp-session'];
  if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(session)) { res.writeHead(400); res.end('Invalid session'); return; }
  lastSeen.set(session, performance.now());
  const clientPid = Number(req.headers['x-poki-mcp-client-pid']);
  if (Number.isInteger(clientPid) && clientPid > 0) clientPids.set(session, clientPid);
  if (!sessions.has(session)) sessions.set(session, new Session(coordinator));
  const devices = sessions.get(session);
  devices.peers = () => sessions.values();
  devices.label ??= session;
  if (req.url === '/session/close') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    await devices.close(); sessions.delete(session); lastSeen.delete(session); clientPids.delete(session); res.end('{}'); return;
  }
  if (req.url === '/request/cancel') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const id = req.headers['x-poki-request'];
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) { res.writeHead(400); res.end(); return; }
    devices.cancelledRequests ??= new Set();
    devices.cancelledRequests.add(id);
    const expiration = setTimeout(() => devices.cancelledRequests.delete(id), 60000); expiration.unref();
    for (const operation of coordinator.operations) if (operation.owner === devices && operation.requestId === id) operation.controller.abort(new DOMException('Request cancelled', 'AbortError'));
    res.end('{}'); return;
  }
  const server = createServer((name, args, extra) => {
    if (devices.cancelledRequests?.delete(extra?.requestId)) { devices.placed(extra?.order); throw new DOMException('Request cancelled', 'AbortError'); }
    return withCallLog(session, name, () => devices.call(name, args, extra?.signal, extra?.requestId, extra?.order));
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  active.add(server);
  const post = req.method === 'POST';
  if (post) posting++;
  res.once('close', () => { active.delete(server); if (post) posting--; void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: error.message }));
  }
}

await mkdir(stateDir, { recursive: true, mode: 0o700 });
const servers = bindHosts.map(host => tls && !loopback(host) ? https.createServer(tls, handle) : http.createServer(handle));
servers[0].listen(port, bindHosts[0]);
await once(servers[0], 'listening');
const actualPort = servers[0].address().port;
for (const [index, server] of servers.entries()) if (index > 0) server.listen(actualPort, bindHosts[index]);
await Promise.all(servers.slice(1).map(server => once(server, 'listening')));
const entry = { url: `http://127.0.0.1:${actualPort}/mcp`, port: actualPort, token, enabled: true, pid: process.pid };
const temporary = `${endpointFile}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(entry, null, 2), { mode: 0o600, flag: 'wx' });
await rename(temporary, endpointFile);
await chmod(endpointFile, 0o600);
console.log(JSON.stringify({ event: 'ready', pid: process.pid, url: entry.url, endpointFile, tools: definitions.length, auto, approval_mode: approval }));

const stopUpdateChecks = startUpdateChecks();

// Start the RemotePairing helpers now, not inside the first tool call
// that needs one: their session setup can take longer than a client's
// request timeout. Unreachable devices are retried by that first call.
for (const target of await remoteDevices().catch(() => [])) warmRemote(target).catch(() => {});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopUpdateChecks();
  const closed = Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  for (const server of servers) server.closeAllConnections();
  await Promise.allSettled([...sessions.values()].map(devices => devices.close()));
  await Promise.allSettled([...active].map(server => server.close()));
  await closeLocalHelpers();
  await closed;
  // Only our own entry: a daemon that replaced this one may have written its own already.
  await removeIf(endpointFile, content => { try { return JSON.parse(content).pid === process.pid; } catch { return false; } });
  // Whatever still holds the event loop (a helper's socket, a pending update check) must not keep a
  // stopped daemon around.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

if (auto) {
  // Idle: no session (a dead client's session is pruned), no lease, no call in progress and no
  // background work, for idleExitMs since the last of them.
  let idleSince = performance.now();
  const idleCheck = setInterval(async () => {
    await pruneSessions();
    // Two shims that both started a daemon: the one mcp.json does not name leaves once it has no clients.
    const named = await readFile(endpointFile, 'utf8').then(JSON.parse).catch(() => null);
    if (named && named.pid !== process.pid && alive(named.pid) && !sessions.size && !busyReasons().length && !posting) {
      clearInterval(idleCheck);
      console.log(JSON.stringify({ event: 'superseded', by: named.pid }));
      await stop();
      return;
    }
    if (sessions.size || busyReasons().length || posting) { idleSince = performance.now(); return; }
    if (performance.now() - Math.max(idleSince, lastActivity) >= idleExitMs) {
      clearInterval(idleCheck);
      console.log(JSON.stringify({ event: 'idle-exit', idle_ms: idleExitMs }));
      await stop();
    }
  }, Math.min(30000, Math.max(50, idleExitMs / 5)));
  process.on('exit', () => clearInterval(idleCheck));
}

const supervisedBy = Number(process.env.POKI_PARENT_PID ?? '');
if (Number.isInteger(supervisedBy) && supervisedBy > 0) {
  const watchdog = setInterval(() => {
    try { process.kill(supervisedBy, 0); } catch {
      console.error(JSON.stringify({ event: 'parent-gone', pid: supervisedBy }));
      void stop();
      return;
    }
    if (process.ppid !== supervisedBy) {
      console.error(JSON.stringify({ event: 'parent-changed', expected: supervisedBy, actual: process.ppid }));
      void stop();
    }
  }, 1500);
  watchdog.unref();
  process.on('exit', () => clearInterval(watchdog));
}

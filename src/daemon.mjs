import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
import { runningDaemon, pidNamespace } from './daemon-launch.mjs';

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
  // Not this process: it does not listen yet.
  if (other) {
    console.log(JSON.stringify({ event: 'already-running', pid: other.endpoint.pid }));
    process.exit(0);
  }
}
await warnIfNativeStale();
const sessions = new Map();
const coordinator = new Coordination();
const token = process.env.POKI_MCP_TOKEN?.trim() || randomBytes(32).toString('hex');
// This process, as opposed to another daemon at the same address with the same token (a fixed port and
// POKI_MCP_TOKEN, restarted): in mcp.json and /version, and checked on every request a shim sends.
const instance = randomUUID();
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
// Each session's stdio shim sends a heartbeat (x-poki-mcp-heartbeat-ms says how often), so a shim that
// died without closing its session (a pool that reaps idle stdio processes with SIGKILL) does not keep
// the session, or this daemon, alive forever. Such a session is closed once it has missed three
// heartbeats and has no request open, even while it still owns work: closing it stops its recordings
// and simulated locations and releases its leases, which nobody else could. Process ids are not used:
// a client may run in another PID namespace. A session without heartbeats (a direct HTTP client) is
// dropped only once it owns nothing and has been idle for as long as an automatic daemon waits.
const lastSeen = new Map(), heartbeats = new Map(), open = new Map();
// Session silence is measured on the time this daemon was running. While it was stopped (SIGSTOP, a
// paused container) or blocked, it read no heartbeats, so that stretch is not held against its shims:
// a tick every awakeTickMs notices a longer gap in its own event loop and leaves it out.
const awakeTickMs = 250, awakeSlackMs = 1000;
let awakeOffset = 0, lastTick = performance.now();
const awake = () => {
  const now = performance.now(), gap = now - lastTick;
  if (gap > awakeTickMs + awakeSlackMs) awakeOffset += gap - awakeTickMs;
  lastTick = now;
  return now - awakeOffset;
};
setInterval(awake, awakeTickMs).unref();
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
const forget = id => { sessions.delete(id); lastSeen.delete(id); heartbeats.delete(id); };
const silent = (id, session) => {
  if (open.get(id)) return false;
  const quiet = awake() - (lastSeen.get(id) ?? 0), beat = heartbeats.get(id);
  return beat ? quiet > 3 * beat + 1000 : quiet > idleExitMs && !sessionBusy(session);
};
async function pruneSessions() {
  for (const [id, session] of [...sessions]) {
    if (!silent(id, session)) continue;
    const reason = heartbeats.has(id) ? 'heartbeat' : 'idle';
    forget(id);
    console.log(JSON.stringify({ event: 'session-dropped', session: id, reason }));
    await session.close().catch(() => {});
  }
}
const versionInfo = async () => {
  const reasons = busyReasons();
  // stale: this checkout's files changed after this process loaded them.
  return { version, code: codeFingerprint, stale: await currentCodeFingerprint() !== codeFingerprint, pid: process.pid, instance, auto, approval_mode: approval, sessions: sessions.size, busy: reasons.length > 0, busy_reasons: reasons };
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
  // A shim that reached this address for another instance: 421, which it answers by finding the daemon
  // again (its order, approval mode and session start over there), as it does after a restart.
  const expectedInstance = req.headers['x-poki-mcp-instance'];
  if (typeof expectedInstance === 'string' && expectedInstance !== instance) { res.writeHead(421, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'another Poki MCP instance' })); return; }
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
  if (!['/mcp', '/session/close', '/session/heartbeat', '/request/cancel'].includes(req.url)) { res.writeHead(404); res.end(); return; }
  const session = req.headers['x-poki-mcp-session'];
  if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(session)) { res.writeHead(400); res.end('Invalid session'); return; }
  // Only an MCP request starts a session; a heartbeat, close or cancel for one this daemon does not
  // know (dropped, or held by a daemon that was replaced) changes nothing.
  if (req.url !== '/mcp' && !sessions.has(session)) { res.writeHead(req.method === 'POST' ? 404 : 405); res.end(); return; }
  lastSeen.set(session, awake());
  const beat = Number(req.headers['x-poki-mcp-heartbeat-ms']);
  if (Number.isFinite(beat) && beat > 0) heartbeats.set(session, Math.min(60000, Math.max(100, beat)));
  if (req.url === '/session/heartbeat') { if (req.method !== 'POST') { res.writeHead(405); res.end(); return; } res.end('{}'); return; }
  if (!sessions.has(session)) sessions.set(session, new Session(coordinator));
  const devices = sessions.get(session);
  devices.peers = () => sessions.values();
  devices.label ??= session;
  // A request still open keeps its session: its client is plainly there.
  open.set(session, (open.get(session) ?? 0) + 1);
  res.once('close', () => { open.set(session, open.get(session) - 1); if (!open.get(session)) open.delete(session); if (sessions.has(session)) lastSeen.set(session, awake()); });
  if (req.url === '/session/close') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    await devices.close(); forget(session); res.end('{}'); return;
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
const entry = { url: `http://127.0.0.1:${actualPort}/mcp`, port: actualPort, token, enabled: true, pid: process.pid, instance, ...(pidNamespace ? { pid_ns: pidNamespace } : {}) };
const temporary = `${endpointFile}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(entry, null, 2), { mode: 0o600, flag: 'wx' });
await rename(temporary, endpointFile);
await chmod(endpointFile, 0o600);
// mcp.json names this daemon when it holds this daemon's address and token. Pids are not compared: two
// daemons in different PID namespaces can have the same one.
const ours = named => named?.url === entry.url && named?.token === token && named?.instance === instance;
console.log(JSON.stringify({ event: 'ready', pid: process.pid, url: entry.url, endpointFile, tools: definitions.length, auto, approval_mode: approval }));

const stopUpdateChecks = startUpdateChecks();
// Sessions whose shim went quiet are dropped within a second, whichever way this daemon was started.
const pruning = setInterval(() => { void pruneSessions(); }, 1000);
pruning.unref();

// Start the RemotePairing helpers now, not inside the first tool call
// that needs one: their session setup can take longer than a client's
// request timeout. Unreachable devices are retried by that first call.
for (const target of await remoteDevices().catch(() => [])) warmRemote(target).catch(() => {});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopUpdateChecks(); clearInterval(pruning);
  const closed = Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  for (const server of servers) server.closeAllConnections();
  await Promise.allSettled([...sessions.values()].map(devices => devices.close()));
  await Promise.allSettled([...active].map(server => server.close()));
  await closeLocalHelpers();
  await closed;
  // Only our own entry. A daemon that replaces this one is started after this one has exited
  // (daemon-launch.mjs waits for that), so it cannot write its entry between this read and unlink.
  const named = await readFile(endpointFile, 'utf8').then(JSON.parse).catch(() => null);
  if (ours(named)) await unlink(endpointFile).catch(() => {});
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
    // The other one answers with the token mcp.json names, whatever PID namespace it runs in.
    const other = !sessions.size && !busyReasons().length && !posting && await readFile(endpointFile, 'utf8').then(JSON.parse).then(named => !ours(named), () => false);
    const named = other ? await runningDaemon().catch(() => undefined) : undefined;
    if (named?.info && named.endpoint.url.href !== entry.url) {
      clearInterval(idleCheck);
      console.log(JSON.stringify({ event: 'superseded', by: named.endpoint.pid }));
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

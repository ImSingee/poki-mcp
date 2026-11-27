// Finds the shared daemon for this state directory, and starts one when none is running.
//
// Every stdio shim (src/stdio.mjs) calls ensureDaemon() before its first request. Long-lived state
// (sessions, leases, recordings, the device locks) lives in that one daemon, so MCP clients that
// start and reap stdio processes freely still share it. The daemon a shim starts runs with --auto:
// it picks a free port, writes mcp.json like `npm start` does, and exits after it has been idle for
// POKI_DAEMON_IDLE_EXIT_MS. A daemon started with `npm start` is used as it is and never restarted.
import { open, readFile, unlink, mkdir, stat } from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { root, stateDir, endpointFile } from './config.mjs';
import { version } from './build-info.mjs';

export const lockFile = join(stateDir, 'daemon.lock');
export const logFile = join(stateDir, 'daemon.log');
const startTimeoutMs = 60000;

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function readEndpoint() {
  const entry = await readFile(endpointFile, 'utf8').then(JSON.parse).catch(() => null);
  if (!entry) return null;
  const url = new URL(entry.url);
  if (!entry.enabled || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/mcp') throw new Error(`Invalid local MCP endpoint in ${endpointFile}`);
  return { url, token: entry.token, pid: entry.pid };
}

// a < b for x.y.z versions; anything unparsable counts as different, so as older.
export function olderRelease(a, b) {
  const parse = value => String(value).split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  if (x.length !== 3 || y.length !== 3 || [...x, ...y].some(n => !Number.isInteger(n))) return a !== b;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

const authorized = endpoint => ({ Authorization: `Bearer ${endpoint.token}` });

// What the daemon reports about itself; throws when it does not answer.
export async function daemonInfo(endpoint) {
  const response = await fetch(new URL('/version', endpoint.url), { headers: authorized(endpoint), signal: AbortSignal.timeout(3000) });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Poki MCP answered /version with HTTP ${response.status}`), { status: response.status }); }
  return response.json();
}

async function waitForExit(pid, ms) {
  const end = performance.now() + ms;
  while (alive(pid)) {
    if (performance.now() >= end) throw new Error(`Poki MCP (pid ${pid}) did not stop within ${ms} ms.`);
    await sleep(50);
  }
}

// The lock only decides which shim starts the daemon. A holder that died leaves its pid behind,
// and that lock is broken; a lock whose holder has not written its pid yet is waited for.
async function takeLock() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try {
    const handle = await open(lockFile, 'wx', 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    return { release: async () => { if (await readFile(lockFile, 'utf8').catch(() => null) === content) await unlink(lockFile).catch(() => {}); } };
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const held = await readFile(lockFile, 'utf8').catch(() => null);
  if (held === null) return null;
  let pid;
  try { pid = JSON.parse(held).pid; } catch {}
  const stale = pid === undefined
    ? Date.now() - ((await stat(lockFile).catch(() => null))?.mtimeMs ?? Date.now()) > 10000
    : !alive(pid);
  // Compared again right before unlinking, so a lock another shim took in between is left alone.
  if (stale && await readFile(lockFile, 'utf8').catch(() => null) === held) await unlink(lockFile).catch(() => {});
  return null;
}

const logTail = () => { try { return readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch { return ''; } };

// Resolves to the started daemon's endpoint, or null when it found another daemon and left.
async function spawnDaemon(deadline) {
  const log = openSync(logFile, 'a', 0o600);
  const env = { ...process.env };
  // The daemon outlives this shim: it must not watch the shim's parent or carry its session.
  delete env.POKI_PARENT_PID; delete env.POKI_MCP_SESSION;
  let child;
  try { child = spawn(process.execPath, [join(root, 'src/daemon.mjs'), '--auto'], { detached: true, stdio: ['ignore', log, log], env, cwd: root }); }
  finally { closeSync(log); }
  let exited;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  child.once('error', error => { exited = { error }; });
  child.unref();
  while (performance.now() < deadline) {
    if (exited) {
      if (exited.code === 0) return null;
      throw new Error(`Poki MCP could not start (${exited.error?.message ?? `exit ${exited.code ?? exited.signal}`}). The end of ${logFile}:\n${logTail()}`);
    }
    const endpoint = await readEndpoint().catch(() => null);
    if (endpoint?.pid === child.pid) {
      try { await daemonInfo(endpoint); return endpoint; } catch {}
    }
    await sleep(50);
  }
  throw new Error(`Poki MCP did not become ready within ${startTimeoutMs} ms. The end of ${logFile}:\n${logTail()}`);
}

const refused = error => error?.cause?.code === 'ECONNREFUSED';

// The daemon named in mcp.json, with what it reports: null when there is none, its process is gone,
// or nothing listens on its port any more (a daemon writes mcp.json only once it listens, so a
// refused connection means it stopped or its pid now belongs to another process). undefined when
// it is there but did not answer yet.
export async function runningDaemon() {
  const endpoint = await readEndpoint().catch(() => null);
  if (!endpoint || !alive(endpoint.pid)) return null;
  try { return { endpoint, info: await daemonInfo(endpoint) }; }
  catch (error) {
    // The token in mcp.json is not the one this daemon took: waiting would not change that.
    if (error.status === 401) throw new Error(`The running Poki MCP (pid ${endpoint.pid}) rejected the token in ${endpointFile}. Stop that process; the next call starts the service again.`);
    return refused(error) ? null : undefined;
  }
}

// The endpoint of a running daemon that loaded the same code as this shim, started if needed.
export async function ensureDaemon({ timeoutMs = startTimeoutMs } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (performance.now() >= deadline) throw new Error(`Poki MCP did not become reachable within ${timeoutMs} ms. The end of ${logFile}:\n${logTail()}`);
    const running = await runningDaemon();
    if (running === undefined) { await sleep(100); continue; }
    if (running) {
      const { endpoint, info } = running;
      // Older: its own files changed since it started (an update), or it is an earlier release than this
      // shim. A shim that is itself older uses a newer daemon as it is.
      if (!info.stale && !olderRelease(info.version, version)) return endpoint;
      if (!info.auto) throw new Error(`The Poki MCP service running as pid ${info.pid} was started with npm start and runs older code (${info.version}${info.stale ? ', its files changed since it started' : ''}; this shim is ${version}). Stop it and start it again with npm start, or stop it and let this client start its own.`);
      if (info.busy) throw new Error(`The background Poki MCP (pid ${info.pid}) runs older code (${info.version}${info.stale ? ', its files changed since it started' : ''}; this shim is ${version}) and is still busy: ${info.busy_reasons.join('; ')}. Retry when that work ends, or stop it with kill ${info.pid}.`);
      const response = await fetch(new URL('/shutdown', endpoint.url), { method: 'POST', headers: authorized(endpoint), signal: AbortSignal.timeout(3000) }).catch(() => null);
      await response?.body?.cancel();
      // 409: work started in between, and the next round reports it.
      if (response?.status !== 409) await waitForExit(endpoint.pid, 15000);
      continue;
    }
    const lock = await takeLock();
    if (!lock) { await sleep(100); continue; }
    try {
      // Another shim may have started one between the check above and taking the lock.
      if (await runningDaemon() !== null) continue;
      const started = await spawnDaemon(deadline);
      if (started) return started;
    } finally { await lock.release(); }
  }
}

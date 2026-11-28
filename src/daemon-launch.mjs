// Finds the shared daemon for this state directory, and starts one when none is running.
//
// A stdio shim (src/stdio.mjs) calls ensureDaemon() only for a tools/call: nothing else it sends
// starts a daemon. The device locks and every session's state live in that one daemon, so MCP clients
// that start and reap stdio processes freely still share it, though a session ends with its shim
// (daemon.mjs drops it when its heartbeats stop). The daemon a shim starts runs with --auto:
// it picks a free port, writes mcp.json like `npm start` does, and exits after it has been idle for
// POKI_DAEMON_IDLE_EXIT_MS. A daemon started with `npm start` is used as it is and never restarted.
import { open, readFile, unlink, mkdir, stat, utimes } from 'node:fs/promises';
import { openSync, closeSync, readFileSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { root, stateDir, endpointFile } from './config.mjs';
import { version } from './build-info.mjs';

export const lockFile = join(stateDir, 'daemon.lock');
export const logFile = join(stateDir, 'daemon.log');
const startTimeoutMs = 60000;
// A shim holding the start lock touches it this often; a lock left untouched for lockStaleMs is
// stale, whoever its pid now names.
const lockTouchMs = 2000, lockStaleMs = 20000;

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// The PID namespace this process runs in (Linux), recorded beside every pid this module writes. A pid
// written in another namespace (another container sharing the state directory) says nothing here, so
// it is only checked when the namespaces match. On macOS both sides have none.
export const pidNamespace = (() => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return undefined; } })();
// One daemon's mcp.json entry: its address, token and instance id. Two daemons in different PID
// namespaces can have the same pid, and a restart on a fixed port with a fixed token the same address
// and token, so only the instance id (from every daemon since 0.2.0) tells them apart.
export const sameDaemon = (a, b) => Boolean(a && b) && String(a.url) === String(b.url) && a.token === b.token && a.instance === b.instance;
const sameNamespace = record => (record?.pid_ns ?? undefined) === pidNamespace;
// Known to be gone: its pid is checked only when it is visible from here.
const deadHere = record => sameNamespace(record) && !alive(record.pid);

export async function readEndpoint() {
  const entry = await readFile(endpointFile, 'utf8').then(JSON.parse).catch(() => null);
  if (!entry) return null;
  const url = new URL(entry.url);
  if (!entry.enabled || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/mcp') throw new Error(`Invalid local MCP endpoint in ${endpointFile}`);
  return { url, token: entry.token, pid: entry.pid, pid_ns: entry.pid_ns, instance: entry.instance };
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

// A stopping daemon removes its own mcp.json entry last (daemon.mjs stop()), so once the entry no
// longer names it, it will not touch mcp.json again and a new daemon can be started. One that died
// before removing it is gone when its pid is (seen from here) or nothing answers on its port.
async function waitForExit(endpoint, ms) {
  const end = performance.now() + ms;
  for (;;) {
    const named = await readEndpoint().catch(() => null);
    if (!sameDaemon(named, endpoint) || deadHere(endpoint)) return;
    if (performance.now() >= end) {
      if (await daemonInfo(endpoint).then(() => false, error => refused(error))) return;
      throw new Error(`Poki MCP (pid ${endpoint.pid}) did not stop within ${ms} ms.`);
    }
    await sleep(50);
  }
}

// Breaks a lock whose holder died. Shims that find the same stale lock break it one at a time,
// through a second lock: the one holding it reads the stale lock again and removes it only if it is
// still that content. While the stale lock exists no shim can create a new one, so a lock removed
// this way is never one that is in use.
async function breakStaleLock(held) {
  const breaker = `${lockFile}.break`;
  let handle;
  try { handle = await open(breaker, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Breaking takes milliseconds; an older breaker was left by a shim that died while breaking.
    const age = Date.now() - ((await stat(breaker).catch(() => null))?.mtimeMs ?? Date.now());
    if (age > 10000) await unlink(breaker).catch(() => {});
    return;
  }
  try { if (await readFile(lockFile, 'utf8').catch(() => null) === held) await unlink(lockFile).catch(() => {}); }
  finally { await handle.close(); await unlink(breaker).catch(() => {}); }
}

// The lock only decides which shim starts the daemon. Its holder touches it while it waits for the
// daemon, so a lock left untouched for lockStaleMs is stale even when its pid now names another live
// process or lives in another PID namespace; a holder that died here is seen at once.
async function takeLock() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ pid: process.pid, ...(pidNamespace ? { pid_ns: pidNamespace } : {}), nonce: randomUUID() });
  try {
    const handle = await open(lockFile, 'wx', 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    let touched = Date.now();
    return {
      touch: async () => { if (Date.now() - touched >= lockTouchMs) { touched = Date.now(); await utimes(lockFile, new Date(), new Date()).catch(() => {}); } },
      // Only this shim removes its own lock while it lives, so reading and then unlinking is safe here.
      release: async () => { if (await readFile(lockFile, 'utf8').catch(() => null) === content) await unlink(lockFile).catch(() => {}); },
    };
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const held = await readFile(lockFile, 'utf8').catch(() => null);
  if (held === null) return null;
  let holder;
  try { holder = JSON.parse(held); } catch {}
  const age = Date.now() - ((await stat(lockFile).catch(() => null))?.mtimeMs ?? Date.now());
  if (age > lockStaleMs || (Number.isInteger(holder?.pid) && deadHere(holder))) await breakStaleLock(held);
  return null;
}

// Who holds the start lock, for an error that says why nothing started.
async function lockHolder() {
  const held = await readFile(lockFile, 'utf8').catch(() => null);
  if (held === null) return '';
  let pid;
  try { pid = JSON.parse(held).pid; } catch {}
  const age = Math.round((Date.now() - ((await stat(lockFile).catch(() => null))?.mtimeMs ?? Date.now())) / 1000);
  return ` The start lock ${lockFile} is held${pid ? ` by pid ${pid}` : ''} (touched ${age} s ago); if no Poki MCP client is starting the service, delete it.`;
}

// The environment an automatically started daemon gets. It outlives the client that started it and
// serves every other client of this state directory, so it takes only what it and the host tools it
// runs need: never the starting client's secrets (POKI_IPHONE_PASSCODE, model API keys, tokens).
// POKI_DAEMON_ENV names further variables to pass, comma-separated, except those that must never
// reach it (refusedExtra).
const systemEnv = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
  // Dialogs (ask approval mode), Xcode, usbmuxd, certificates and proxies.
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'DEVELOPER_DIR', 'USBMUXD_SOCKET_ADDRESS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  // OCR (build/ocr runs tesseract) and the pinned device tool.
  'TESSDATA_PREFIX', 'IDEVICE_TOOLS']);
// Every POKI_ setting the daemon or a native helper it runs reads (test/daemon-lifecycle checks this
// against src/ and native/). Not POKI_MCP_TOKEN (an automatic daemon makes its own), and
// not POKI_PARENT_PID or POKI_MCP_SESSION, which belong to the shim's own client.
export const daemonSettings = new Set(['POKI_ALLOW_PLAINTEXT_BIND', 'POKI_BIND_HOST', 'POKI_BUILD_COMMIT', 'POKI_CUA_ACTION_CAP_MS', 'POKI_CUA_BACKEND',
  'POKI_CUA_TREE_MS', 'POKI_DAEMON_IDLE_EXIT_MS', 'POKI_HOST_ALLOW', 'POKI_INPUT_LOCK_WAIT_MS', 'POKI_MAX_CONCURRENT_READS', 'POKI_MCP_APPROVAL_MODE',
  'POKI_MCP_CALL_LOG', 'POKI_MCP_NATIVE_TRACE', 'POKI_MCP_STATE_DIR', 'POKI_MCP_TOOLS', 'POKI_NATIVE', 'POKI_NO_UPDATE_CHECK', 'POKI_PYMOBILEDEVICE3',
  'POKI_TLS_CERT', 'POKI_TLS_KEY', 'POKI_TOOL_PROFILE', 'POKI_WDA_URL',
  // Read by build/ocr and poki-native.
  'POKI_OCR_LANGS', 'POKI_OCR_PSM', 'POKI_OCR_UPSCALE', 'POKI_TYPE_KEY_MS']);
// Never passed, even when POKI_DAEMON_ENV names them: the client's secrets and the shim's own
// variables (POKI_PARENT_PID would make the detached daemon stop on its parent check).
const shimOnly = new Set(['POKI_IPHONE_PASSCODE', 'POKI_MCP_TOKEN', 'POKI_PARENT_PID', 'POKI_MCP_SESSION', 'POKI_DAEMON_ENV', 'POKI_MCP_AUTOSTART', 'POKI_MCP_HEARTBEAT_MS']);
// A secret is named by one of its _-separated words (OPENAI_API_KEY, POKI_TURN_SECRET), not by a part of
// one (KEYBOARD_LAYOUT).
const secretWords = new Set(['KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASSCODE', 'CREDENTIAL', 'CREDENTIALS']);
export const refusedExtra = name => shimOnly.has(name) || name.toUpperCase().split('_').some(word => secretWords.has(word));
export function daemonEnvironment(env = process.env, warn = message => console.error(message)) {
  const named = (env.POKI_DAEMON_ENV ?? '').split(',').map(name => name.trim()).filter(Boolean);
  // A name the daemon receives anyway (one of its own settings) is passed, not refused.
  const listed = name => systemEnv.has(name) || daemonSettings.has(name) || /^(LC_|XDG_)/.test(name);
  const refused = named.filter(name => refusedExtra(name) && !listed(name));
  if (refused.length) warn(`Poki MCP: POKI_DAEMON_ENV names ${refused.join(', ')}, which a shared service never receives; not passed.`);
  const extra = new Set(named.filter(name => !refusedExtra(name)));
  const passed = name => listed(name) || extra.has(name);
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && passed(name)));
}

const logTail = () => { try { return readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch { return ''; } };

// Resolves to the started daemon's endpoint, or null when it found another daemon and left.
async function spawnDaemon(deadline, lock) {
  const log = openSync(logFile, 'a', 0o600);
  const env = daemonEnvironment();
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
    // Ready: ours, or another one that won a race to start (ours then leaves by itself).
    const running = await runningDaemon().catch(() => undefined);
    if (running && (running.endpoint.pid === child.pid || running.info.auto)) return { ...running.endpoint, info: running.info };
    await lock.touch();
    await sleep(50);
  }
  throw new Error(`Poki MCP did not become ready within ${startTimeoutMs} ms. The end of ${logFile}:\n${logTail()}`);
}

const refused = error => error?.cause?.code === 'ECONNREFUSED';

// The daemon named in mcp.json, with what it reports: null when there is none, its process is gone,
// or nothing listens on its port any more (a daemon writes mcp.json only once it listens, so a
// refused connection means it stopped). undefined when it is there but did not answer yet. Whether
// it runs is decided by its answer, not its pid, which may belong to another PID namespace.
export async function runningDaemon() {
  const endpoint = await readEndpoint().catch(() => null);
  if (!endpoint || deadHere(endpoint)) return null;
  try { return { endpoint, info: await daemonInfo(endpoint) }; }
  catch (error) {
    // A daemon from before 0.2.0 has no /version, and only npm start started those.
    if (error.status === 404) return { endpoint, info: { version: 'before 0.2.0', stale: true, auto: false, pid: endpoint.pid, busy: false, busy_reasons: [] } };
    // The token in mcp.json is not the one this daemon took: waiting would not change that.
    if (error.status === 401) throw new Error(`The running Poki MCP (pid ${endpoint.pid}) rejected the token in ${endpointFile}. Stop that process; the next call starts the service again.`);
    return refused(error) ? null : undefined;
  }
}

// The endpoint of a running, current daemon (started if needed), with what its /version answered as info.
export async function ensureDaemon({ timeoutMs = startTimeoutMs } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (performance.now() >= deadline) throw new Error(`Poki MCP did not become reachable within ${timeoutMs} ms.${await lockHolder()} The end of ${logFile}:\n${logTail()}`);
    const running = await runningDaemon();
    if (running === undefined) { await sleep(100); continue; }
    if (running) {
      const { endpoint, info } = running;
      // Older: its own files changed since it started (an update), or it is an earlier release than this
      // shim. A shim that is itself older uses a newer daemon as it is.
      if (!info.stale && !olderRelease(info.version, version)) return { ...endpoint, info };
      if (!info.auto) throw new Error(`The Poki MCP service running as pid ${info.pid} was started with npm start and runs older code (${info.version}${info.stale ? ', its files changed since it started' : ''}; this shim is ${version}). Stop it and start it again with npm start, or stop it and let this client start its own.`);
      if (info.busy) throw new Error(`The background Poki MCP (pid ${info.pid}) runs older code (${info.version}${info.stale ? ', its files changed since it started' : ''}; this shim is ${version}) and is still busy: ${info.busy_reasons.join('; ')}. Retry when that work ends, or stop it with kill ${info.pid}.`);
      const response = await fetch(new URL('/shutdown', endpoint.url), { method: 'POST', headers: authorized(endpoint), signal: AbortSignal.timeout(3000) }).catch(() => null);
      await response?.body?.cancel();
      // 409: work started in between, and the next round reports it.
      if (response?.status !== 409) await waitForExit(endpoint, 15000);
      continue;
    }
    const lock = await takeLock();
    if (!lock) { await sleep(100); continue; }
    try {
      // Another shim may have started one between the check above and taking the lock.
      if (await runningDaemon() !== null) continue;
      const started = await spawnDaemon(deadline, lock);
      if (started) return started;
    } finally { await lock.release(); }
  }
}

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { mkdir, readFile, lstat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { lines as lineReader } from './lines.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root, stateDir } from './config.mjs';
import { checkWork, signal, phase } from './work.mjs';

const starting = new Map();
// The pid each RemotePairing helper greeted with, by socket path: a helper busy with one long request
// (a developer disk image installation) answers no one else, so disconnectRemote may have to stop it.
const helperPids = new Map();
const localHelpers = new Map();
const readOnly = new Set(['ax_tree', 'screenshot', 'device_info', 'display_info', 'panels', 'list_apps']);
let closing = false;

async function stopLocalHelper({ child, exited }) {
  child.kill('SIGTERM');
  const escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
  try { await exited; }
  finally { clearTimeout(escalation); }
}

export async function closeLocalHelpers() {
  closing = true;
  await Promise.allSettled([...localHelpers.values()].map(stopLocalHelper));
}

export async function remoteDevices() {
  let configs;
  try { configs = JSON.parse(await readFile(join(stateDir, 'remote-devices.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(configs)) throw new Error('remote-devices.json must contain an array.');
  return configs.map(config => {
    if (typeof config.id !== 'string' || typeof config.config_path !== 'string' || !config.config_path.startsWith('/')) throw new Error('Invalid remote device configuration.');
    return { id: config.id, name: config.name ?? config.id, kind: 'physical', connection: 'RemotePairing', remote: config.config_path };
  });
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

// macOS Unix socket names are limited to 104 bytes, regardless of the state directory's length.
async function socketPath(target) {
  const directory = `/tmp/poki-${target.remote ? 'remote' : 'native'}-${process.getuid()}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Remote socket directory must be private and owned by this user.');
  return join(directory, createHash('sha256').update(target.remote ?? JSON.stringify([root, stateDir, process.pid, target.id])).digest('hex').slice(0, 24) + '.sock');
}

// Asks a running RemotePairing helper to close its tunnel and exit. A helper that is not running is
// left alone: none is started just to stop it. One that does not confirm in time (busy with another
// request) is stopped with SIGTERM when this daemon knows its pid. Resolves { running, disconnected,
// stopped? }.
export async function disconnectRemote(target, { timeoutMs = 5000 } = {}) {
  const path = await socketPath(target);
  // A helper still starting (for a call that was aborted meanwhile) would come up after this and
  // serve a configuration about to be deleted: let it finish starting, then stop it too.
  await starting.get(path)?.catch(() => {});
  let socket;
  try { socket = await connect(path); }
  catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { running: false, disconnected: false }; throw error; }
  const result = await askToDisconnect(socket, path, timeoutMs);
  if (result.disconnected) { helperPids.delete(path); return result; }
  const pid = helperPids.get(path);
  if (!pid) return { ...result, stopped: false, note: 'The helper did not confirm and its process is unknown to this service; it ends when its tunnel closes or the computer restarts.' };
  const stopped = await stopProcess(pid);
  helperPids.delete(path);
  if (stopped) await unlink(path).catch(() => {});
  return { ...result, stopped, pid };
}

// Whether a process has exited. A zombie (exited, not yet reaped: its parent is a PID 1 that does not
// reap adopted children, such as a container started without --init) has exited too, though
// kill(pid, 0) still succeeds for it.
export function processGone(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  try {
    if (process.platform === 'linux') return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return /^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch { return false; }
}

// SIGTERM, then SIGKILL after two seconds. Resolves whether the process is gone.
async function stopProcess(pid) {
  const gone = () => processGone(pid);
  try { process.kill(pid, 'SIGTERM'); } catch (error) { return error.code === 'ESRCH'; }
  for (let waited = 0; waited < 4000; waited += 50) {
    if (gone()) return true;
    if (waited === 2000) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return gone();
}

function askToDisconnect(socket, path, timeoutMs) {
  return new Promise(resolve => {
    const lines = lineReader(socket);
    let greeted = false, reply;
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    lines.on('line', line => {
      if (!greeted) {
        greeted = true;
        try { const { pid } = JSON.parse(line); if (Number.isSafeInteger(pid) && pid > 1) helperPids.set(path, pid); } catch {}
        socket.write('{"op":"disconnect"}\n');
        return;
      }
      try { reply = JSON.parse(line); } catch {}
      socket.end();
    });
    socket.on('error', () => {});
    socket.once('close', async () => {
      clearTimeout(timer); lines.close();
      const disconnected = reply?.disconnected === true;
      // The helper is gone, and so is the configuration its socket is named after: nothing reuses it.
      if (disconnected) await unlink(path).catch(() => {});
      resolve({ running: true, disconnected });
    });
  });
}

async function socketFor(target) {
  if (!target.remote && closing) throw new Error('Local native helpers are shutting down.');
  const path = await socketPath(target);
  try { return { socket: await connect(path), path }; }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  if (!starting.has(path)) {
    const started = (async () => {
      const previous = localHelpers.get(path);
      if (previous) await stopLocalHelper(previous);
      try {
        const stale = await lstat(path);
        if (!stale.isSocket() || stale.uid !== process.getuid()) throw new Error('Unexpected file at the remote socket path.');
        await unlink(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!target.remote && closing) throw new Error('Local native helpers are shutting down.');
      const args = target.remote ? ['--remote-server', target.remote, path] : ['--local-server', target.id, path];
      const child = spawn(join(root, 'build/poki-native'), args, { detached: Boolean(target.remote), stdio: [target.remote ? 'ignore' : 'pipe', 'pipe', process.env.POKI_MCP_NATIVE_TRACE ? 'inherit' : 'pipe'] });
      if (process.env.POKI_MCP_NATIVE_TRACE) console.error(JSON.stringify({ event: 'native_helper_started', pid: child.pid, transport: target.remote ? 'remote' : 'local' }));
      // Keep draining stderr for the helper's lifetime: a closed pipe would turn its later writes into a panic.
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); }).unref();
      if (!target.remote) {
        const exited = once(child, 'exit').catch(() => {}).then(async () => {
          await unlink(path).catch(() => {});
          if (localHelpers.get(path)?.child === child) localHelpers.delete(path);
        });
        localHelpers.set(path, { child, exited });
        child.stdin.on('error', () => {});
      }
      const lines = lineReader(child.stdout);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Remote helper did not start.')); }, 5000);
          const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
          child.once('error', () => done(new Error('Cannot start remote helper. Run bin/setup.')));
          child.once('close', (code, signal) => {
            const status = signal ? `signal ${signal}` : `exit code ${code}`;
            const tail = stderr.trim().split('\n').slice(-5).join('\n');
            const hint = signal === 'SIGKILL' ? ' This can happen when build/poki-native is overwritten while an older helper still runs. Run ./bin/build-native again, then restart Poki.' : '';
            done(new Error(`${target.remote ? 'Remote' : 'Native'} helper stopped before becoming ready (${status}).${hint}${tail ? `\nHelper stderr:\n${tail}` : ''}`));
          });
          lines.once('line', line => { if (line === '{"ready":true}') done(); else done(new Error('Invalid remote helper greeting.')); });
        });
      } finally { lines.close(); child.stdout.destroy(); child.unref(); }
    })();
    starting.set(path, started);
    started.finally(() => starting.delete(path)).catch(() => {});
  }
  await starting.get(path);
  return { socket: await connect(path), path };
}

// The first request to a remote device otherwise pays for starting the
// helper and establishing its device session inline, inside that tool
// call, where it can outlast the client's own request timeout and make
// the call look hung. Warming at daemon start moves the cost off the
// first call. A failure only means the device is unreachable right now;
// the first real call then pays the same cost it always did.
export async function warmRemote(target) {
  await nativeRequest(target, { op: 'device_info' });
}

// timeoutMs: how long the helper may take to answer (default two minutes). Installing a developer disk
// image over Wi-Fi takes longer.
export async function nativeRequest(target, request, { timeoutMs = 120000 } = {}) {
  checkWork();
  const callerSignal = signal();
  const { socket, path } = await phase('native_helper', () => socketFor(target));
  try { checkWork(); } catch (error) { socket.destroy(); throw error; }
  return phase('native_request', () => new Promise((resolve, reject) => {
    const lines = lineReader(socket);
    let pid, outcome, abortReason;
    const abort = reason => {
      abortReason = reason;
      socket.destroy();
    };
    const onAbort = () => abort(callerSignal.reason);
    const timer = setTimeout(() => abort(new DOMException('Remote operation timed out; inspect before retrying input.', 'TimeoutError')), timeoutMs);
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    lines.on('line', line => {
      if (abortReason) return;
      let value;
      try { value = JSON.parse(line); } catch { abort(new Error('Invalid remote helper response. Inspect before retrying input.')); return; }
      if (!pid) {
        if (!Number.isSafeInteger(value.pid) || value.pid <= 1) { abort(new Error('Invalid remote helper identity.')); return; }
        pid = value.pid;
        if (target.remote) helperPids.set(path, pid);
        if (callerSignal?.aborted) { abort(callerSignal.reason); return; }
        socket.write(JSON.stringify(request) + '\n');
      } else { outcome = value; socket.end(); }
    });
    const helperName = target.remote ? 'Remote' : 'Native';
    socket.on('error', () => { abortReason ??= new Error(!target.remote && readOnly.has(request.op) ? 'Native helper connection closed during a read.' : `${helperName} helper connection closed. Input may have been delivered; inspect before retrying.`); });
    socket.once('close', async () => {
      clearTimeout(timer); lines.close();
      callerSignal?.removeEventListener('abort', onAbort);
      // A local helper finishes an abandoned read before serving anyone else, so end it as a one-shot read would end.
      const helper = !target.remote && pid && !outcome && abortReason && readOnly.has(request.op) && localHelpers.get(path);
      if (helper && helper.child.pid === pid) await stopLocalHelper(helper);
      if (abortReason) reject(abortReason);
      else if (!outcome) reject(new Error(`${helperName} helper closed without confirming the action. Inspect before retrying input.`));
      else if (outcome.transport_error) reject(new Error(outcome.error ?? 'Remote operation failed.'));
      else resolve(outcome);
    });
  }));
}

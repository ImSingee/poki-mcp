import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, lstat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { lines as lineReader } from './lines.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root, stateDir } from './config.mjs';
import { checkWork, signal, phase } from './work.mjs';

const starting = new Map();
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

async function socketFor(target) {
  // macOS Unix socket names are limited to 104 bytes, regardless of the state directory's length.
  if (!target.remote && closing) throw new Error('Local native helpers are shutting down.');
  const directory = `/tmp/poki-${target.remote ? 'remote' : 'native'}-${process.getuid()}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Remote socket directory must be private and owned by this user.');
  const path = join(directory, createHash('sha256').update(target.remote ?? JSON.stringify([root, stateDir, process.pid, target.id])).digest('hex').slice(0, 24) + '.sock');
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

export async function nativeRequest(target, request) {
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
    const timer = setTimeout(() => abort(new DOMException('Remote operation timed out; inspect before retrying input.', 'TimeoutError')), 120000);
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    lines.on('line', line => {
      if (abortReason) return;
      let value;
      try { value = JSON.parse(line); } catch { abort(new Error('Invalid remote helper response. Inspect before retrying input.')); return; }
      if (!pid) {
        if (!Number.isSafeInteger(value.pid) || value.pid <= 1) { abort(new Error('Invalid remote helper identity.')); return; }
        pid = value.pid;
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

// media_subscribe: the phone's screen video over its own connection to the helper. Resolves with
// the helper's reply once subscribed; then onFrame receives each frame until either side closes
// (`closed` resolves). Frames: u32 length | u8 flags | u64 seq | u64 pts_us | u16 config length |
// config | Annex-B (native/bridge/src/video.rs).
export async function nativeSubscribe(target, onFrame) {
  const { socket } = await socketFor(target);
  let buffer = Buffer.alloc(0), stage = 'hello', resolveReply, rejectReply, resolveClosed;
  const replied = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const fail = error => { rejectReply(error); socket.destroy(); };
  socket.on('data', chunk => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (stage !== 'frames') {
      const newline = buffer.indexOf(10);
      if (newline < 0) { if (buffer.length > 65536) fail(new Error('Invalid native helper reply.')); return; }
      let value;
      try { value = JSON.parse(buffer.subarray(0, newline).toString('utf8')); } catch { fail(new Error('Invalid native helper reply.')); return; }
      buffer = buffer.subarray(newline + 1);
      if (stage === 'hello') {
        if (!Number.isSafeInteger(value.pid) || value.pid <= 1) { fail(new Error('Invalid native helper identity.')); return; }
        stage = 'reply';
        socket.write(JSON.stringify({ op: 'media_subscribe' }) + '\n');
      } else {
        if (!value.subscribed) { fail(Object.assign(new Error(value.error ?? 'The screen video could not start.'), { reason: value.reason })); return; }
        stage = 'frames';
        resolveReply(value);
      }
    }
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length < 19 || length > 64 * 1024 * 1024) { socket.destroy(new Error('Invalid screen frame.')); return; }
      if (buffer.length < 4 + length) return;
      const frame = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      const flags = frame[0], configLength = frame.readUInt16BE(17);
      if (19 + configLength > frame.length) { socket.destroy(new Error('Invalid screen frame.')); return; }
      onFrame({
        seq: Number(frame.readBigUInt64BE(1)), pts_us: Number(frame.readBigUInt64BE(9)),
        key: Boolean(flags & 1), reset: Boolean(flags & 4),
        config: flags & 2 ? Buffer.from(frame.subarray(19, 19 + configLength)) : undefined,
        data: Buffer.from(frame.subarray(19 + configLength)),
      });
    }
  });
  socket.on('error', error => fail(error));
  socket.on('close', () => { rejectReply(new Error('The native helper closed the screen video.')); resolveClosed(); });
  const reply = await replied;
  return { reply, closed, close: () => socket.destroy() };
}

export function nativeKeyframe(target) {
  return nativeRequest(target, { op: 'media_keyframe' });
}


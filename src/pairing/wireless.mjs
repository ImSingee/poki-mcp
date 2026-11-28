// iOS 27 wireless first pairing: `poki-native --pair-host` advertises this computer over Bonjour,
// prints NDJSON events (advertising, pin, paired), and writes the pairing record once the person
// accepts the PIN on the iPhone. bin/prepare-remote.mjs --wireless and the daemon's pairing jobs
// (src/pairing/jobs.mjs) both drive it through this module.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { stateDir as defaultStateDir, pokiNative } from '../config.mjs';
import { lines } from '../lines.mjs';
import { registerRemote, remoteDirectory, validHost, validId } from './registry.mjs';

export const defaultHostName = () => hostname() || 'poki-mcp';
export const defaultRemotePort = 49152;

export const advertisingInstruction = name => `On the iPhone, open Settings › Privacy & Security › Developer Mode and tap “Pair with ${name}”.`;
export const pinInstruction = pin => `Enter this code on the iPhone: ${pin}`;

// A private staging directory for the pairing record, removed by the caller when pairing ends.
export async function stagePairing({ stateDir = defaultStateDir } = {}) {
  const remoteRoot = join(stateDir, 'remote');
  await mkdir(remoteRoot, { recursive: true, mode: 0o700 });
  await chmod(remoteRoot, 0o700);
  const directory = await mkdtemp(join(remoteRoot, 'wireless-'));
  await chmod(directory, 0o700);
  return { directory, pairing: join(directory, 'pairing.plist'), hostState: join(remoteRoot, 'host') };
}

// poki-native reports a failure as one JSON line on stderr ({"error": ...}); anything else is shown as is.
export function helperError(stderr) {
  const last = stderr.trim().split('\n').at(-1) ?? '';
  try { const parsed = JSON.parse(last); if (typeof parsed?.error === 'string') return parsed.error; } catch {}
  return stderr.trim();
}

// Starts the helper. `events` emits each parsed NDJSON line as 'event' and by its own name;
// `done` resolves with the paired event, or rejects with an Error whose `signal`, `code`,
// `cancelled` and `stderr` say how the helper ended.
export function startPairHost({ name, hostState, output, native = pokiNative }) {
  const events = new EventEmitter();
  // Standard input stays open and unused: the helper stops when it closes, which is how it learns
  // that this process died without cancelling it.
  const child = spawn(native, ['--pair-host', hostState, output, name, '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let stderr = '', paired, cancelled = false;
  lines(child.stdout).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event.event !== 'string') return;
    if (event.event === 'paired') paired = event;
    if (event.event === 'cancelled') cancelled = true;
    events.emit('event', event);
    events.emit(event.event, event);
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const done = new Promise((resolve, reject) => {
    child.once('error', error => reject(Object.assign(new Error(`Cannot start ${native}: ${error.message}. Run ./bin/setup.`), { spawnError: true })));
    child.once('close', (code, signal) => {
      if (code === 0 && paired) return resolve(paired);
      const message = signal ? `Wireless pairing stopped with ${signal}.`
        : cancelled ? 'Wireless pairing was cancelled.'
        : helperError(stderr) || `Wireless pairing did not complete (exit ${code}).`;
      reject(Object.assign(new Error(message), { code, signal, cancelled: cancelled || Boolean(signal), stderr: stderr.trim() }));
    });
  });
  done.catch(() => {});
  return { child, events, done };
}

// Moves the pairing record into the device's directory and registers it. `host` overrides the
// address the phone paired from.
export async function completeWirelessPairing(result, { pairing, host, port = defaultRemotePort, stateDir = defaultStateDir }) {
  const id = result.device?.udid;
  if (!validId(id ?? '')) throw new Error('Wireless pairing finished without a valid device identifier.');
  const address = host ?? result.peer;
  if (!validHost(address)) throw new Error('Wireless pairing finished without a usable device address. Pass the iPhone\'s .local name, LAN address, or Tailscale address as the host.');
  const directory = remoteDirectory(id, stateDir);
  const saved = join(directory, 'pairing.plist');
  const name = result.device?.name || id;
  // The record moves into place inside the registry transaction (see registerRemote).
  await registerRemote(id, name, address, port, saved, { stateDir, record: pairing });
  return { id, name, host: address, port, model: result.device?.model, config_path: join(directory, 'config.json') };
}

export const discardStaging = directory => rm(directory, { recursive: true, force: true });

import { readFileSync } from 'node:fs';
import { readdir, stat, access, constants, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { root } from './config.mjs';

export const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const execute = promisify(execFile);
const bridge = join(root, 'build/poki-native');

async function codeMarker() {
  const files = (await readdir(join(root, 'src'), { recursive: true }))
    .filter(file => file.endsWith('.mjs')).map(file => join('src', file));
  files.push('package.json', 'build/poki-native');
  return JSON.stringify(await Promise.all(files.sort().map(async file => {
    const info = await stat(join(root, file)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return [file, info && [info.mtimeMs, info.ctimeMs, info.size, info.ino]];
  })));
}

const startupCode = await codeMarker();
// Identifies the code this process loaded, so a shim can tell whether a running daemon loaded the same.
const fingerprint = marker => createHash('sha256').update(marker).digest('hex').slice(0, 16);
export const codeFingerprint = fingerprint(startupCode);
// The code on disk now, which a running daemon must match (see daemon-launch.mjs).
export const currentCodeFingerprint = async () => fingerprint(await codeMarker());

// How this process was started: 'auto' when a stdio shim started it (daemon.mjs --auto), which a
// shim replaces by itself; 'manual' for npm start, which only its operator restarts.
let serviceStart = 'manual';
export function setServiceStart(value) { serviceStart = value; }
// Thrown before a tool touches a device, so the call can be sent again to a restarted service.
export async function requireCurrentCode() {
  if (await codeMarker() !== startupCode) {
    throw Object.assign(new Error(serviceStart === 'auto'
      ? 'The service is running old code: its files changed after it started. It is replaced once it is idle; send the call again.'
      : 'The service is running old code. Stop the running service and restart it with npm start.'), { code: 'stale_code', serviceStart });
  }
}

export async function buildInfo() {
  // A container image has no git, so its build records the commit in build/commit (or POKI_BUILD_COMMIT).
  const recorded = async () => process.env.POKI_BUILD_COMMIT?.trim() || (await readFile(join(root, 'build/commit'), 'utf8').catch(() => '')).trim() || 'unknown';
  const [commit, native] = await Promise.all([
    execute('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 1000 }).then(result => result.stdout.trim() || recorded(), recorded),
    stat(bridge).catch(() => null),
  ]);
  return { commit, native_build: native?.mtime.toISOString() ?? 'unknown' };
}

export async function warnIfNativeStale() {
  const native = await stat(bridge).catch(() => null);
  if (!native) return;
  const directory = join(root, 'native/bridge');
  const files = await readdir(directory, { recursive: true }).catch(() => []);
  for (const file of files.filter(file => /(?:\.rs|Cargo\.toml|Cargo\.lock)$/.test(file) && !file.split('/').includes('target'))) {
    const source = await stat(join(directory, file)).catch(() => null);
    if (source?.mtimeMs > native.mtimeMs) {
      console.error('Warning: build/poki-native is older than its source; run ./bin/build-native when the device is available. Continuing with the existing bridge.');
      return;
    }
  }
}

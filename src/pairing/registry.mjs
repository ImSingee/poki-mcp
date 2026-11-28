// The RemotePairing registry: <state>/remote-devices.json lists every phone reached over the network,
// and <state>/remote/<id>/ holds its config.json and pairing record. Both bin/prepare-remote.mjs and
// the daemon's pairing jobs write it; src/remote.mjs reads it on every inventory, so a change shows in
// list_devices at once.
import { mkdir, readFile, writeFile, rename, chmod, rm, open, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { stateDir as defaultStateDir } from '../config.mjs';

export const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id);
export const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;
// Keep the Bonjour name, not a setup-time address: DHCP can change it later.
export const isBonjour = host => typeof host === 'string' && host.length <= 254 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local\.?$/i.test(host);
export const validHost = host => isIP(host ?? '') !== 0 || isBonjour(host);

export const registryFile = (stateDir = defaultStateDir) => join(stateDir, 'remote-devices.json');
export const remoteDirectory = (id, stateDir = defaultStateDir) => {
  if (!validId(id)) throw new Error(`Invalid device id ${JSON.stringify(id)}.`);
  return join(stateDir, 'remote', id);
};

export async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

// A registry change reads the file, changes it and writes it back. Changes run one at a time within a
// process (this chain) and across processes (a lock file next to the registry), so bin/prepare-remote
// registering one phone while the service unpairs another cannot bring a removed entry back or drop a
// new one.
let writes = Promise.resolve();
const serialized = (stateDir, task, lock) => {
  const result = writes.then(() => withRegistryLock(stateDir, task, lock));
  writes = result.catch(() => {});
  return result;
};
const lockStaleMs = 10000, lockWaitMs = 15000;
// Test hook: lets a test pause a process after it confirmed a lock is stale and before it removes it.
export const lockHooks = { beforeUnlinkStale: undefined, beforeUnlinkStaleBreaker: undefined };

async function createExclusive(path, content) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(content); } finally { await handle.close(); }
}
const ageOf = async path => Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? Date.now());

// Removes a stale lock that still holds `held`, and says whether it did. Two processes may find the
// same stale lock, and the one that removes it may already hold a new lock by the time the other
// gets here, so removal happens only under a second, exclusive break lock, with the content read
// again under it. The break lock carries its owner's token, and is removed only by that owner, or,
// once it is itself stale (its owner died inside a section that takes milliseconds), only while it
// still holds the token that made it look stale.
async function reclaimStale(lock, held, token) {
  const breaker = `${lock}.break`;
  try { await createExclusive(breaker, token); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readFile(breaker, 'utf8').catch(() => null);
    if (owner !== null && await ageOf(breaker) > lockStaleMs) {
      await lockHooks.beforeUnlinkStaleBreaker?.();
      if (await readFile(breaker, 'utf8').catch(() => null) === owner) await unlink(breaker).catch(() => {});
    }
    return false;
  }
  try {
    if (await readFile(lock, 'utf8').catch(() => null) !== held) return false;
    await lockHooks.beforeUnlinkStale?.();
    await unlink(lock).catch(() => {});
    return true;
  } finally { if (await readFile(breaker, 'utf8').catch(() => null) === token) await unlink(breaker).catch(() => {}); }
}

export async function acquireFileLock(lock, { waitMs = lockWaitMs } = {}) {
  const mine = JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString('hex') });
  const deadline = Date.now() + waitMs;
  while (true) {
    try { await createExclusive(lock, mine); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A change takes milliseconds: a lock this old was left by a process that died holding it.
      const held = await readFile(lock, 'utf8').catch(() => null);
      const age = await ageOf(lock);
      // Removed: try again at once. Otherwise someone else holds it or is reclaiming it: wait.
      if (held !== null && age > lockStaleMs && await reclaimStale(lock, held, mine)) continue;
      if (Date.now() > deadline) throw new Error(`${lock} has been held for ${Math.round(age / 1000)} s by ${held ?? 'another process'}. If no pairing is being saved, delete it.`);
      await delay(10 + Math.random() * 20);
    }
  }
  return async () => { if (await readFile(lock, 'utf8').catch(() => null) === mine) await unlink(lock).catch(() => {}); };
}

async function withRegistryLock(stateDir, task, lock) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(`${registryFile(stateDir)}.lock`, lock);
  try { return await task(); }
  finally { await release(); }
}

async function readRegistry(stateDir) {
  try {
    const configs = JSON.parse(await readFile(registryFile(stateDir), 'utf8'));
    if (!Array.isArray(configs)) throw new Error('remote-devices.json must contain an array.');
    return configs;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// record: a pairing record to move to pairingFile in the same transaction, so a removal running in
// another process cannot delete it between the move and the registration.
export function registerRemote(id, name, host, port, pairingFile, { stateDir = defaultStateDir, record } = {}) {
  return serialized(stateDir, async () => {
    const directory = remoteDirectory(id, stateDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    if (record) {
      await rename(record, pairingFile);
      await chmod(pairingFile, 0o600);
    }
    const configPath = join(directory, 'config.json');
    await writeJson(configPath, { id, host, port, pairing_file: pairingFile });
    const configs = (await readRegistry(stateDir)).filter(d => d.id !== id);
    configs.push({ id, name, config_path: configPath });
    await writeJson(registryFile(stateDir), configs);
    return { id, name, config_path: configPath };
  });
}

// Removes the device's registry entry and its private directory (config and pairing record).
// Returns the entry that was removed, or undefined when the device was not registered.
// waitMs: how long to wait for another process's registry lock before failing.
export function unregisterRemote(id, { stateDir = defaultStateDir, waitMs } = {}) {
  return serialized(stateDir, async () => {
    const directory = remoteDirectory(id, stateDir);
    const configs = await readRegistry(stateDir);
    const removed = configs.find(d => d.id === id);
    if (removed) await writeJson(registryFile(stateDir), configs.filter(d => d.id !== id));
    await rm(directory, { recursive: true, force: true });
    return removed;
  }, waitMs === undefined ? undefined : { waitMs });
}

// The registered phones as RemotePairing targets (the shape src/remote.mjs uses).
export async function registeredTargets({ stateDir = defaultStateDir } = {}) {
  return (await readRegistry(stateDir)).map(entry => ({ id: entry.id, name: entry.name ?? entry.id, kind: 'physical', connection: 'RemotePairing', remote: entry.config_path }));
}

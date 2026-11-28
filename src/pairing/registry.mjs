// The RemotePairing registry: <state>/remote-devices.json lists every phone reached over the network,
// and <state>/remote/<id>/ holds its config.json and pairing record. Both bin/prepare-remote.mjs and
// the daemon's pairing jobs write it; src/remote.mjs reads it on every inventory, so a change shows in
// list_devices at once.
import { mkdir, readFile, writeFile, rename, chmod, rm } from 'node:fs/promises';
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

// Writes within this process run one at a time, so a pairing that finishes while another device is
// being removed cannot drop either change.
let writes = Promise.resolve();
const serialized = task => {
  const result = writes.then(task);
  writes = result.catch(() => {});
  return result;
};

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

export function registerRemote(id, name, host, port, pairingFile, { stateDir = defaultStateDir } = {}) {
  return serialized(async () => {
    const directory = remoteDirectory(id, stateDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
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
export function unregisterRemote(id, { stateDir = defaultStateDir } = {}) {
  return serialized(async () => {
    const directory = remoteDirectory(id, stateDir);
    const configs = await readRegistry(stateDir);
    const removed = configs.find(d => d.id === id);
    if (removed) await writeJson(registryFile(stateDir), configs.filter(d => d.id !== id));
    await rm(directory, { recursive: true, force: true });
    return removed;
  });
}

// The registered phones as RemotePairing targets (the shape src/remote.mjs uses).
export async function registeredTargets({ stateDir = defaultStateDir } = {}) {
  return (await readRegistry(stateDir)).map(entry => ({ id: entry.id, name: entry.name ?? entry.id, kind: 'physical', connection: 'RemotePairing', remote: entry.config_path }));
}

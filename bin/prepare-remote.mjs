#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, chmod, stat, mkdtemp, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { root, stateDir, idevice, pokiNative } from '../src/config.mjs';

const exec = promisify(execFile);
const validId = id => /^[a-zA-Z0-9-]+$/.test(id);
const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;
const usage = 'Usage: node bin/prepare-remote.mjs DEVICE_ID TAILSCALE_IP [PORT]\n   or: node bin/prepare-remote.mjs --wireless [HOST] [--port PORT] [--name HOST_NAME]';

async function writeJson(file, value) {
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function registerRemote(id, name, host, port, pairingFile) {
  const configPath = join(stateDir, 'remote', id, 'config.json');
  await writeJson(configPath, { id, host, port, pairing_file: pairingFile });
  let configs = [];
  const registry = join(stateDir, 'remote-devices.json');
  try { configs = JSON.parse(await readFile(registry, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  configs = configs.filter(d => d.id !== id);
  configs.push({ id, name, config_path: configPath });
  await writeJson(registry, configs);
}

async function prepareUsb([id, host, portText = '49152']) {
  const port = Number(portText);
  if (!id || !validId(id) || !isIP(host) || !validPort(port)) throw new Error(usage + '. Connect the trusted iPhone by USB and Wi-Fi first.');
  const devices = JSON.parse((await exec('python3', [join(root, 'native/devices.py')])).stdout);
  if (!devices.some(d => d.id === id && d.connection === 'USB')) throw new Error('The selected iPhone must be connected over USB for initial pairing.');
  const directory = join(stateDir, 'remote', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const pairing = join(directory, 'pairing.plist');
  try { await stat(pairing); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await exec(idevice, ['--udid', id, 'remotepairing_lockdown', 'pair', 'poki-mcp', pairing], { timeout: 45000 }); }
    catch { throw new Error('USB RemotePairing did not complete. Keep the trusted iPhone connected and unlocked.'); }
    await stat(pairing);
  }
  await chmod(pairing, 0o600);
  const verification = await exec(idevice, ['--udid', id, 'remotepairing_lockdown', 'verify', pairing, 'poki-mcp'], { timeout: 30000 });
  if (!verification.stdout.includes('the device recognizes this pairing record')) throw new Error('The iPhone did not verify the saved pairing record. Keep it trusted, unlocked, and connected over USB. Rename remote/DEVICE_ID/pairing.plist in this installation\'s private state directory, then run prepare-remote again. See docs/remote-iphone.md.');
  const name = JSON.parse((await exec(idevice, ['--udid', id, 'lockdown', 'get', 'DeviceName'], { timeout: 15000 })).stdout);
  await registerRemote(id, name, host, port, pairing);
  console.log(JSON.stringify({ paired: true, device: id, next: 'Start Poki and call list_devices while Wi-Fi is connected. Keep the daemon running when switching to cellular.' }));
}

function parseWirelessArgs(args) {
  let host;
  let port = 49152;
  let name = hostname() || 'poki-mcp';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--port' && index + 1 < args.length) port = Number(args[++index]);
    else if (arg === '--name' && index + 1 < args.length) name = args[++index];
    else if (!arg.startsWith('--') && host === undefined) host = arg;
    else throw new Error(usage);
  }
  if ((host !== undefined && !isIP(host)) || !validPort(port) || !name) throw new Error(usage);
  return { host, port, name };
}

function runPairHost(hostState, output, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(pokiNative, ['--pair-host', hostState, output, name, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let paired;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); }
      catch { return; }
      if (event.event === 'advertising') {
        console.log(`Advertising ${name} on the local network. On the iPhone, open Settings › Privacy & Security › Developer Mode and tap “Pair with ${name}”.`);
      } else if (event.event === 'pin') {
        console.log(`Enter this code on the iPhone: ${event.pin}`);
      } else if (event.event === 'paired') {
        paired = event;
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0 && paired) resolve(paired);
      else if (signal) reject(new Error(`Wireless pairing stopped with ${signal}.`));
      else reject(new Error(stderr.trim() || `Wireless pairing did not complete (exit ${code}).`));
    });
  });
}

async function prepareWireless(args) {
  const options = parseWirelessArgs(args);
  const remoteRoot = join(stateDir, 'remote');
  await mkdir(remoteRoot, { recursive: true, mode: 0o700 });
  await chmod(remoteRoot, 0o700);
  const pending = await mkdtemp(join(remoteRoot, 'wireless-'));
  try {
    await chmod(pending, 0o700);
    const pendingPairing = join(pending, 'pairing.plist');
    console.log('Keep this computer and the iPhone on the same local network. Wireless first pairing requires iOS 27 or newer.');
    const result = await runPairHost(join(remoteRoot, 'host'), pendingPairing, options.name);
    const id = result.device?.udid;
    if (!validId(id ?? '')) throw new Error('Wireless pairing finished without a valid device identifier.');
    const host = options.host ?? result.peer;
    if (!isIP(host ?? '')) throw new Error('Wireless pairing finished without a usable device address. Pass the iPhone LAN or Tailscale address as HOST.');
    const directory = join(remoteRoot, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const pairing = join(directory, 'pairing.plist');
    await rename(pendingPairing, pairing);
    await chmod(pairing, 0o600);
    await registerRemote(id, result.device?.name || id, host, options.port, pairing);
    console.log(JSON.stringify({ paired: true, wireless: true, device: id, host, next: 'Start Poki and call list_devices. The first connection verifies the new pairing over the network.' }));
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--wireless') await prepareWireless(args.slice(1));
else await prepareUsb(args);

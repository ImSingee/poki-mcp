#!/usr/bin/env node
import { mkdir, chmod, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { root, stateDir, idevice } from '../src/config.mjs';
import { registerRemote, validId, validPort, validHost, isBonjour } from '../src/pairing/registry.mjs';
import { startPairHost, stagePairing, completeWirelessPairing, discardStaging, defaultHostName, defaultRemotePort, advertisingInstruction, pinInstruction } from '../src/pairing/wireless.mjs';

const exec = promisify(execFile);
const usage = 'Usage: node bin/prepare-remote.mjs DEVICE_ID IP_OR_BONJOUR_HOST [PORT]\n   or: node bin/prepare-remote.mjs --wireless [IP_OR_BONJOUR_HOST] [--port PORT] [--name HOST_NAME]\nUse an IP address or a .local host.';

function nextStep(host, wireless) {
  const first = wireless ? ' The first connection verifies the new pairing over the network.' : '';
  return isBonjour(host)
    ? `Start Poki and call list_devices.${first} Keep the iPhone unlocked and both devices on the same LAN; the Bonjour name must remain reachable.`
    : `Start Poki and call list_devices while Wi-Fi is connected.${first} For Tailscale, keep both devices connected and keep the daemon running when switching to cellular.`;
}

async function prepareUsb([id, host, portText = '49152']) {
  const port = Number(portText);
  if (!id || !validId(id) || !validHost(host) || !validPort(port)) throw new Error(usage + ' Connect the trusted iPhone by USB and Wi-Fi first.');
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
    // The upstream CLI can return exit 0 on failure. Require its actual output artifact.
    await stat(pairing);
  }
  await chmod(pairing, 0o600);
  const verification = await exec(idevice, ['--udid', id, 'remotepairing_lockdown', 'verify', pairing, 'poki-mcp'], { timeout: 30000 });
  if (!verification.stdout.includes('the device recognizes this pairing record')) throw new Error('The iPhone did not verify the saved pairing record. Keep it trusted, unlocked, and connected over USB. Rename remote/DEVICE_ID/pairing.plist in this installation\'s private state directory, then run prepare-remote again. See docs/remote-iphone.md.');
  const name = JSON.parse((await exec(idevice, ['--udid', id, 'lockdown', 'get', 'DeviceName'], { timeout: 15000 })).stdout);
  await registerRemote(id, name, host, port, pairing);
  console.log(JSON.stringify({ paired: true, device: id, next: nextStep(host, false) }));
}

function parseWirelessArgs(args) {
  let host;
  let port = defaultRemotePort;
  let name = defaultHostName();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--port' && index + 1 < args.length) port = Number(args[++index]);
    else if (arg === '--name' && index + 1 < args.length) name = args[++index];
    else if (!arg.startsWith('--') && host === undefined) host = arg;
    else throw new Error(usage);
  }
  if ((host !== undefined && !validHost(host)) || !validPort(port) || !name) throw new Error(usage);
  return { host, port, name };
}

async function prepareWireless(args) {
  const options = parseWirelessArgs(args);
  const staging = await stagePairing();
  try {
    console.log('Keep this computer and the iPhone on the same local network. Wireless first pairing requires iOS 27 or newer.');
    const { events, done } = startPairHost({ name: options.name, hostState: staging.hostState, output: staging.pairing });
    events.on('advertising', () => console.log(`Advertising ${options.name} on the local network. ${advertisingInstruction(options.name)}`));
    events.on('pin', event => console.log(pinInstruction(event.pin)));
    const result = await done;
    const device = await completeWirelessPairing(result, { pairing: staging.pairing, host: options.host, port: options.port });
    console.log(JSON.stringify({ paired: true, wireless: true, device: device.id, host: device.host, next: nextStep(device.host, true) }));
  } finally {
    await discardStaging(staging.directory);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--wireless') await prepareWireless(args.slice(1));
else await prepareUsb(args);

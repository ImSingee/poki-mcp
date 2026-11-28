// Developer disk image (DDI) for a phone reached over RemotePairing. Input and screen streaming need
// displayservice, which the DDI provides. The native helper installs it through cryptexd over the
// tunnel it already holds (native/bridge/src/ddi.rs); this module finds the image to install and turns
// each failure into advice.
//
// Image sources, first match wins:
// 1. POKI_DDI_DIR: a directory with BuildManifest.plist and its payloads.
// 2. Xcode's /Library/Developer/DeveloperDiskImages/iOS_DDI/Restore (macOS).
// 3. A copy pymobiledevice3 already downloaded (~/.pymobiledevice3 or $XDG_DATA_HOME/pymobiledevice3).
// 4. <state>/ddi/<build>, downloaded once from the image mirror pymobiledevice3 uses, pinned to one
//    commit and checked against the SHA-256 of every file. The image is the same for every phone;
//    Apple personalizes it for this phone during installation.
import { createHash } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stateDir as defaultStateDir } from '../config.mjs';
import { signingRefused } from '../ddi-failure.mjs';

export const pinnedImage = {
  build: '27B52',
  baseUrl: 'https://raw.githubusercontent.com/doronz88/DeveloperDiskImage/a9ae4c1c47105d195d860badf04c0e2a835b99d8/PersonalizedImages/Xcode_iOS_DDI_Cryptex',
  // BuildManifest.plist last: a directory that has it holds every payload.
  files: [
    { name: 'Image.dmg', sha256: '500d4139f7963650e6c796d950267ed38909e7d183ad26bba073257529bfe173' },
    { name: 'Image.dmg.trustcache', sha256: '2719aa3f1c99245432512116fb8a56d55ec224c706e545772d4c17c1233ac475' },
    { name: 'Image.dmg.cryptex_info', sha256: '0180ee20ce5daa7978fe38f24c742361726789ea6af82c3c1d2afc480734a531' },
    { name: 'Image.dmg.root_hash', sha256: '5f3281961396be5fe008e11641ffc25c7db24c11d3789ff0c4ff0fa6d47b94ca' },
    { name: 'BuildManifest.plist', sha256: '537391eb2f37e604fc693f422c1568af97220067853e663391ba3e8258569d6e' },
  ],
};

const xcodeImage = '/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore';
const hasManifest = async directory => access(join(directory, 'BuildManifest.plist')).then(() => true, () => false);

export function candidateDirectories(env = process.env, stateDir = defaultStateDir, image = pinnedImage) {
  const home = env.HOME ?? homedir();
  const xdg = env.XDG_DATA_HOME || join(home, '.local/share');
  return [
    ...(env.POKI_DDI_DIR ? [{ source: 'POKI_DDI_DIR', directory: env.POKI_DDI_DIR }] : []),
    ...(process.platform === 'darwin' ? [{ source: 'xcode', directory: xcodeImage }] : []),
    { source: 'pymobiledevice3', directory: join(home, '.pymobiledevice3/Xcode_iOS_DDI_Cryptex') },
    { source: 'pymobiledevice3', directory: join(xdg, 'pymobiledevice3/Xcode_iOS_DDI_Cryptex') },
    { source: 'download', directory: join(stateDir, 'ddi', image.build) },
  ];
}

// Downloads every file to a temporary name, checks its hash, then moves it into place.
export async function downloadImage(directory, { image = pinnedImage, fetchImpl = fetch, signal } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of image.files) {
    const target = join(directory, file.name);
    const existing = await readFile(target).catch(() => undefined);
    if (existing && createHash('sha256').update(existing).digest('hex') === file.sha256) continue;
    const response = await fetchImpl(`${image.baseUrl}/${file.name}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60000)]) : AbortSignal.timeout(10 * 60000) });
    if (!response.ok) throw new Error(`Downloading ${file.name} of the developer disk image failed (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256) throw new Error(`The downloaded ${file.name} does not match the expected checksum (got ${digest}).`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
  }
  return directory;
}

// The directory to install from, downloading the pinned image when no local copy exists.
export async function resolveImage({ env = process.env, stateDir = defaultStateDir, image = pinnedImage, fetchImpl, signal } = {}) {
  const candidates = candidateDirectories(env, stateDir, image);
  for (const candidate of candidates) if (await hasManifest(candidate.directory)) return candidate;
  const download = candidates.at(-1);
  try {
    await downloadImage(download.directory, { image, fetchImpl, signal });
  } catch (error) {
    await rm(join(download.directory, 'BuildManifest.plist'), { force: true });
    throw Object.assign(new Error(error.message), { stage: 'image' });
  }
  return download;
}

const usbAction = device => `Connect the iPhone to this computer with a USB cable once, unlock it, trust this computer, and run: node bin/prepare-device.mjs ${device}. Afterwards it works over Wi-Fi again.`;

// Advice for a failed installation, by the stage the helper named (ddi.rs) or the step that failed here.
export function ddiFailure(stage, error, device) {
  const message = String(error?.message ?? error ?? '');
  if (stage === 'signing' || signingRefused(message)) return {
    reason: 'ddi_signing_failed',
    error: message,
    action: 'Apple\'s signing server did not personalize the developer disk image for this iPhone. Check that this computer can reach gs.apple.com, then retry pairing (or call pairing_status again later). A USB cable does not help here: USB installation needs the same signature. If Apple declines the image itself, set POKI_DDI_DIR to a newer Apple-signed DDI.',
  };
  if (stage === 'image') return {
    reason: 'ddi_image_unavailable',
    error: message,
    action: 'No developer disk image could be found or downloaded. Check this computer\'s internet access, or set POKI_DDI_DIR to a directory holding BuildManifest.plist and the image files (for example Xcode\'s iOS_DDI/Restore), then pair again.',
  };
  return {
    reason: stage === 'unavailable' ? 'ddi_tunnel_unsupported' : 'ddi_tunnel_install_failed',
    error: message,
    action: usbAction(device),
  };
}

// Makes sure the phone offers displayservice. Resolves { ready: true, already?, ddi } or throws an
// Error carrying { failure } from ddiFailure. `request` is nativeRequest bound to the device.
export async function ensureDeveloperImage(device, request, { resolve = resolveImage, signal, onPhase = () => {} } = {}) {
  let status = await request({ op: 'ddi_status' });
  // The tunnel's service list is from when it opened: an image mounted since (over USB with
  // prepare-device, say) shows only on a new handshake, so reconnect once before installing.
  if (!status.display_service) {
    const reconnected = await request({ op: 'reconnect' }).catch(() => undefined);
    if (reconnected?.connected) status = await request({ op: 'ddi_status' });
  }
  if (status.display_service) return { ready: true, already: true, ddi: status.ddi ?? null };
  onPhase('image');
  let image;
  try { image = await resolve({ signal }); }
  catch (error) { throw Object.assign(new Error(error.message), { failure: ddiFailure('image', error, device) }); }
  onPhase('install');
  let reply = await request({ op: 'install_ddi', restore_dir: image.directory }, { timeoutMs: 16 * 60000 });
  // An image is listed as installed, yet the phone offers no displayservice: install it again once.
  if (reply.installed && reply.already && !reply.display_service) reply = await request({ op: 'install_ddi', restore_dir: image.directory, force: true }, { timeoutMs: 16 * 60000 });
  if (!reply.installed) throw Object.assign(new Error(reply.error ?? 'Installing the developer disk image failed.'), { failure: ddiFailure(reply.stage, reply.error, device) });
  if (!reply.display_service) throw Object.assign(new Error('The developer disk image is installed, but the iPhone still offers no displayservice.'), { failure: ddiFailure('install', 'The developer disk image is installed, but the iPhone still offers no displayservice. It may be older than this iOS version needs.', device) });
  return { ready: true, already: Boolean(reply.already), ddi: reply.ddi ?? null, source: image.source };
}

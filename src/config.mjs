import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultStateDir = platform() === 'linux'
  ? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'PokiMCP')
  : join(homedir(), 'Library/Application Support/PokiMCP');
export const stateDir = process.env.POKI_MCP_STATE_DIR ?? defaultStateDir;
export const endpointFile = join(stateDir, 'mcp.json');
// usbmuxd answered with an empty list. On macOS Finder uses the same device stack, so it is the first check.
export const noUsbDevice = platform() === 'linux'
  ? 'usbmuxd answered, but no iPhone is attached over USB. Connect it directly with a data cable, unlock it, and accept Trust This Computer. If it still does not appear, check that the usbmuxd service is running and that your user may access it. A phone reached only over the network needs an entry in remote-devices.json; see docs/remote-iphone.md.'
  : 'usbmuxd answered, but no iPhone is attached over USB. Check whether the iPhone appears in the Finder sidebar. If Finder does not show it either, macOS has not attached it: connect it directly with a data cable, unlock it, and accept Trust This Computer. Poki cannot use an iPhone that devicectl reaches only over the network.';
export const idevice = process.env.IDEVICE_TOOLS
  ?? join(root, '.deps/idevice/target/release/idevice-tools');
export const pokiNative = process.env.POKI_NATIVE ?? join(root, 'build/poki-native');

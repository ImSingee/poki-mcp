import { platform } from 'node:os';
import { execute } from './work.mjs';

// Who approves the tools that change apps, open links, or read and write the clipboard
// (approvedTools in device.mjs):
//   ask   Poki shows a dialog on this machine (osascript on macOS, zenity on Linux) and waits.
//   host  Poki shows nothing. The MCP client decides, from the annotations on those tools and its own
//         tool permissions. The default on a Linux host without a display, where no dialog can appear.
//   allow Nobody is asked; the operator accepted that.
// An explicit POKI_MCP_APPROVAL_MODE always wins over the display check.
export function approvalMode(env = process.env, host = platform()) {
  const configured = env.POKI_MCP_APPROVAL_MODE?.trim();
  if (configured) {
    if (configured === 'ask-human') return 'ask';
    if (!['ask', 'host', 'allow'].includes(configured)) throw new Error(`POKI_MCP_APPROVAL_MODE=${configured} is not one of ask, host or allow.`);
    return configured;
  }
  return host === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY ? 'host' : 'ask';
}

// A real macOS dialog is the acknowledgment. A successful notification alone is not.
export async function askHuman(message, seconds = 120) {
    if (approvalMode() === 'host') throw new Error('This Poki MCP service runs in host approval mode, so it shows no dialog on its machine. Ask the user in the conversation instead, then inspect the device.');
    if (platform() === 'linux') return askHumanLinux(message, seconds);
    const script = `on run argv
      set promptText to item 1 of argv
      set waitSeconds to (item 2 of argv) as integer
      try
        set response to display dialog promptText with title "Poki MCP" buttons {"取消", "确认"} default button "确认" cancel button "取消" giving up after waitSeconds
        if gave up of response then return "timeout"
        if button returned of response is "确认" then return "done"
        return "cancelled"
      on error number -128
        return "cancelled"
      end try
    end run`;
    const { stdout } = await execute('osascript', ['-e', script, '--', message, String(Math.ceil(seconds))], { timeout: (seconds + 10) * 1000 });
    const status = stdout.trim();
    return { status, completed: status === 'done', message: status === 'done' ? 'The user confirmed the dialog. Inspect the device before continuing.' : 'The user did not confirm completion.' };
}

// The Linux counterpart of the macOS dialog: zenity when a desktop is
// available. Without one there is no human channel, so fail loudly instead
// of pretending the prompt happened.
async function askHumanLinux(message, seconds) {
    try {
        await execute('zenity', ['--question', '--title=Poki MCP', `--text=${message}`, '--ok-label=确认', '--cancel-label=取消', `--timeout=${Math.ceil(seconds)}`], { timeout: (seconds + 10) * 1000 });
        return { status: 'done', completed: true, message: 'The user confirmed the dialog. Inspect the device before continuing.' };
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error('No approval dialog is available on this Linux host because zenity is not installed. Install zenity, or set POKI_MCP_APPROVAL_MODE=host to let the MCP client approve them, or allow only if unapproved sensitive actions are acceptable here.');
        const status = error.code === 5 ? 'timeout' : 'cancelled';
        return { status, completed: false, message: 'The user did not confirm completion.' };
    }
}

# Poki MCP troubleshooting

Use this reference when a Poki MCP call fails, stops responding, or returns an error you need to explain to the user. The host running `poki-mcp` can be Linux or macOS; the steps name both where they differ.

## 1. Read state first

Run read-only checks before retrying failed actions or modifying local state.

### How to call tools outside default `tools/list`

`get_device_info`, `observe_device`, `list_crashes`, `get_crash`, `reconnect_device`, and `disconnect_device` are omitted from default `tools/list`:

- If your MCP client exposes only listed tools, ask the user to set `POKI_MCP_TOOLS=all` in the client's MCP server environment and reconnect.
- From a terminal on the host, `cd` to the Poki checkout directory first and run `node bin/call.mjs <tool_name> '<json_args>'` (pass the same `POKI_MCP_STATE_DIR` when non-default). Each `bin/call.mjs` run opens a separate session and starts the daemon if none is running. Every device tool needs `"device"` in `<json_args>`: an id from `list_devices`.
- Clients that permit direct `tools/call` requests for unlisted tools can call them without `POKI_MCP_TOOLS=all`.

### Diagnostic tools

| Tool | In default `tools/list` | Arguments | Key return fields |
| --- | --- | --- | --- |
| `poki_mcp_status` | Yes | `{}` | `implementation` (version string), `commit`, `native_build`, `total_tools`, `devices` count, `approval_mode` (`ask-human`, `host`, or `operator-preapproved`), `approval_covers`, and optional `update` (`version`, `summary`, `url`, `command`). Runs even when the daemon reports outdated code. |
| `list_devices` | Yes | `{ include_all_simulators?: boolean }` | `devices[]` with `id`, `connection` (`"USB"`, `"RemotePairing"`, or `"Simulator"`), `kind`, `name`, `model`, `osVersion`, `readiness`, `occupied`, or `blocked` and `action` when a phone is locked, untrusted, or unreachable. Includes `default` and `default_note` when exactly one device is listed, and `notice` when `usbmuxd` sees no USB iPhone. |
| `get_device_info` | No | `{ device: string, include_settings?: boolean }` | `id`, `name`, `kind`, `connection`, `model` (`ProductType` on USB, such as `iPhone17,1`), `osVersion` (`ProductVersion`), `engine`, `mirror_status`, `screen` (`width`, `height`, `scale`, `units`), and optional `settings` (`appearance`, `text_size`, accessibility flags, unavailable over `RemotePairing`). |
| `observe_device` | No | `{ device: string, source?: "auto" \| "accessibility" \| "ax" \| "ocr", max_elements?: number, include_offscreen?: boolean, include_image?: boolean }` | Current PNG screenshot (unless `include_image: false`), `foreground` (`pid`, `bundle_id`, `name`), `elements[]` with `ref` and `frame`, `source`, `fallback_reason`, and `prompt` (`warning.kind: "passcode"` or alert buttons when a system prompt blocks the screen). |
| `list_crashes` | No | `{ device: string, process?: string, kind?: "crash" \| "spin" \| "log" \| "diagnostic" \| "all", limit?: number }` | `source` and `reports[]` (`path`, `name`, `modified`, `kind`). On Linux the device list comes from `pymobiledevice3 crash ls` and carries no modification times. Unavailable over `RemotePairing`. |
| `get_crash` | No | `{ device: string, path?: string, process?: string, full?: boolean }` | Copies the `.ips` or `.crash` file into `POKI_MCP_STATE_DIR/crashes/` and returns `process`, `bundle_id`, `exception`, `termination`, `faulting_thread`, and top `frames[]` (or raw text with `full: true`). Unavailable over `RemotePairing`. |
| `reconnect_device` | No | `{ device: string }` | Attempts a fresh `RemotePairing` tunnel and re-resolves `.local` Bonjour names while keeping an existing working tunnel if replacement fails. Never replays prior input. |
| `disconnect_device` | No | `{ device: string }` | Closes the detached `poki-native --remote-server` helper and its `RemotePairing` connection. |

Done when you have the server version and commit, iPhone model and iOS version, connection type, and exact error text.

## 2. Classify and fix what you can

| Failure class | Primary signals | Section |
| --- | --- | --- |
| Developer disk image missing or refused | `display_service_missing`, `STATUS=94`, `"TSS server responded with non-success status"`, `/System/Developer [17: File exists]` | 2.1 |
| Outdated daemon, daemon start or token mismatch | `"The service is running old code."`, `"runs older code"`, `"Poki MCP could not start"`, `"Poki MCP did not become ready"`, `"rejected the token in "` | 2.2 |
| Device not named or not found | an input validation error on `device`, `No connected device is named`, `Several devices match` | 2.3 |
| Disconnected or unreachable | `list_devices` `blocked` or `notice`, `"is not connected. Use list_devices"`, `Remote pairing is unreachable`, `The remote pairing control connection closed`, `The iPhone refused a new tunnel` | 2.4 |
| Locked screen or blocked input | `prompt.warning.kind: "passcode"`, `screen: locked`, `screen: dark`, `"paste_permission"`, a declined approval (`executed: false`), or `fill` field-confirmation refusal | 2.5 |

### 2.1 Developer disk image missing or refused

**Observed error strings**

- **Input tools (`src/device.mjs`, `native/bridge/src/stream.rs`).** Input returns `outcome: "not_sent"`, `reason: "display_service_missing"`, and `error: "Cannot establish input media session: no display service: ServiceNotFound"`. Screenshots, `list_elements`, and `observe_device` work without `com.apple.coredevice.displayservice`, so working screen reads do not prove touch or text input is ready.
- **`bin/prepare-device.mjs` and `src/ddi-failure.mjs`.** Output contains `STATUS=94`, `"TSS server responded with non-success status"`, `"This device isn't eligible for the requested build"`, or `/System/Developer [17: File exists]`.

**Rule out network interception first.** Personalizing the image goes through Apple's signing server (`gs.apple.com`). A proxy, VPN, HTTPS inspection filter, or workplace or school gateway that intercepts it produces the same `"TSS server responded"` error as a real refusal. Treat the failure as a true Apple version refusal **only** when the output includes `STATUS=94` together with an iOS-versus-image mismatch such as `"This device isn't eligible for the requested build"`. Otherwise ask the user to retry on an unfiltered network and with VPNs and proxies off.

**Recover**

- **Mount from the host (with user confirmation).** With the unlocked, trusted iPhone on USB, `cd` to the Poki checkout and run `node bin/prepare-device.mjs <UDID>`. On Linux it mounts the image through `pymobiledevice3` (`POKI_PYMOBILEDEVICE3` names the binary; see `LINUX.md`). On macOS it uses Xcode's support files.
- **Confirmed `STATUS=94` version mismatch.** On macOS, the Mac's Xcode is older than the phone's iOS; ask the user to update Xcode and open it once. On Linux, ask the user to update `pymobiledevice3` so it fetches a personalized image for the phone's iOS.
- **Mount conflict (`/System/Developer [17: File exists]`).** Ask the user to close any other tool holding the device (Xcode on macOS), restart the iPhone, reconnect it over USB unlocked, and confirm before rerunning `node bin/prepare-device.mjs <UDID>`.

### 2.2 Outdated daemon, daemon start or token mismatch

The daemon is started by the first call of an MCP client (an automatic daemon) unless the user runs it with `npm start` or a user service. A daemon whose files changed since it started, or that runs an older release, is replaced by the next stdio process that connects, once it is idle.

**Observed error strings (`src/daemon-launch.mjs`, `src/stdio.mjs`, `src/build-info.mjs`)**

- `"The Poki MCP service running as pid <pid> was started with npm start and runs older code (...)"`. Ask the user to stop that service and start it again from the Poki checkout (`npm start` with the same `POKI_MCP_STATE_DIR`, or the user service described in `LINUX.md`), or get their confirmation before restarting it for them.
- `"The background Poki MCP (pid <pid>) runs older code (...) and is still busy: ..."`. The automatic daemon still has leases, calls in progress, or a recording or simulated location. Finish or cancel that work (`release_device`, `cancel_device`, `stop_recording`, `clear_location`) and retry, or get the user's confirmation before stopping it with the `kill` command in the message.
- `"The service is running old code. Stop the running service and restart it with npm start."`. A `npm start` service or user service whose files changed after it started. Handle it as above. (An automatic daemon in that state is replaced by the stdio process, which sends the call again; its clients see the busy message above at most.)
- `"... was started with npm start and runs older code (before 0.2.0 ...)"`. A service from before 0.2.0 is still running. With the user's confirmation, stop it; the next call starts a current one.
- `"This MCP session was closed. Start a new one."`. The session ended while the call was on its way. Send the call again.
- `"Poki MCP could not start (...)"` or `"Poki MCP did not become ready within ..."`. The message ends with the last lines of `POKI_MCP_STATE_DIR/daemon.log`. Fix what they name, such as an invalid `POKI_MCP_APPROVAL_MODE` or a failed build, and retry.
- Errors containing `"rejected the token in "`. Another process owns the endpoint. With the user's confirmation, stop the pid named in the message; the next call starts the service again.

Verify with `poki_mcp_status`.

On USB or Simulator, `list_crashes` and `get_crash` show whether the target app quit unexpectedly.

### 2.3 Device not named or not found

Every device tool takes `device`; there is no selected device.

**Observed error strings (`src/device.mjs`)**

- An input validation error at path `device`, such as `Invalid input: expected string, received undefined`: the call named no device.
- `No connected device is named "<name>". Use list_devices and pass one of its ids as device.`
- `Several devices match "<name>": <name> (<id>), .... Pass the id as device.`
- `"A step names no device: every step runs on the batch's device. ..."` from `batch_commands`, and `"This script may only use the devices it names in devices (...)"` from `run_code`.

**Fix.** Call `list_devices` and pass the intended device's `id` as `device` on every call. Put the device on `batch_commands` itself, not on its steps. List every device a `run_code` script uses in `devices`.

### 2.4 Disconnected or unreachable

**Observed error strings (`src/device.mjs`, `src/config.mjs`, `native/bridge/src/remote.rs`)**

- `Device <id> is not connected. Use list_devices to see the devices available now.`
- A `list_devices` `notice` that `usbmuxd` answered but no iPhone is attached over USB.
- Errors starting with `"Remote pairing is unreachable ("` or `"The remote pairing control connection closed: "`, or `"The iPhone refused a new tunnel. Reconnect it to Wi-Fi, then reconnect the device."`

**What you fix yourself (and when to ask before changing service state)**

- **Reconnect wireless tunnel.** With `RemotePairing`, call `reconnect_device`. It resolves `.local` Bonjour names again while keeping an existing working tunnel if replacement fails. If a detached `poki-native --remote-server` helper is wedged across daemon restarts (`Remote operation timed out`), call `disconnect_device` before reconnecting.
- **Return a `remote-devices.json` phone to USB (with user confirmation).** When an iPhone is listed in `POKI_MCP_STATE_DIR/remote-devices.json`, `poki-mcp` keeps using `RemotePairing` and ignores a newly attached USB cable. Call `disconnect_device`, then ask the user for confirmation (or tell them how to do it themselves) before removing only that device's entry from `remote-devices.json` (keep `remote/<UDID>/pairing.plist` private and intact) and restarting the service.

**When user action is required**

- **Missing USB attachment.** Ask the user to connect the iPhone directly with a USB data cable, unlock it, and tap **Trust This Computer**. On Linux, check that `usbmuxd` is running (`systemctl status usbmuxd`) and call `list_devices` again. On macOS, check whether Finder lists the iPhone.
- **`.local` names do not resolve on Linux.** `RemotePairing` hosts given as `.local` names need avahi with nss-mdns on the host. Ask the user to install them or to configure the phone's numeric address instead.
- **Local Network permission (`No route to host` on macOS 15+).** Ask the user to grant **System Settings > Privacy & Security > Local Network** to the client or terminal that spawned `poki-mcp`.

### 2.5 Locked screen or blocked input

**Observed error strings**

- **Locked or dark display.** `observe_device` or `take_screenshot` returns `prompt.warning.kind: "passcode"`. `look` or `do` returns `screen: locked` or `screen: dark`.
- **Paste or field errors.** Tools return `reason: "paste_permission"`, `the clipboard could not be read`, `the field's menu showed no Paste item`, or a `fill` field-confirmation error.
- **Operator approval.** In `ask-human` mode a gated tool returns `executed: false` with `status: "cancelled"` or `"timeout"` when the dialog was declined or not answered. In `host` mode `request_human_action` returns `"This Poki MCP service runs in host approval mode, so it shows no dialog on its machine. ..."`.

**What you fix yourself**

- **Paste blocked.** Call `handle_alert` to accept `Allow Paste` and inspect `screen` to confirm whether text landed, or type with `type_text` (or `do {"type": "<text>"}`) instead of pasting.
- **Field confirmation refused.** Nothing was typed or submitted. Read `screen` from the error response, adjust your selector or coordinates, and run only `remaining_steps`.

**When user action is required**

- **Locked phone.** Ask the user to unlock the iPhone manually (unless Poki Agent's host `unlock_device` was already configured by the user for a verified `iPhone17,1` portrait 6-digit passcode setup). Never ask for or enter the passcode yourself.
- **Declined approval.** Nothing ran. Ask the user whether to try again before resending the gated step. In `host` mode, ask the user in the conversation instead of calling `request_human_action`.

Done when the task succeeds on a fresh screen read, or when you have confirmed the failure requires user action.

## 3. Collecting logs and stripping personal data

Collect only the minimum technical evidence needed to explain the failure, and strip every secret and personal identifier before showing it to the user or saving a report.

### Safe diagnostic sources

Use `poki_mcp_status`, `list_devices`, `get_device_info`, `get_crash` frame summaries, and relevant error lines from the daemon log or `POKI_MCP_CALL_LOG`.

### Secrets and personal identifiers you must never print or attach

Never print environment variables, and never paste or upload raw contents from:

- `POKI_MCP_STATE_DIR/mcp.json` (contains the local daemon bearer `token`) or a configured `POKI_MCP_TOKEN`
- `POKI_MCP_STATE_DIR/remote/<UDID>/pairing.plist`
- `~/.pi/agent/auth.json` or any model API key, Apple Account email, password, two-factor verification code, Team ID, or iPhone passcode
- Device UDIDs, serial numbers, phone and computer names, usernames in local file paths (such as `/home/<username>/...` or `/Users/<username>/...`), Wi-Fi network names (SSIDs), IP addresses, phone numbers, and private screen or chat contents

When the user wants a written report, keep observations separate from inferences, quote exact error strings, include the version and commit from `poki_mcp_status`, and show the full draft to the user before sharing it anywhere.

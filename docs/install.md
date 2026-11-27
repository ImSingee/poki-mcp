# Install

This guide installs Poki MCP from source on a Mac, which needs full Xcode.

For remote access, see [Remote iPhone over LAN or Tailscale](remote-iphone.md). Both paths require initial trusted USB setup; cross-network access also requires Tailscale.

> Using a Linux host instead of a Mac? This fork supports physical iPhones from Linux — follow [LINUX.md](../LINUX.md) rather than the requirements and steps below.

## Requirements

- **macOS 15 or later** with a full **Xcode** installation from the App Store, opened at least once to finish its first-launch setup (Command Line Tools alone are not enough). Xcode also provides Git and Python 3.
- **Git**
- **Node.js 24+** and **npm** (required for both the daemon and the stdio client)
- **Rust / Cargo** with Rust 2024 edition support, from [rustup.rs](https://rustup.rs). Setup always uses it to build the iPhone bridge, even if you use only the Simulator.
- **Python 3**
- **`ffmpeg` and `ffprobe`**, from `brew install ffmpeg` (required for recording; checked during `./bin/setup`)
- **iOS Simulator runtime** installed in Xcode (for simulator targets)
- **Apple developer support files** already installed on the Mac (for physical-device developer services)

`./bin/setup` checks for these requirements and stops with an installation hint if any are missing. You do not need to set any environment variables. All settings in [Configuration and sessions](configuration.md) are optional.

> **Reference environment**: Prepared on an Apple silicon Mac with macOS 27.3, Xcode 27.0 (`27A5209h`), Node 26.10.0, npm 11.19.1, Rust/Cargo 1.99.0, Python 3.13.0, and `ffmpeg`/`ffprobe` 9.0.2. These versions record the build environment rather than claiming that every tool and parameter works across all platform versions.

If you received the optional `poki-v0.1.1-macos-arm64.tar.gz` build, follow its bundled README; the source installation below does not depend on that archive.

## 1. Build from Source

```sh
git clone https://github.com/ImSingee/poki-mcp.git
cd poki-mcp
./bin/setup
```

`./bin/setup` takes a few minutes on a first build. What it does:

- Fetches `jkcoxson/idevice` at commit `89702099f4d7552f704f93b4526756abda319ceb` into `.deps/idevice` and verifies its revision and clean working tree (stopping without modifying `.deps/idevice` if mismatched or dirty).
- Installs locked npm dependencies.
- Builds the Rust physical-device bridge, optional unlock helper, Swift OCR helper, and Objective-C simulator bridge. (If you modify native code later, rebuild with `npm run build:native`.)

Setup does **not** install Xcode, developer disk images, device profiles, or signing identities.

You do not need to start the daemon yourself. The stdio server that every client registers (`src/stdio.mjs`, next step) answers `tools/list` itself. On its first `tools/call`, it finds the one daemon for its state directory or starts one:

- It takes `daemon.lock` in the state directory, starts `node src/daemon.mjs --auto` in the background, and waits until the daemon answers. A lock left behind by a process that is gone is broken. The daemon's output goes to `daemon.log` (`0600`) in the state directory.
- The daemon listens on a free port on `127.0.0.1`, so it is not exposed to external networks, and it is not registered as a login item. Its endpoint and bearer token are written to `mcp.json` (`0600`) in the state directory (`~/Library/Application Support/PokiMCP` by default) and removed on normal shutdown. The token is internal; you never configure it.
- Several stdio processes share that daemon: several clients, or one client that starts and stops stdio processes as it needs them, such as LobeHub's `lh connect`. Sessions, leases, recordings and device locks live in the daemon, so they outlast any one stdio process.
- The daemon exits after it has been idle for `POKI_DAEMON_IDLE_EXIT_MS` (default 10 minutes): no session, no lease, no call in progress, and no background recording or simulated location.
- If the daemon is gone, the next call starts a new one. A call that never reached the daemon (a refused connection, or a token the daemon rejects) is sent once more. A connection lost during a call is reported and not sent again, because the device may already have acted.
- After an update, the next stdio process that connects stops an idle automatic daemon that runs the old code and starts a new one. If the old daemon is still busy (leases, calls in progress, background work), the call fails with an error that names that work; retry when it ends, or stop the pid it names.
- The daemon runs with the environment of the client that started it. Set daemon settings, such as `POKI_MCP_APPROVAL_MODE` or `POKI_MCP_STATE_DIR`, in that client's MCP `env`.

### Run a long-lived service (optional)

`npm start` runs the daemon in the foreground until you stop it. Use it, or a user service as described in [LINUX.md](../LINUX.md#running-the-daemon-as-a-user-service), when the daemon should keep running, serve clients on other machines (`POKI_BIND_HOST` and `POKI_HOST_ALLOW`; see [Configuration](configuration.md)), or run with settings of its own. It listens on `127.0.0.1:47825` by default, never exits on idle, and is never restarted by a stdio process. Clients that find it in `mcp.json` use it instead of starting their own. Start it before its clients; if an automatic daemon already runs for that state directory, stop it first (its pid is in `mcp.json`). After an update, stop it and start it again yourself.

## 2. Connect an MCP Client

Replace `/absolute/path/to/poki` with the absolute path to your checkout, and ensure `node` (24+) is on the MCP client's `PATH`.

From the checkout, `"$PWD/src/stdio.mjs"` gives the same absolute path in a shell command.

**Claude Code:**

```sh
claude mcp add --scope user poki-mcp -- node /absolute/path/to/poki/src/stdio.mjs
```

**Codex:**

```sh
codex mcp add poki-mcp -- node /absolute/path/to/poki/src/stdio.mjs
```

**Codex (`config.toml`):**

```toml
[mcp_servers.poki-mcp]
command = "node"
args = ["/absolute/path/to/poki/src/stdio.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 900
```

**Clients using `mcpServers` JSON:**

```json
{
  "mcpServers": {
    "poki-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/poki/src/stdio.mjs"]
    }
  }
}
```

### Let your agent install it

Paste this prompt into your agent:

```text
Install https://github.com/ImSingee/poki-mcp following its root AGENTS.md, including the MCP skill, and stop whenever you need me to act.
```

[AGENTS.md](../AGENTS.md) covers prerequisites, source setup, registration in your own client, skill installation, iPhone pairing, Poki Agent, optional iMessage, and verification. It names each user-only stop, including Xcode setup, Trust This Computer, Developer Mode, UI Automation, and model login.

The default MCP `tools/list` exposes the tools for phone tasks. `poki_mcp_status.total_tools` reports the size of the complete catalog. Set `POKI_MCP_TOOLS=all` in the client's environment and reconnect to discover the complete catalog. Read and report the actual values. Neither count proves that the phone is ready.

## 3. Verify from the Terminal

Each stdio MCP client gets its own session, which keeps its leases and recordings until the client exits. `bin/call.mjs` works differently: each run starts its own stdio process, which starts the daemon if none is running, opens a session named `terminal`, makes a single call, and closes the session on exit. Even though runs use the same session name, they do not share state, so leases and recordings do not carry over to the next run. Every device tool needs `device`, an id from `list_devices` or an exact device name:

```sh
node bin/call.mjs poki_mcp_status
node bin/call.mjs list_devices
node bin/call.mjs start_simulator '{"model":"iPhone 18 Pro"}'
node bin/call.mjs take_screenshot '{"device":"YOUR_DEVICE_NAME_OR_ID"}'
node bin/call.mjs list_elements '{"device":"YOUR_DEVICE_NAME_OR_ID","source":"accessibility"}'
```

`list_devices` with `{"include_all_simulators":true}` lists the models that `start_simulator` can create. `start_simulator` names a new simulator `Poki MCP <model>` and returns its id; pass that id as `device` in later calls.

To use a physical iPhone, first pair it with your Mac over USB. After that, keep both devices on the same local network with the phone unlocked. See [Physical iPhone setup](physical-iphone.md).

## Fix common problems

| What you see | What to do |
| --- | --- |
| `Missing prerequisite: <tool>` from `./bin/setup` | Install what the message names, then run `./bin/setup` again. Setup keeps the existing `.deps/idevice` checkout, and Cargo continues its build. |
| `Poki MCP needs the full Xcode` from `./bin/setup` | Only the Command Line Tools are active. Install Xcode and run the commands in the message. |
| `STATUS=94`, `This device isn't eligible for the requested build`, or `ddi_refused` while installing a developer disk image | Check the Xcode and iOS versions in the error. The image may be too old for the phone, for example Xcode 26.6 with iOS 27.2. Update Xcode to support this iOS version (iOS 27 requires Xcode 27). Open Xcode once and wait for its components to finish installing. Rerun the same `prepare-device` or `install-iphone` command. Poki does not need to be reinstalled. If you passed `--image`, replace it with the updated Xcode image first. An unavailable or unknown version means detection failed, not that compatibility was confirmed. |
| `Poki MCP could not start` or `Poki MCP did not become ready` | The automatic daemon failed to start. The message ends with the last lines of `daemon.log` in the state directory. Fix what they name and retry the call. If you set `POKI_MCP_STATE_DIR`, set the same value for every client. |
| `... runs older code ... and is still busy` | An automatic daemon from before an update still has leases, calls or background work. Retry when that work ends, or stop it with the `kill` command in the message. |
| `... was started with npm start and runs older code` | Stop that service and start it again with `npm start`, or stop it and let the client start its own daemon. |
| `The service is running old code` | The daemon's files changed while a client stayed connected to it. Restart a `npm start` service. For an automatic daemon, reconnect the client, or stop the daemon (its pid is in `mcp.json`); the next call starts a new one. |
| `usbmuxd answered, but no iPhone is attached over USB` | macOS has not attached the iPhone. Check the Finder sidebar. If Finder does not show it either, connect it directly with a data cable, unlock it, and accept **Trust This Computer**. Poki cannot use an iPhone that `devicectl` reaches only over the network. |
| An input validation error on `device`, such as `expected string, received undefined` | Every device tool takes `device` since 0.2.0. Call `list_devices` once and pass its id on every call. |
| `Several devices match "<name>"` | Pass the device's id from `list_devices` as `device`. |
| `No connected device is named "<name>"` | Call `list_devices` and pass one of its ids as `device`. |
| `npm start` reports that the default port is in use | Run `npm start -- --port <port>`. Clients read the port from `mcp.json`. |
| A second daemon on one Mac | Give each daemon, and the clients that use it, its own `POKI_MCP_STATE_DIR`. Each writes `mcp.json` in its folder, and a normal shutdown removes it. |
| Sensitive tools run without any confirmation | The daemon runs in `host` approval mode, and the client runs tools without asking. Set those tools to require approval in the client, or see [Approval & Clipboard Behavior](tools.md#approval--clipboard-behavior). |
| `tap_text` cannot find English text | A new simulator uses the language of the Mac. Target the text as it appears on screen. |
| Screenshots work, but touch fails with `no display service` | The developer disk image on the iPhone lacks the display service. See [Touch and text input fail](physical-iphone.md#touch-and-text-input-fail). |
| `This device is not recording` from `bin/call.mjs` | A recording ends when its session closes. Record from one MCP client session. |

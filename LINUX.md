# Poki MCP on Linux (unofficial port)

This fork adds Linux host support for **physical iPhones** to
[Poki](https://github.com/JosssphZhou/poki). Upstream supports macOS only;
the device protocol stack it is built on (usbmuxd, the CoreDeviceProxy
software tunnel, RemoteXPC/RSD, the accessibility audit service and
CoreDevice HID) is platform-independent, so the port is a set of small
host-side adaptations, not a rewrite. The port took upstream `main`
once more on 2026-11-27 (commit `0719803`) and has diverged from it
since. It carries the MCP daemon, the Rust bridge and Poki Agent;
upstream's Poki iPhone app, Poki Setup installer, voice bridge and
release pipeline are not part of it. It stays AGPL-3.0-only, like
upstream.

## Scope

Works on Linux:

- The MCP daemon and all physical-device tools that go through the Rust
  bridge or idevice-tools: device discovery, the accessibility element
  tree (`list_elements`), screenshots and recording, taps and gestures,
  typing, app list/launch, and the rest of the bridge-backed tool set
- Remote connections (the upstream Tailscale/RemotePairing path lives in
  the bridge and is not macOS-specific)
- The Telegram and terminal channels of Poki Agent

Not supported on Linux:

- The iOS Simulator (there is no iOS Simulator for Linux)
- The iMessage channel (its gateway is a macOS app)
- `build_and_run` (building an iOS app requires Xcode)

## Requirements

- Linux with usbmuxd installed and running (Arch: `pacman -S usbmuxd`;
  Debian/Ubuntu: `apt install usbmuxd`)
- Node.js 24 or newer, the Rust toolchain, FFmpeg, git, python3
- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
  (`pip install pymobiledevice3`) for the one-time DeveloperDiskImage
  installation — Linux has no Xcode to take the image from — and, at
  runtime, for the device services behind `terminate_app`, crash-log
  access and app-container export, which macOS reaches through
  `xcrun devicectl`
- Optional: `zenity`, used for the human-approval dialogs of sensitive
  tools in `ask` mode, on a host with a display

## Setup

```sh
./bin/setup            # checks prerequisites, fetches the pinned idevice
                       # checkout, builds idevice-tools, installs npm
                       # dependencies, builds the native bridge
```

Then prepare the iPhone (once):

1. Connect it by USB, unlock it, and tap **Trust** on the pairing prompt.
2. Turn on **Developer Mode** (Settings → Privacy & Security →
   Developer Mode). On a device with a passcode this can only be done on
   the device itself; `pymobiledevice3 amfi reveal-developer-mode` makes
   the toggle appear if it is missing. The device restarts and asks for
   the passcode once more. Also enable **UI Automation** under
   Settings → Developer.
3. Install the DeveloperDiskImage:

   ```sh
   node bin/prepare-device.mjs
   ```

   On Linux this delegates to `pymobiledevice3 cryptex auto-install`,
   which downloads the image, has Apple personalize it for the device,
   and installs it. Set `POKI_PYMOBILEDEVICE3` if the binary is not on
   `PATH`. Run it with a single iPhone connected.

There is no daemon to start by hand, as on macOS: the stdio server a
client registers starts the shared daemon on its first tool call and
lets it exit after 10 idle minutes (see
[docs/install.md](docs/install.md#1-build-from-source)).
`node bin/call.mjs <tool>` makes one-off calls the same way. `npm start`
runs a long-lived daemon instead. State lives in
`$XDG_STATE_HOME/PokiMCP` (default `~/.local/state/PokiMCP`) unless
`POKI_MCP_STATE_DIR` is set.

For wireless use on iOS 27+, pairing needs no USB at all. From any MCP
client, call `pair_device` (or ask the agent to pair the iPhone) and
follow `pairing_status`, or the pairing view in an MCP Apps client such
as LobeHub ([docs/lobehub.md](docs/lobehub.md)). Keep the Linux host and
iPhone on the same LAN, select the host in Settings › Privacy & Security
› Developer Mode on the phone, and type the six-digit PIN. Poki then
installs the DeveloperDiskImage through the new RemotePairing tunnel
(cryptexd, personalized by Apple, so the host needs internet access);
pymobiledevice3 is not involved on this path. When `list_devices`
later reports `display_service: false` for the phone, `pair_device`
with `device` installs the image again. `unpair_device`
removes a pairing without restarting anything. See
[docs/tools.md](docs/tools.md#pair-iphones-over-wi-fi).

The same pairing works from a terminal:

```sh
node bin/prepare-remote.mjs --wireless
```

That command creates only the pairing record; run
`node bin/prepare-device.mjs` over USB, or `pair_device` with `device`,
for the DeveloperDiskImage. Either way, the LAN address that paired is
saved unless you pass `HOST`, and DHCP can change it later. Pass the
phone's advertised `.local` name as `HOST` to keep resolving it on the
LAN, or its Tailscale address when the saved route should use
Tailscale. Developer Mode and UI Automation stay separate
device-preparation steps on the phone.

## Running the daemon as a user service

On a host that should keep Poki available, or serve clients on other
machines, run the daemon under systemd's user manager. Clients find it
in `mcp.json` and use it instead of starting their own; it never exits
on idle. Save as
`~/.config/systemd/user/poki-mcp.service`:

```ini
[Unit]
Description=Poki MCP daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/poki-mcp
ExecStart=/usr/bin/node /path/to/poki-mcp/src/daemon.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now poki-mcp.service
loginctl enable-linger "$USER"   # keep it running without an open session
```

If Node.js lives somewhere else (a version manager, a private
prefix), point `ExecStart` at that binary. Set `POKI_MCP_STATE_DIR`
with an `Environment=` line in the unit when the state directory
should differ from the default — and pass the same value to every
client, as described next.

The unit's environment also decides the approval mode. A user service
normally has neither `DISPLAY` nor `WAYLAND_DISPLAY`, so it runs in
`host` mode unless the unit sets `POKI_MCP_APPROVAL_MODE` (see
[Approval](#approval-on-linux) below).

A stdio process never restarts this service. After an update, restart it
yourself with `systemctl --user restart poki-mcp.service`.

The Linux device-service paths (`terminate_app`, crash reports,
app-container export) shell out to `pymobiledevice3`. When it is
installed in a virtualenv it is not on the service's `PATH`, and
those tools fail with `spawn pymobiledevice3 ENOENT`. Point the
service at the binary with a drop-in
(`~/.config/systemd/user/poki-mcp.service.d/pymobiledevice3.conf`):

```ini
[Service]
Environment=POKI_PYMOBILEDEVICE3=/path/to/venv/bin/pymobiledevice3
```

## Connecting an MCP client

The daemon serves HTTP on a loopback port with a random bearer
token, and rewrites both on every start in `mcp.json` inside the
state directory. **Never copy that URL or token into a client
configuration** — it is stale the moment the daemon restarts.
Clients connect through the stdio bridge in this repository,
`src/stdio.mjs`, which finds the daemon through that file, starts one
when none is running, and re-reads the file when the daemon rejects a
stale endpoint (401) or is unreachable, so a daemon restart needs no
client-side change. Several stdio processes share one daemon, so a
client that starts and stops them as it needs them, such as LobeHub's
`lh connect`, keeps its sessions and leases in that daemon.

Claude Code:

```sh
claude mcp add --scope user poki-mcp -- node /path/to/poki-mcp/src/stdio.mjs
```

Pi (an entry in `~/.pi/agent/mcp.json`):

```json
{
  "mcpServers": {
    "poki": {
      "command": "node",
      "args": ["/path/to/poki-mcp/src/stdio.mjs"],
      "cwd": "/path/to/poki-mcp"
    }
  }
}
```

With a non-default state directory, give every client the same
`POKI_MCP_STATE_DIR` (and the user service, if you run one): the
`--env` flag for `claude mcp add`, or an `env` object next to `args`
for Pi. A daemon a client starts takes its settings from that client's
environment (never its secrets), so daemon settings such as
`POKI_MCP_APPROVAL_MODE` go in the same place.

### Approval on Linux

Sensitive tools (`install_app`, `uninstall_app`, `build_and_run`,
`open_url`, `download_app_container`, `get_clipboard`, `set_clipboard`)
need approval, and `POKI_MCP_APPROVAL_MODE` decides who gives it
([details](docs/tools.md#approval--clipboard-behavior)). Without the
variable, a daemon whose environment has neither `DISPLAY` nor
`WAYLAND_DISPLAY` (a headless machine, an SSH session, a systemd user
service) runs in `host` mode: Poki shows no dialog, and the MCP client
decides from the tools' `destructiveHint`/`openWorldHint` annotations.

**LobeHub's MCP tool permission defaults to `auto`.** With Poki as a
stdio MCP server on a headless Linux machine reached through
`lh connect`, these tools therefore run with no confirmation at all
unless you set them to require approval in the LobeHub connector's
tool settings. In `host` mode `batch_commands` and `run_code` refuse
these tools, so the client is always asked about the tool itself.
`unpair_device` also deletes a saved pairing; it carries
`destructiveHint`, so set it to require approval as well if you want
LobeHub to ask. Setting up the connector, binding it to the machine that
runs Poki, and the pairing view are described in
[docs/lobehub.md](docs/lobehub.md).

With a display, the default is `ask`, which shows a `zenity` question
dialog. `POKI_MCP_APPROVAL_MODE=allow` lets the tools run with nobody
asked.

To serve clients on other machines (a home server or a router, as in
[deploy/istoreos](deploy/istoreos/README.md)), set `POKI_BIND_HOST` to
the addresses to listen on and `POKI_HOST_ALLOW` to the `Host` headers
those clients send; the allowlist must include `127.0.0.1` so local
clients keep working. Those listeners serve HTTPS from
`POKI_TLS_CERT` and `POKI_TLS_KEY`; without them the daemon refuses to
put the bearer token on the network in plain HTTP, unless
`POKI_ALLOW_PLAINTEXT_BIND=1` says the network is already encrypted end
to end (a tailnet). `POKI_MCP_TOKEN` (at least 32 characters) fixes the
bearer token across restarts for such clients. See
[docs/configuration.md](docs/configuration.md).

## Verified on real hardware

Host: Arch Linux (x86_64), usbmuxd 1.1.1, Node.js 24.22, pymobiledevice3
11.50. Device: iPhone18,4 running iOS 27.0.1, USB connection.

| Check | Result |
| --- | --- |
| Pairing and lockdown over usbmuxd | works |
| DeveloperDiskImage via pymobiledevice3 (`MobileAsset.DDI 27.1.5228.8`) | installed, including a reinstall through `bin/prepare-device.mjs` after an uninstall |
| `list_elements` (accessibility tree, 420×912 pt) | works |
| `take_screenshot` (lossless device capture) | works |
| `tap` (open and close an app sidebar, verified by tree changes) | works |
| Approval dialog via `zenity` (dialog timeout leaves the action unapproved) | works |
| Wireless control over the LAN (RemotePairing to the iPhone's LAN address; live TCP tunnel, tree and screenshot over Wi-Fi) | works |
| `type_text`, `swipe`, `press_key` on the real device | works |
| `terminate_app`, `list_crashes`, `get_crash` over USB (pymobiledevice3 paths) | works, including the `already_stopped` result for an app that is not running |
| `install_app` / `uninstall_app` over USB with a locally signed (free provisioning) package | works; the installed app launches once the user trusts the developer certificate under Settings → General → VPN & Device Management |
| First device call after a daemon restart (RemotePairing target, startup warm-up) | works; a screenshot returns in seconds instead of paying session setup inline |
| Screenshot prompt check through OCR (tesseract recognizer as `build/ocr`; reports `checked`, and flows that force an OCR read such as `hide_keyboard` work) | works |
| `npm test` | every test file passes on its own; see the note below |

Test-suite note: the full suite also needs the agent dependencies
(`npm ci --prefix agent`), which the update tests exercise through the
CLI. Every test file passes on the reference host (136 tests in
total). An earlier revision of this note blamed 9 failing
coordination tests on timing; they were in fact two porting gaps —
the app-management paths called the macOS-only `plutil` and `ditto`,
and the test fixture did not stub `zenity` — both fixed since.

## Known limitations

- OCR recognition quality on Linux is tesseract's, not Vision's: clear
  UI text reads well, small or stylized text may be missed, so the
  accessibility tree stays the primary observation source (the same
  ordering upstream uses).
- `get_clipboard` decides whether the clipboard holds an image from a
  list of known image types (`src/uti.mjs`) instead of macOS's UTType
  registry, so an image type outside that list that does not end in
  `-image` is reported as not an image.
- `open_url` has no Linux implementation on any transport: upstream
  it calls `xcrun devicectl`, and neither pymobiledevice3 (lockdown,
  DVT and CoreDevice command groups) nor the idevice tools expose an
  open-URL service.
- RemotePairing carries only the bridge-backed tools (including the
  `get_clipboard` read, which goes through the bridge's pasteboard
  service). For a remote target, poki's transport gate rejects the
  other platform tools — `terminate_app`, `open_url`, crash-log
  access, app-container export, install/uninstall, settings,
  location — before any host tool runs, on every host OS. The pymobiledevice3
  paths in this port therefore cover USB connections; over
  RemotePairing those tools stay unavailable, even though
  pymobiledevice3 could reach several of the same services over a
  tunnel of its own (it would need its own RemotePairing pairing
  record next to poki's, which this port does not set up). Clipboard
  writes are not affected: the bridge sets and restores the
  pasteboard inside its own input path.
- A RemotePairing host given as a `.local` name is resolved through
  the system resolver, which on Linux needs avahi with nss-mdns.
  Without them, configure the phone's numeric address instead.
- Crash-report listings on Linux come from pymobiledevice3, which
  reports paths only: entries carry no modification time or size,
  and ordering falls back to the report names, which embed their
  timestamps.
- `download_app_container` reads the data container through the
  house-arrest service, which only vends containers of
  development-signed apps; the device refuses App Store apps
  (`InstallationLookupFailed`), the same restriction devicectl
  container copies have on macOS. The export pulls the container's
  `Documents`, `Library` and `tmp` directories one by one: the
  container-manager metadata file at the container root is
  protected (`PERM_DENIED`), so pulling the root itself always
  aborts. `SystemData` is system-managed and the service denies
  reading it, so it is not part of the export.
- In `ask` mode, human approval for sensitive tools uses a `zenity`
  question dialog. Without zenity the tools raise an explicit error
  instead of silently proceeding. Without a display the default is
  `host` mode, where the MCP client decides; see
  [Approval on Linux](#approval-on-linux).
  `POKI_MCP_APPROVAL_MODE=allow` remains available for hosts where
  unapproved sensitive actions are acceptable.
- On some Linux npm setups, `npm ci` silently skips sharp's prebuilt
  `@img` packages and sharp then fails trying to build from source.
  `bin/setup` installs with `--ignore-scripts` on Linux and runs
  `bin/setup-linux-deps.mjs`, which verifies that sharp loads and
  installs the pinned `@img` packages explicitly when it does not.

## Changes from upstream

- `bin/setup`: Linux prerequisite flow (no Xcode requirement; requires
  usbmuxd, tesseract, and libplist's `plistutil` plus zip/unzip),
  prerequisite hints worded per platform, shared idevice/Node
  steps, script-free npm install plus the sharp verification above;
  the setup test in `test/protocol.test.mjs` asserts each platform's
  own expectations
- `bin/build-native`: builds the Rust bridge on Linux, including the
  Rust OCR recognizer installed as `build/ocr`; the Swift OCR and
  Objective-C simulator helpers are macOS-only and skipped
- `native/bridge/src/bin/ocr.rs` (new): a tesseract-backed recognizer
  printing the same JSON contract as `native/ocr.swift` — word rows
  grouped into screen lines, narrow captures upscaled first;
  `POKI_OCR_LANGS`, `POKI_OCR_PSM` and `POKI_OCR_UPSCALE` tune it
  (defaults `chi_sim+eng+jpn`, `11`, `2`)
- `bin/prepare-device.mjs`: on Linux, installs the DeveloperDiskImage
  through pymobiledevice3 instead of the Xcode `iOS_DDI` directory
- Wireless pairing from MCP (`pair_device`, `pairing_status`,
  `pairing_cancel`, `unpair_device`, `src/pairing/`): daemon-held
  pairing jobs, DeveloperDiskImage installation over the RemotePairing
  tunnel (`native/bridge/src/ddi.rs`), and the `ui://poki/pairing`
  MCP Apps view (`src/views/`)
- `src/config.mjs`: default state directory follows the XDG state
  convention on Linux (macOS path unchanged)
- `src/human.mjs`: approval dialogs fall back to `zenity` on Linux;
  without a display the default approval mode is `host`, where the MCP
  client decides
- `src/platform.mjs` and `src/work.mjs`: app-package and property-list
  work uses `plistutil` and zip/unzip on Linux in place of the
  macOS-only `plutil` and `ditto` (the macOS tools are unchanged);
  `execute()` passes a working directory through for the zip call
- `src/platform.mjs`: the physical-device paths upstream drives
  through `xcrun devicectl` — process termination, crash-report
  listing and download, app-container export — use pymobiledevice3
  on Linux instead (DVT process control; the crash-report and
  app-container AFC services), located through
  `POKI_PYMOBILEDEVICE3` as in `bin/prepare-device.mjs`; the macOS
  calls are unchanged, and `open_url` has no equivalent and stays
  on devicectl
- `src/remote.mjs` and `src/daemon.mjs`: the daemon warms each
  configured RemotePairing helper at startup with a `device_info`
  request, so the first device call no longer pays for helper start
  and session setup inline (previously that cost landed inside the
  first call and could outlast a client's request timeout)
- `test/fixture.mjs`: the fixture stubs `zenity` alongside `osascript`,
  so the approval-dialog flow is exercised on the Linux branch too;
  it also stubs `pymobiledevice3`, so the coordination suite covers
  the Linux device-service paths above
- `.github/workflows/tests.yml` (new): CI on Ubuntu — the full
  `./bin/setup`, the agent dependencies, then each test file in its
  own process
- `src/uti.mjs` (new) and `src/platform.mjs`: on Linux, `get_clipboard`
  classifies image types in JavaScript instead of calling the macOS
  `build/simulator` helper, which is not built there
- `src/config.mjs`: the "no USB iPhone" notice points to usbmuxd on
  Linux instead of Finder and devicectl
- The 2026-11-27 sync left out upstream's Poki App code (the iPhone
  app, PokiCore, the on-phone launcher, Poki Setup, the voice bridge,
  the relay, and their workflows, tests and docs), the `install_app`
  special case for Poki's own bundles and the `look`/`do` guard
  against Poki's own app, and upstream's `native/ocr-linux.py`, which
  duplicates the Rust recognizer above

Everything else is upstream code as of the sync.

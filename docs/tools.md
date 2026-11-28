# Tool behavior and conventions

**Poki MCP** is a local macOS MCP server that lets AI clients inspect and control an iPhone or iOS Simulator. By default it lists the tools for phone tasks, and it can expose a complete catalog for screenshots, accessibility and Vision OCR inspection, touch and keyboard input, application management, screen recording, and diagnostics.

- **Screen & UI Inspection**: Capture screenshots (`take_screenshot`, `save_screenshot`) and inspect UI hierarchies via Accessibility or Vision OCR (`list_elements`).
- **Touch & Keyboard Input**: Send taps, swipes, hardware keys, and Unicode text across simulators and paired physical devices.
- **App & Device Lifecycle**: Manage applications, open URLs, inspect containers, record video, and run diagnostic checks.
- **Local Daemon Architecture**: Runs one local service per state directory, started by the first MCP client call or by `npm start` (`127.0.0.1:47825` by default), with per-device execution order, per-client session isolation, and approval gates for sensitive actions. Loopback only unless `POKI_BIND_HOST` names another address, and `POKI_HOST_ALLOW` then lists the `Host` names it answers to; those listeners serve HTTPS with `POKI_TLS_CERT` and `POKI_TLS_KEY`, or plain HTTP only with `POKI_ALLOW_PLAINTEXT_BIND=1`. `127.0.0.1` is always served over plain HTTP, because local clients read that endpoint from `mcp.json`.

Tool names and input validation schemas live in [`src/data/tools.json`](../src/data/tools.json) with remote connection maintenance definitions in [`src/tools.mjs`](../src/tools.mjs). MCP serves them through `tools/list`. `poki_mcp_status` returns the available device count, approval mode, and separate counts for device, management, and total tools.

## Breaking changes in 0.2.0

- `device` is required on every tool that acts on a device, including `look`, `do`, `wait`, `disconnect_device`, `reconnect_device` and `acquire_device`. Pass an id from `list_devices` or an exact device name.
- `select_device`, the session's selected device, `POKI_MCP_DEVICE`, and the `selected` field of `poki_mcp_status` and `list_devices` are removed. When exactly one device is listed, `list_devices` returns it as `default`, with a `default_note`.
- `batch_commands` takes one required top-level `device`. Its steps run on that device, and a step that names `device` is rejected.
- `run_code` takes required `devices`, 1 to 8 ids or names. Every `tools.<name>(...)` call in the script names its `device`, which must be one of them.
- `POKI_INPUT_LOCK` is removed. Per-device coordination is always on, and there is no global queue. See [One daemon, several clients](#one-daemon-several-clients).
- `POKI_MCP_APPROVAL_MODE=host` is new. It is the default on a Linux host with neither `DISPLAY` nor `WAYLAND_DISPLAY`. See [Approval & Clipboard Behavior](#approval--clipboard-behavior).

The stdio server now starts the shared daemon itself, so `npm start` is optional. See [Install](install.md#1-build-from-source).

## MCP tool profiles

The default `tools/list` response contains the tools for phone tasks. Tool names, arguments, and execution behavior are unchanged.

| Use | Default tools |
| --- | --- |
| Service and devices | `poki_mcp_status`, `list_devices` |
| Read the screen | `list_elements`, `take_screenshot`, `get_foreground_app` |
| Apps and URLs | `list_apps`, `launch_app`, `terminate_app`, `open_url` |
| Touch and input | `tap`, `tap_text`, `long_press`, `double_tap`, `drag`, `pinch`, `fill`, `type_text`, `scroll`, `scroll_to`, `swipe`, `press_key`, `go_back`, `hide_keyboard`, `press_button`, `get_clipboard` |
| Wait, prompts, and batches | `wait_for`, `handle_alert`, `batch_commands` |
| Wireless pairing (every profile) | `pair_device`, `pairing_status`, `pairing_cancel` (pairing view only), `unpair_device` |
| Live screen (every profile) | `show_screen`; for the screen view only: `screen_open`, `screen_read`, `screen_close`, `screen_keyframe`, `screen_input`, `screen_takeover`, `screen_rtc_config`, `screen_rtc_offer` |

The runtime default list is defined in `src/tools.mjs`. The complete catalog includes simulator management, app installation, recording, location, appearance, drawing with `touch_path` and `draw_strokes`, and device leases.

### Complete catalog

`POKI_MCP_TOOLS=all` makes `tools/list` return the complete catalog. Any other value, including an unset or empty value, selects the default list.

For a stdio client, the variable belongs to the MCP process environment. This client configuration enables the complete catalog:

```json
{
  "mcpServers": {
    "poki": {
      "command": "node",
      "args": ["/absolute/path/to/poki-mcp/src/stdio.mjs"],
      "env": {
        "POKI_MCP_TOOLS": "all"
      }
    }
  }
}
```

The client needs to reconnect after a configuration change. Each stdio client has its own profile, independent of the daemon's profile.

Direct HTTP clients receive the daemon's profile. Starting the daemon with `POKI_MCP_TOOLS=all npm start` enables the complete catalog for those clients.

### Calls and devices

Profiles affect discovery only. Every tool remains callable by name through `tools/call`, including tools absent from `tools/list`. The same applies to steps inside `batch_commands`. Argument validation, approvals, cancellation, and device arbitration still apply.

Every tool that acts on a device takes a required `device`: an id from `list_devices` or an exact device name. Call `list_devices` once and pass that id on every call. When exactly one device is listed, `list_devices` also names it in `default`. `start_simulator` returns the id of the simulator it boots or creates, and any call that names a listed simulator that is shut down boots it.

Consecutive device calls do not require `acquire_device`. An explicit lease remains available for sessions that need exclusive access across several calls. Another session's lease can still block access.

Poki Agent starts its own stdio process with `POKI_MCP_TOOLS=all`. Its existing tool allowlist determines which tools reach its model.

### Computer-use profile: look and do

`POKI_TOOL_PROFILE=cua` lists only `look`, `do`, `list_apps`, `list_devices` and `poki_mcp_status`, plus the [pairing tools](#pair-iphones-over-wi-fi) every profile lists, with short server instructions. `look` and `do` take a required `device`, like every device tool. It works the way desktop computer-use tools do: `do` runs a list of actions in order (tap by element number or point, type, key, swipe, scroll_to, long_press, drag, pinch, button, launch, wait), waits a short fixed time after the last one, and reads the screen once; `look` reads it without acting. Each answer lists the screen's elements with numbers for the next call, marks the ones that are new since the previous read, names what disappeared, and attaches a screenshot. There is no verdict: the model decides what happened from the elements and the picture.

- Each action is reported as `sent`, `not_sent` or `unknown`. Nothing after a failed action is sent, and an `unknown` action is never sent again. Element numbers that are not in the latest read are refused before anything is sent.
- `look` and `do` work on a physical iPhone through the native bridge, on a booted simulator, and on a phone running WebDriverAgent (see below). A physical iPhone needs the bridge built from this version by `./bin/setup`, because typing uses its `type_keys` and `pasteboard` operations.
- On a physical iPhone, typing uses hardware key presses (the bridge's `type_keys`). Only text the keyboard cannot type is pasted, and then the user's clipboard is saved first and put back afterwards; a clipboard that cannot be read back exactly is never pasted over. Key presses that fail part way are reported `unknown` and are never followed by a paste, with or without `clear`.
- On a simulator, `launch` starts the app with `simctl` the way `launch_app` does, and `type` uses the simulator's own `type_text`: key presses, and for text the keyboard cannot type a paste through the simulator's pasteboard, which keeps that text afterwards.
- Accessibility gets `POKI_CUA_TREE_MS` (default 2500 ms) per read; after that the screenshot's OCR answers instead. When accessibility names nothing across a third of the screen's height, the screenshot's text it did not name is listed after its elements, and the read says `accessibility + ocr`. Actions and the wait after them get at most `POKI_CUA_ACTION_CAP_MS` (default 4000 ms).
- A locked or dark phone stops the actions.
- `POKI_CUA_BACKEND=wda` with `POKI_WDA_URL=http://<phone>:8100` reads and acts through a
  WebDriverAgent runner deliberately launched for network access from the host instead of the bridge.
  That WDA must use a reachable, non-loopback `USE_IP`. `look` and `do` answer the same way on either backend.
  WDA drives the iPhone named by `device`, so device leases apply to it as they do to the bridge. A host that
  sees no iPhone at all lists the phone as `wda:<POKI_WDA_URL>` (name `WebDriverAgent`) in `list_devices`;
  pass that id as `device` to `look` and `do`. Only those two drive it.

The complete catalog (`POKI_MCP_TOOLS=all`) includes `look` and `do` too.

### One daemon, several clients

Every stdio process (`src/stdio.mjs`) uses the one daemon of its state directory, and starts it when none is running (see [Install](install.md#1-build-from-source)). Device locks and every session's queues, leases and recordings live in that daemon, and several clients coordinate through it. A session belongs to one stdio process, though: when that process exits or stops sending its heartbeat, the daemon closes the session and ends its leases, refs, recordings and simulated locations (see [Install](install.md#1-build-from-source)).

Calls are coordinated per device:

- Each (session, device) pair keeps its calls in the order they were sent. Calls to different devices, from one session or several, run at the same time.
- A tool that changes the screen holds that device's input lock for the whole call. The lock belongs to the device a call resolves to, so a session that names a phone and one that gives its id wait for each other. `run_code` holds the locks of the devices in its `devices`, and only those, while it runs.
- Read-only tools take a read slot instead, capped by `POKI_MAX_CONCURRENT_READS` (default 4), and run beside another session's input.
- A call that cannot get its device's lock within `POKI_INPUT_LOCK_WAIT_MS` (default 30000 ms) fails with an error that names the session and tool holding it.

The lock lives in one daemon; two daemons driving one phone are not supported.

`POKI_MCP_CALL_LOG=<path>` appends one JSON line per finished tool call: the tool, how long it took, its verdict when it has one, and whether it failed. Arguments, text and images are never written, and the session appears only as a hash.

## Pair iPhones over Wi-Fi

The pairing tools run iOS 27 wireless pairing from any MCP client, without USB and without a terminal on the Poki machine. They act on this computer's pairing state, so they never wait behind a device's queue, and none of them works inside `batch_commands` or `run_code`.

1. `pair_device {name?}` returns `{ job }` at once. The computer advertises itself on the local network as `name` (default: its host name). Only one pairing runs per computer (there is one Bonjour name); a second `pair_device` returns the running pairing (`existing: true`). The pairing helper stops with the service: on cancel, on shutdown, and when the service dies without either (its standard input closes).
2. Poll `pairing_status {job}` about every two seconds. Each job reports `kind` (`pair` for a new pairing, `prepare` for `pair_device {device}`). States, in order: `starting` → `advertising` (on the iPhone: Settings › Privacy & Security › Developer Mode › **Pair with NAME**) → `pin` (`pin` holds the six digits to type on the iPhone) → `paired` → `registering` → `mounting_ddi` → `ready`. `failed` and `cancelled` are the other terminal states; `terminal` is true for all three.
3. In `mounting_ddi` Poki installs the developer disk image (DDI) through the new RemotePairing tunnel, which touch and text input need. The image comes from `POKI_DDI_DIR`, Xcode's `iOS_DDI/Restore` (macOS), a copy pymobiledevice3 already downloaded, or a one-time download pinned to one commit of the image mirror pymobiledevice3 uses and checked by SHA-256 (stored in the state directory under `ddi/`). Apple personalizes the image for the phone, so the Poki machine needs internet access to `gs.apple.com`. A `ready` job carries `ddi`: `already_mounted` (the phone had it), `version` (of the installed image, when cryptexd reports it) and `source` (`POKI_DDI_DIR`, `xcode`, `pymobiledevice3` or `download`, when it installed one).
4. A failure names its `stage` (`pairing`, `registering`, `ddi`, or `internal`), a `reason`, the underlying `error`, and the `action` to take:

| `reason` | Meaning | Action |
| --- | --- | --- |
| `pairing_failed` | The iPhone or the pairing helper ended the pairing. | Retry from Developer Mode; iOS 27+ on the same network. |
| `timeout` | Nobody finished on the iPhone within 10 minutes. | Call `pair_device` again. |
| `ddi_image_unavailable` | No image found and the download failed. | Check internet access or set `POKI_DDI_DIR`. |
| `ddi_signing_failed` | Apple's signing server refused or was unreachable. | Check access to `gs.apple.com`. USB would need the same signature, so it does not help. |
| `ddi_tunnel_unsupported`, `ddi_tunnel_install_failed` | The phone would not install the image over the tunnel. | Connect USB once and run `node bin/prepare-device.mjs DEVICE_ID`. |
| `helper_missing` (stage `pairing`) | `build/poki-native` could not start. | Run `./bin/setup`, then pair again. |
| `registration_failed` (stage `registering`) | The pairing finished but could not be saved, for example without a usable address. | Pair from a terminal with a host: `node bin/prepare-remote.mjs --wireless HOST`. |
| `device_busy` (stage `ddi`, or `registering` when pairing a registered phone again) | Another session leases the phone, or its input held the phone for longer than `POKI_INPUT_LOCK_WAIT_MS`. A registered phone keeps its old pairing. | Call `pair_device` (with `device` for the image) again once it is done. |
| `internal_error` (stage `internal`) | An unexpected error in the job. | Retry `pair_device`; check the service log if it repeats. |

A `ddi` failure keeps the pairing (`paired: true`): the device is listed and reads work; input waits for the image. Whenever `list_devices` reports `display_service: false` for a wireless device (for example after the iPhone lost its mounted image), it adds an `action`; `pair_device {device}` installs the image again over Wi-Fi without pairing again (the pairing view offers the same as **Retry developer image** and **Install developer image**). That job runs beside a pairing of another phone and checks the device's lease like any device call; a second call for the same phone returns its job. It first reconnects the tunnel: `display_service` comes from the service list the phone sent when the tunnel opened, so an image mounted another way since (over USB with `prepare-device`) shows only after a new handshake, and then nothing is installed. `reconnect_device` refreshes that list for `list_devices` too. While a job installs the image (`mounting_ddi`, which can take minutes), every other call to that phone fails at once and names the job.

`pairing_cancel` stops the pairing helper, which withdraws the Bonjour service. When the iPhone had already accepted the pairing (`paired` or `registering`), the job waits for the registration and removes it again, unless the phone was registered before this job; the reply's `note` says what is on this computer now (nothing, the earlier pairing, or the new one), read from the registry. The removal waits at most 3 s for another process holding the registry; when it fails, the note says so, keeps the error, and names the cleanup: `unpair_device` for that device, or, with the service stopped, deleting its entry in `remote-devices.json` and its `remote/<id>` directory. While a registered phone is paired again, its old helper and configuration are replaced and other calls to it are refused, as during `unpair_device`.

The pairing view follows the pairing and each phone's developer-image job separately, so installing the image on one phone never hides the PIN of a pairing in progress.

`unpair_device {device}` takes a wireless device's id or exact name. It is a gated tool (see [Approval & Clipboard Behavior](#approval--clipboard-behavior)): in `ask` mode a person on the Poki computer confirms it. It marks the device unavailable to every session until it finishes, cancels that device's pairing job, ends every session's accepted calls, recordings, locations and leases on it, asks its RemotePairing helper to disconnect and exit (a helper that is not running is not started, one still starting is stopped once it is up, and one that does not answer because it is busy is stopped by its pid), and deletes its `remote-devices.json` entry and `remote/DEVICE_ID/` directory. The device leaves `list_devices` at once, without a restart. The reply's `phone_cleanup` says how to remove this computer on the iPhone. USB devices are refused: Poki does not pair them.

`list_devices` adds `pairing: { host: { name, advertising }, jobs }` (jobs from the last 15 minutes) and, for each wireless device, `display_service` (whether the tunnel's service list has displayservice, which input needs), or `pairing_job` while a job prepares it. Pairing jobs live in the shared service, not in the stdio process: a client that recycles its stdio processes (LobeHub's `lh connect`) keeps them, and the service does not exit for idleness while one runs.

## MCP Apps views

Poki serves MCP Apps views as `ui://poki/*` resources (`text/html;profile=mcp-app`). The stdio process answers `resources/list` and `resources/read` itself, so a host can load a view before Poki's service runs. Each view is one self-contained HTML file in `src/views/`; the `@modelcontextprotocol/ext-apps` App bundle is inlined when the resource is read. Views make no network requests of their own (empty CSP domain lists); everything goes through the host's `tools/call`.

`tools/list` carries each tool's `_meta`: `ui.resourceUri` (and the older `ui/resourceUri`) for the tool that opens a view, `ui.visibility` (`["model", "app"]`, or `["app"]` for tools only a view calls), and `lobehub/ui.preferredModelDisplayMode`. App-only tools are listed too. An MCP Apps host that applies `ui.visibility` (LobeHub with `mcp_apps` does) hides them from the model; a client that does not ignores `_meta` and shows them like any tool. Poki Agent leaves them out. Hosts without MCP Apps get the same results as text and structured content. See [Use Poki from LobeHub](lobehub.md).

## Live screen

`show_screen {device?}` opens the screen view (`ui://poki/screen`) in LobeHub's side panel (`lobehub/ui.preferredModelDisplayMode: "fullscreen"`), where the person watches a paired iPhone and taps, swipes and types on it. Without `device` the view's own device menu chooses the iPhone. In a client without MCP Apps it only returns a short text. Streaming keeps the iPhone's displayservice session open, and while it is open **iOS keeps the camera and microphone busy** for other apps: the session is released one second after the last viewer leaves, and a viewer the view stops renewing ends after 10 seconds.

The video is the HEVC the iPhone itself sends (see [native/NATIVE.md](../native/NATIVE.md#screen-video)). One subscription per device is shared by every viewer. The view picks what its browser can decode, in this order: HEVC as sent, H.264 transcoded on this computer, or JPEG (at most 10 pictures a second, only the latest kept). Transcoding needs `ffmpeg` with `libx264`; it runs only while a viewer reads that codec. Measured on 2026-11-28 in a sandboxed MCP Apps frame: Chrome and Safari on macOS decode HEVC and H.264; Google Chrome on Linux without a hardware decoder decodes H.264 only; Chromium builds without proprietary codecs (Playwright's) show JPEG.

Transports, chosen by the view and shown in its corner with the codec, frames per second and the last round trip:

| | How | When |
| --- | --- | --- |
| WebRTC | `screen_rtc_config` and `screen_rtc_offer` exchange one offer and answer (no trickle); frames come on a DataChannel. | The view's browser reaches this computer (host or STUN candidates, or the TURN server below) within three seconds. |
| Tool calls | `screen_read` long polls (`wait_ms` up to 1000), two in flight, a batch of frames each. | Always available, including through LobeHub's relay from any network. |

`screen_read {stream, ack, credit, wait_ms, resync?, max_bytes?}`: `ack` is the last frame decoded, which returns credit; frames that would be sent after a gap, or more than a second late, are dropped up to the next key frame, never inside a chain; a keyframe is requested at most once a second. One reply carries at most `POKI_SCREEN_READ_MAX_BYTES` (default 256 KiB) and `POKI_SCREEN_READ_MAX_FRAMES` (default 16); a single frame over the limit travels alone. The defaults are below the 500 KB frames measured through LobeHub's relay with its local gateway; its production gateway's limits are not measured, and a view whose reads fail halves `max_bytes` before it falls back to the next codec. `POKI_SCREEN_H264_BITRATE` sets the transcoder's starting bitrate (default 1.5 Mbit/s); it adapts between 0.3 and 4 Mbit/s to how quickly frames are acknowledged.

`screen_input {stream, kind, x, y, x2?, y2?, t_ms?, ...}` sends one gesture or key: `tap`, `long_press`, `swipe`, `drag`, `pinch` (`start_distance`, `end_distance`), `button` (`home`, `lock`, `volume_up`, `volume_down`), `key` (with `modifiers`), `text`. Coordinates are normalized to the screen as shown (0..1). It goes through the device's lease and input lock like any input, waiting at most 1.5 seconds: while the agent holds the device, or has input running on it, the reply is `reason: "busy"` and the view offers **Take over**. `screen_takeover {stream, confirm: true}` runs only after the person confirms in the view: it stops every other session's work and lease on that device and holds the device for the view (renewed by each input, released when the view closes). The screen tools skip the device queues, and `batch_commands` and `run_code` refuse them.

WebRTC's ICE servers: STUN `POKI_STUN_URL` (default `stun:stun.l.google.com:19302`; set it empty to use host candidates only), and TURN when `POKI_TURN_URL` is set (comma-separated `turn:`/`turns:` URLs), with credentials from `POKI_TURN_SECRET` (coturn's `use-auth-secret`, time-limited) or `POKI_TURN_USERNAME` and `POKI_TURN_PASSWORD`. Poki's WebRTC library (werift) uses only the first TURN URL, so a `turns:` URL on port 443 is put first. `POKI_SCREEN_RTC=0` turns WebRTC off.

## Ask in plain language

Ask your agent for the task you want done:

```text
Start an iPhone simulator, open Settings, and tell me the iOS version.
```

Three tools handle most interactions:

- `batch_commands` runs a known multi-step task in a single call and returns the visible on-screen text at the end, saving a screenshot round trip.
- `fill` focuses an input field, replaces its text, and verifies the new value.
- `tap_text` looks for five seconds. If the target is not found, it aborts without tapping and returns what is currently on screen. A screen accessibility cannot read gets a few more seconds for screen text recognition to answer, because that read has already started; nothing new begins after the five seconds.

Installing apps, opening URLs, and reading the clipboard need approval: a dialog on the Poki host in `ask` mode, or your MCP client's own confirmation in `host` mode. See [Approval & Clipboard Behavior](#approval--clipboard-behavior).

## Optional action verification

`tap`, `tap_text`, `swipe`, `scroll`, and `go_back` accept `verify: false`. These calls omit the reads that compare the screen before and after an action. Their results include `verified: false` and do not confirm that the app accepted the input. Omitting `verify`, or setting it to `true`, keeps the default verification.

`tap_text` still reads the current screen to locate its target. With verification disabled, it uses the first matching position without waiting for two stable positions. Coordinate actions still obtain the current display dimensions. This option does not promise a call with no device reads.

`batch_commands` also accepts `verify: false`. Supported steps inherit that value, and a step can override it with `arguments.verify: true`. A batch with unverified steps reads the final screen once. That snapshot does not verify each preceding action. An unknown input outcome still stops the batch, including with `stop_on_error: false`.

Inside a batch, a touch step (`tap`, `tap_text`, `double_tap`, `long_press`, `go_back` or `handle_alert`) is compared with the screen before it unless the next step is also aimed by coordinates (`tap`, `double_tap`, `long_press`, `swipe`, `drag`, `scroll` or `pinch`) or the batch sets `stop_on_error: false`. A run of coordinate steps is written for one screen, so the batch does not pause inside it, even after a tap that changed nothing. A step with `arguments.verify: true` is always compared. With the default `stop_on_error`, a compared touch with no observed change pauses the batch before the steps after it.

Accessibility can miss changes that affect only pixels, such as Calculator's display after AC. A default batch can still stop with `no_change` in that case. An unverified tap does not produce `no_change`; inspect the final screenshot before reporting the task result.

## All MCP tools

| Group | Tool | What it does |
| --- | --- | --- |
| Devices | `list_devices` | Find attached iOS devices and booted or previously used simulators. |
| Devices | `start_simulator` | Boot an existing simulator by id or name, or create one from an available model, and return its id. |
| Devices | `shut_down_simulator` | Shut down the simulator named by `device`. |
| Devices | `reconnect_device` | Attempt a replacement RemotePairing tunnel while preserving a working tunnel if replacement fails. Does not replay input. |
| Devices | `disconnect_device` | Close the device's RemotePairing helper and tunnel. |
| Devices | `get_device_info` | Read device identity, capture dimensions in logical points, and optionally platform settings. |
| Devices | `poki_mcp_status` | Report tool counts, connected-device count, and approval mode. |
| Pairing | `pair_device` | Start pairing a new iPhone over Wi-Fi (iOS 27+), or with `device` reinstall a paired iPhone's developer disk image; returns a job at once. Opens the `ui://poki/pairing` view. |
| Pairing | `pairing_status` | Report a pairing job: state, PIN while one is shown, device id once paired, reason and action on failure. |
| Pairing | `pairing_cancel` | Cancel a pairing job. Meant for the pairing view (`ui.visibility: ["app"]`): hosts that apply `ui.visibility` hide it from the model, other clients list it like any tool. |
| Pairing | `unpair_device` | Remove a wirelessly paired iPhone: stop its work and leases in every session, close its helper, delete its saved pairing. |
| Live screen | `show_screen` | Open the `ui://poki/screen` view on a paired iPhone (or let the person choose one there). Keeps the iPhone's camera and microphone busy while shown. |
| Live screen | `screen_open`, `screen_read`, `screen_close`, `screen_keyframe` | Start a screen stream in a codec the view decodes, long-poll its frames with credit, end it, ask for a key frame. Screen view only. |
| Live screen | `screen_input`, `screen_takeover` | One gesture or key from the view, through the device's lease and input lock; take the device from the agent after the person confirms. Screen view only. |
| Live screen | `screen_rtc_config`, `screen_rtc_offer` | ICE servers, and the answer to the view's WebRTC offer. Screen view only. |
| Coordination | `acquire_device` | Exclusively occupy one device across tool calls in this MCP session. A session may hold leases on several devices, one each. |
| Coordination | `renew_device` | Extend one of this session’s device leases by 1–600 seconds (default 120). |
| Coordination | `release_device` | Release one of this session’s device leases after cancelling this session's accepted work on that device and awaiting its recording/location cleanup. |
| Coordination | `cancel_device` | Stop previously accepted work and background recording/location in this MCP session, including calls without a lease: on one device when `device` or `lease_id` is given, otherwise on all of them. |
| Screen | `observe_device` | Capture one image with its structured observation, non-reused element references and prompt check. |
| Screen | `take_screenshot` | Capture the current display and return a JPEG image with screen dimensions and a prompt warning check. |
| Screen | `save_screenshot` | Save a full-resolution screenshot to an absolute PNG or JPEG path or directory. |
| Screen | `start_recording` | Start recording the device display to an H.264 movie. |
| Screen | `stop_recording` | Finalize this session's recording of the device and inspect the saved movie before returning its path and media details. |
| Screen | `get_foreground_app` | Read the current foreground application from accessibility services. |
| Screen | `list_elements` | Read accessibility elements, or OCR when auto mode cannot use accessibility. Auto mode adds screenshot text that accessibility leaves out across a third of the screen. |
| Screen | `wait_for` | Poll visible text until it appears, or disappears when gone=true. |
| Screen | `wait` | Pause for seconds without interacting with the device. It runs in order with this session's other calls to that device. |
| Touch | `tap` | Tap at x/y in screen points or at the center of a current element ref. |
| Touch | `tap_text` | Find one visible element matching text, waiting for it to appear and hold still (five seconds on a screen accessibility can read, longer when only screen text recognition can find it), trying OCR when needed, and tap it. |
| Touch | `double_tap` | Send two taps at x/y in logical screen points or at a current element ref. |
| Touch | `long_press` | Hold one touch at x/y or an element ref. |
| Touch | `swipe` | Move a touch from from_x/from_y to to_x/to_y in logical screen points. |
| Touch | `scroll` | Scroll up, down, left, or right around x/y, or the screen center when omitted. |
| Touch | `scroll_to` | Search for visible text and scroll until it is found, content stops changing, or max_scrolls is reached. |
| Touch | `drag` | Hold a touch, then move between the supplied logical-point endpoints. |
| Touch | `pinch` | Perform a two-finger gesture centered at x/y in screen points. |
| Touch | `touch_path` | Draw one continuous stroke through timed points, such as a circle or a curve. `time_ms` may have a fractional part. |
| Touch | `draw_strokes` | Draw 1 to 12 separately lifted strokes in one call, such as handwriting or a signature. |
| Text and keys | `fill` | Focus a field by ref, coordinates, or matching field label/placeholder/value/identifier, replace its text, and optionally submit after text verification. |
| Text and keys | `type_text` | Enter text into the focused field, optionally clearing it first and sending Return after verification. |
| Text and keys | `press_key` | Send a named keyboard key with optional modifiers and count (default one). |
| Text and keys | `hide_keyboard` | Detect a visible keyboard, send its toggle event, and verify dismissal. |
| Text and keys | `get_clipboard` | Read clipboard contents supported by the platform. |
| Text and keys | `set_clipboard` | Replace the device clipboard with text. |
| System | `press_button` | Send a hardware-style button event such as Home, lock, volume, mute, or Siri. |
| System | `system_gesture` | Send the requested system navigation gesture. |
| System | `go_back` | Tap a uniquely identified back control when available, otherwise swipe from the left edge. |
| System | `rotate` | Request a display orientation and invalidate cached coordinates. |
| System | `set_appearance` | Request light or dark appearance on the device. |
| System | `set_accessibility` | Change supported text-size or accessibility display settings. |
| System | `set_location` | Start a simulated latitude/longitude for the device. |
| System | `clear_location` | Stop the location simulation owned by this service for the device. |
| System | `handle_alert` | Choose a visible alert button by text or accept/dismiss action, looking for five seconds; recognition already running on an unreadable screen may finish after that. |
| System | `request_human_action` | Show a dialog on the Poki host (macOS, or zenity on Linux) asking the user to complete a step on the device. Refused in `host` approval mode. |
| Apps | `list_apps` | List installed applications, excluding system apps unless include_system=true. |
| Apps | `launch_app` | Launch an application by bundle_id or unambiguous name. |
| Apps | `terminate_app` | Stop an application identified by bundle_id on the device. |
| Apps | `install_app` | Install an application from a local path. |
| Apps | `uninstall_app` | Remove an installed application identified by bundle_id. |
| Apps | `open_settings` | Open a supported Settings page or an application settings page. |
| Apps | `open_url` | Ask the device to open a URL. |
| Apps | `build_and_run` | Build an Xcode project or workspace from project_path, install the result, and launch it. |
| Apps | `download_app_container` | Copy an accessible application container to a local destination, or the service state directory by default. |
| Apps | `list_crashes` | List available reports, optionally filtering by process name or bundle identifier and kind. |
| Apps | `get_crash` | Read a report by path from list_crashes, or find the newest report for process. |
| Batches | `batch_commands` | Do a whole known task on one device in one call: launch the app, tap, fill, scroll, go back and answer alerts, each {tool, arguments}. |
| Batches | `run_code` | Run an async JavaScript function on an isolated worker, calling device tools on the devices named in `devices` with `await tools.<name>(args)`, so the code loops, filters and decides each next step from the results in one call instead of a model round trip per step. |

`run_code` is in the complete catalog, not the default `tools/list`, so it is reached by name or after `POKI_MCP_TOOLS=all`. `devices` lists the 1 to 8 devices the script may use. Every `tools.<name>(...)` call names its `device`, which must be one of them, and the script holds the input lock of exactly those devices while it runs. The sandbox exposes only `tools`, `input` and `console`: no require, file system, network, process or timers. A tool error throws and the code can catch it; an action receipt with `sent=false` or an unknown outcome stops the script and returns the steps already run, as `batch_commands` does; cancellation and timeout also stop it and cancel the device call in progress. The result lists every tool call with its name, elapsed time and receipt. Default limits are 120 seconds and 60 tool calls, set with `timeout_seconds` and `max_tool_calls`. Use it for predictable multi-step work such as scrolling until something appears and then reading it; use a single tool for a one-step action, and return to the model when the next step needs visual judgement.

## Agent skills

[Unlock an iPhone](../agent/skills/iphone-unlock/SKILL.md) packages an authorized passcode workflow, a calibrated portrait keypad, and a native helper that keeps one connection open for the entire input sequence. Poki Agent loads this skill and exposes the host-side `unlock_device` tool when the user has configured a passcode locally. It requires Poki device ownership; it does not add an MCP tool. The skill documents the physical-device evidence and supported layout.

## Coordinates, Screenshots, and Recordings

- All coordinates and element frames use **logical screen points**.
- `take_screenshot` returns JPEG data. Passing `max_width` scales the returned image without changing logical interaction coordinates.
- `save_screenshot` writes a full-resolution PNG or JPEG based on the file extension.
- The `lossless` parameter does not alter either screenshot rule.
- On a simulator, the screen's rounded corners and Dynamic Island area are black in screenshots. Without this mask, that area differs between frames of a still screen, which would expire element refs.
- Default output directories:
  - Screenshots: `~/Pictures/Poki MCP`
  - Recordings: `~/Movies/Poki MCP`

## Element Inspection & Delivery Flags

- `list_elements` prefers Accessibility in `auto` mode and falls back to Vision OCR when Accessibility cannot be read. Every response reports which source was used. Some apps draw a list with their own renderer and publish only a header to Accessibility. When the named elements leave a third of the screen's height empty, `auto` mode adds the screenshot text that Accessibility did not name, after the Accessibility elements, each with `"source": "ocr"`. `source: "accessibility"` turns this off.
- Element `ref` identifiers are never reassigned within an MCP session. They expire after known input, a device change, a newly captured image showing a change, or **30 seconds**. Input and image changes observed by another session in the same daemon also invalidate the old observation. Re-fetch elements before acting on stale refs. Poki cannot detect an external touch or controller change until it observes that change; it does not continuously watch the display.
- In action responses, `sent=true` means the touch or key report was written to the connection. It does not mean the device acted on it. The device does not acknowledge reports, and a dropped report returns no error.
- A standalone action reads the screen back after it runs. `screen` lists the foreground app and visible text. When `screen_change_verified=true`, `screen_changed` indicates whether the accessibility output changed. This covers elements, text, values, positions, and selected, enabled, or focused states. `false` means no change was observed. It does not prove the action failed. The effect might not be exposed to accessibility, such as a canvas update, or might not have appeared yet. `true` does not prove the action caused the change, because another element may have updated at the same time. `screen_change_verified=false` means the before and after states could not be compared, such as in an app with no accessibility elements. In that case, inspect the screen directly.

## Device ownership and stopping work

Consecutive calls do not require a lease. For exclusive ownership across several calls, call `acquire_device` with an explicit device ID or unambiguous name. Acquisition resolves the device without booting it and returns `lease_id`, `device`, `state` and `expires_at`. A session may hold leases on several devices at once, one per device. Acquisition is serialized with ordinary operations; renewal, release and cancellation bypass that queue.

- `acquire_device({device, ttl_seconds?})`: default TTL 120 seconds, allowed integer range 1–600 seconds. Another session cannot acquire, observe or operate this device during the lease. Device names, ids, batch steps and existing simulator startup all pass through the same device check. New simulators are created one at a time.
- `renew_device({lease_id, ttl_seconds?})`: extend the matching lease of this session from the current time. Long operations do not renew automatically. Renew before expiry, including while a long tool is running.
- `release_device({lease_id})`: invalidate this session's accepted work on that lease's device, stop the recording and simulated location this session owns there, await cleanup, then make the device available. Work on the session's other devices carries on. A lease stays `releasing` until cleanup finishes. A lease that expires stops only its own device's work in the same way.
- `cancel_device({device?, lease_id?})`: stop previously accepted work in this MCP session, including queued calls made without a lease, and stop its background recording/location. With `device`, only that device's work stops. With `lease_id`, which must match an active lease of this session, only that lease's device's work stops; given together, both must name the same device. With neither, **all of the session's work** stops. Other sessions are unaffected. New work may be submitted after cleanup finishes; an old queued operation never resumes as an unleased operation.

The stop result identifies its scope, reason and cleanup outcomes. Cancellation stops owned local processes and waits; it cannot undo input already dispatched to the device. Inspect the screen before retrying an unknown outcome. The stdio bridge forwards SDK request cancellation to the corresponding daemon operation, including waits, device helpers and the local approval dialog. A normal HTTP response closing is not a session cancellation. Normal stdio EOF or termination requests session cleanup. The stdio process sends its pid, so the daemon drops the session of a process that died without closing it once that session has no work left; a crashed client holding an explicit lease is bounded by its TTL. A client without a lease has no persistent ownership guarantee after an abnormal exit; use an explicit lease for recordings and multi-call tasks.

`list_devices` still reports discovery and occupancy (`occupied`, `owned_by_session`, `state`, `expires_at`) without exposing another session's task. Occupied physical devices are not queried for additional name/model information by other sessions. If an alias has not been discovered, use the displayed device ID. An unleased recording or location must be stopped by its owner before a different session can acquire that device.

This arbitration exists only in **one shared Poki daemon**. Different daemon instances and different `POKI_MCP_STATE_DIR` values are independent. It does not lock out other control software or a person touching the screen. Clients with the same state directory share one daemon automatically; do not start multiple daemons against the same endpoint directory. No persistent task database or recovery across daemon restarts is provided.

## Observations, deadlines and receipts

`observe_device` returns structured elements and a prompt check, plus a PNG by default. `include_image:false` omits the PNG attachment but still captures a frame and checks OCR. For selected single actions, `return_observation:true` reuses the stable **post-input** AX tree with short-lived element refs and an AX-based prompt check; it does **not** add a screenshot or image OCR by default. Fast routes additionally request `post_action_ocr:true`, which captures an image **after** AX stabilization and performs OCR prompt checking. The sources remain non-atomic and their original timestamps are preserved. Each action-bound observation must pass receipt, device/revision, time, foreground, completeness and prompt checks; otherwise Agent and routes fall back to a new `list_elements`/`observe_device` call. AX-only refs are bound to the most recently measured viewport and expire after known input, explicit later capture, session/display changes or 30 seconds. The Agent sends the model **one trimmed element list**, not both the full nested receipt and a duplicate list; full evidence remains in the verification trace. No observed state or `sent:true` alone proves task success or permits retrying uncertain input. Existing tools and callers retain their default behavior.

`wait_for` uses a monotonic deadline covering capture, AX, OCR and polling. It starts no new read after that deadline, aborts in-flight external work and waits for owned processes to close. Consequently response delivery can include bounded process termination time after the deadline; the deadline is not a claim that the HTTP response arrives at the exact requested millisecond.

Input receipts retain `sent`, `text_verified`, `submit_sent` and other confirmed facts when recording recovery fails. The separate `recording` object reports recovery failure. Unconfirmed delivery remains `outcome: "unknown"`; it is never automatically replayed. Automatic recovery is suspended while native input intentionally interrupts the media stream. Normal reconnection after an explicit input is counted as `input_reconnects` and does not consume the automatic retry budget, so healthy multi-step recording is not limited to three inputs. Only background recovery from unexpected stream disconnects consumes `automatic_retries`, at most three per recording lifetime. Each reconnect still has a five-second first-frame deadline. `reconnects` is the total of these two counters. A failed reconnect leaves an explicit error; stop/start a recording to begin a new automatic budget. Stop, release, cancellation and session cleanup disable retries and await owned recording processes, and cleanup reports finalization errors separately.

Batch results retain the executed prefix and each step's `elapsed_ms`, then report `stop_reason`. `batch_commands` takes one required top-level `device`, and every step runs on it. A step that names `device` is rejected; send steps for another device in their own `batch_commands` call. With the default `stop_on_error` it is rejected before any step runs; with `stop_on_error=false` the steps before it run and that step fails. Inside a batch, `start_simulator` boots the batch's device and takes no `simulator` or `model`. Human handoff, cancellation, expiry, timeout and unknown input outcomes always stop subsequent steps even with `stop_on_error=false`. A successful action's receipt remains present if stopping occurs later. A detected human-only prompt in `handle_alert`, `take_screenshot`, `observe_device` or the screen read after the last step sets the same `needs_human_action` stop reason; observation tools retain their captured image and structure. With the default `stop_on_error`, every step is checked before any runs, so a mistyped step costs nothing. The last block carries `screen`, and after a stop also `failed_step`, `remaining_steps` and `next`, so the following call can fix one step and send only what is left.

Tool responses include `_meta.timing.stages` with queue, capture, AX, OCR, input, recording recovery and external-process durations where exercised. Each stage has an ID and parent ID. Parent durations include their children, so do not add parents and children. External-process time includes helper startup, connection and work inside the helper; those internal costs are not separately measured. Timing metadata contains no input text, device identifiers or image content, and it does not measure model reasoning or client round-trip time. No end-to-end speed multiplier is claimed.

## Efficient short workflows

- **Put the whole known task in one batch:** When the request already names what to do, send `launch_app` and every step in one `batch_commands` call. `launch_app` on a simulator returns once the interface is readable; `tap_text`, `fill` and `handle_alert` wait five seconds for their target to appear and hold still (a recognition already running on a screen accessibility cannot read may finish a few seconds later), so a batch can cross screens; the reply ends with the visible text, so a closing `take_screenshot` is only needed for pixels. Leave out a step when whether to do it depends on what an earlier step shows, or when it needs the user's decision. A wrong target stops the batch without tapping and reports the closest text on screen. Each step result reports `elapsed_ms`, which reflects server-side execution time only and excludes model reasoning and client round-trip overhead.
- **Use `fill` for known input fields:** Call `fill` directly instead of chaining `tap` and `type_text`; `field` can be left out when one text field is visible. On physical devices, `fill` focuses, replaces, and verifies text within a single native input session to avoid an extra connection wait. On simulators it taps, waits for focus and types, and a verified mismatch is an error. Plain text typed on a simulator first switches its keyboard to `en_US` (`simctl keyboard`), because a simulator created on a Chinese Mac types through Pinyin and rewrites Latin text and punctuation; the setting stays on that simulator. Because `fill` replaces existing field content, review your draft beforehand; reserve `type_text` for appending to an already-focused field.
- **Review and submit with `return`:** To inspect text before sending, `fill` and read the `screen` it returns. After verifying the draft, submit using `press_key` with `return` and inspect the resulting screen. Do not re-enter the full text or call `type_text` with an empty string to submit. Note that `text_verified` only confirms text entry into the field and `sent` only confirms the action was dispatched; neither guarantees application-level delivery.
- **Handle `CoreDeviceError` 4016 via observed UI:** If launching an app fails with `CoreDeviceError` 4016, inspect the current screen and continue through an observed Home Screen or App Switcher entry point. Do not repeatedly retry the same launch path unless device conditions change. This serves as invocation guidance and does not permanently mark the app as unavailable after a single failure.

## Approval & Clipboard Behavior

Eight tools are gated: `install_app`, `uninstall_app`, `build_and_run`, `open_url`, `download_app_container`, `get_clipboard`, `set_clipboard` and `unpair_device`. `POKI_MCP_APPROVAL_MODE` decides who approves them:

| Mode | Who approves |
| --- | --- |
| `ask` (alias `ask-human`) | Poki shows a dialog on its own machine (osascript on macOS, zenity on Linux) and waits. A declined or unanswered dialog runs nothing. |
| `host` | Poki shows no dialog. The MCP client decides, from the tool annotations and its own tool permissions. |
| `allow` | Nobody is asked. The operator accepted that. |

- **Default**: `host` on a Linux host whose environment has neither `DISPLAY` nor `WAYLAND_DISPLAY`, and `ask` everywhere else. An explicit value always wins. An unknown value is an error, and the daemon does not start.
- **The daemon's environment decides**, not the client's. A daemon started automatically takes `POKI_MCP_APPROVAL_MODE` (and the display variables) from the client that started it, and every other client shares that mode. A client that sets `POKI_MCP_APPROVAL_MODE` explicitly to a mode stricter than the running daemon's (`ask` over `host` over `allow`) has its device calls refused, with an error that names the daemon's pid; stop that daemon so the next call starts one with the client's mode. A client that asks for a looser mode runs under the daemon's. In both cases `poki_mcp_status` ends with a note naming both modes.
- **Annotations**: in every mode, `tools/list` marks the gated tools so that a client can ask before running them: `destructiveHint: true` on `install_app`, `uninstall_app`, `build_and_run`, `open_url`, `set_clipboard` and `unpair_device`; `openWorldHint: true` on `open_url`, `download_app_container`, `get_clipboard` and `set_clipboard`. `get_clipboard` carries `readOnlyHint: false`, so a client that runs read-only tools without asking still asks about it.
- **Inside `batch_commands` and `run_code`**: in `host` mode the client is asked only about the wrapper, so a gated tool is refused there, with an error that says to call it on its own. With the default `stop_on_error` such a batch is rejected before any step runs; with `stop_on_error=false` that step fails and the others run. In `ask` mode a gated step shows the dialog as a direct call does; in `allow` mode it runs.
- **Results**: a gated call reports who let it run, for example `"approval": {"mode": "host", "approved_by": "mcp-client"}` in host mode. `poki_mcp_status.approval_mode` reports `ask-human`, `host` or `operator-preapproved`, and `approval_covers` lists the gated tools.
- **`request_human_action`** is refused in `host` mode with an error that tells the model to ask the user in the conversation.
- `allow` and `host` **never** auto-complete iOS/macOS system authorization dialogs or make `request_human_action` succeed automatically.
- Approval covers only these tools. Taps, typing and other input inside apps, including a delete confirmed with a tap, are not gated.

> **Host mode relies on the client.** A client that runs tools without asking runs the gated tools unconfirmed. LobeHub's MCP tool permission defaults to `auto`. With Poki as a stdio MCP server on a Linux machine without a display, reached through LobeHub's `lh connect`, the mode is `host` by default, so these seven tools run with **no confirmation at all** unless you set them to require approval in the LobeHub connector's tool settings. To have Poki ask instead, run it where a dialog can appear and set `POKI_MCP_APPROVAL_MODE=ask`.

- **Unicode paste & clipboard restoration**:
  - Unicode text entry may use the device clipboard. On physical devices, Poki MCP attempts to save and restore a complete clipboard snapshot; if full restoration is not possible, the response explicitly reports restoration as unavailable.
  - The snapshot is held only in memory for the duration of that single operation and cannot be restored by a subsequent tool call after a human handoff.
  - If a paste prompt is pending or the target field cannot be verified, automatic submission stops and leaves the intended text on the clipboard.
  - Poki MCP **never** auto-accepts an iOS **Allow Paste** prompt. Note that a true first-time **Allow Paste** human-handoff flow remains unverified on hardware (prior successful paste checks did not trigger the system prompt).

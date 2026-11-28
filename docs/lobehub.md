# Use Poki from LobeHub

LobeHub runs Poki through a connected computer: `lh connect` on the Linux (or macOS) machine that can reach the iPhones starts Poki's stdio server there, and every LobeHub client — web, desktop, a phone's browser — talks to it through LobeHub. Poki needs no daemon set up in advance and no token: the stdio command starts the shared service on that machine (see [Install](install.md#1-build-from-source)).

## Connect

1. On the machine that runs Poki, build this checkout (`./bin/setup`), then run `lh connect` and follow its instructions until `lh connect status` reports the device connected.
2. In LobeHub, add a custom connector: **Add custom connector** → MCP type **STDIO**.
   - **Command:** `node`
   - **Arguments:** `/path/to/poki-mcp/src/stdio.mjs`
   - **MCP server env vars:** only when this installation uses a non-default state directory: `POKI_MCP_STATE_DIR=/absolute/path`. Daemon settings such as `POKI_MCP_APPROVAL_MODE` go here too: the service a connector starts runs with this environment.
3. **Bind the Poki connector to the device that runs Poki:** set **Run on device** to the computer from step 1. Do not leave it on **Auto**. LobeHub shows Poki's pairing view (below) for a connector that is not bound to a device only when it is your own personal connector running on your own personal device; a connector shared in a workspace must be bound to a device, or its views render as plain tool results.

`lh connect` keeps a pool of stdio processes and stops idle ones. That is expected: pairing jobs, leases and sessions live in Poki's shared service on that machine, not in the stdio process, so a pairing keeps running when its stdio process is recycled, and the next process sees it.

## MCP Apps views

Poki declares interactive views for some tools (MCP Apps, `ui://poki/...` resources). LobeHub renders them when the `mcp_apps` feature flag is on for the account or deployment (it is off by default; see LobeHub's feature flags). With the flag off, or in a client without MCP Apps, the same tools return readable text, for example `PIN: 482916. Type it on the iPhone in Settings › Privacy & Security › Developer Mode.`

| View | Opened by | Where it shows |
| --- | --- | --- |
| `ui://poki/pairing` | `pair_device` | Inline in the conversation (`lobehub/ui.preferredModelDisplayMode: "inline"`). On a phone's browser, inline is the only mode; the view is rebuilt when it scrolls back into view and picks up the running pairing from the service. |

The pairing view lists the iPhones paired over Wi-Fi, starts a pairing, shows the PIN and what to do on the iPhone, follows the job until the iPhone is ready, cancels it, and removes a pairing (after a second confirmation). It calls `list_devices`, `pair_device`, `pairing_status`, `pairing_cancel` and `unpair_device` through LobeHub; `pairing_cancel` is visible only to the view (`_meta.ui.visibility: ["app"]`), not to the model.

## Tool permissions

LobeHub's tool permission for an MCP connector defaults to **auto**: every Poki tool runs without asking. On a Linux machine without a display (no `DISPLAY` or `WAYLAND_DISPLAY`) Poki defaults to `POKI_MCP_APPROVAL_MODE=host` and shows no dialog of its own, so with LobeHub's default nothing asks before `install_app`, `uninstall_app`, `open_url`, `set_clipboard`, `get_clipboard`, `download_app_container` or `unpair_device` runs. Those tools carry `destructiveHint`/`openWorldHint` annotations; set them to require approval in the connector's tool permissions if you want LobeHub to ask. Taps, typing and other input inside apps are never gated.

## Verify

1. In a conversation with the connector enabled, ask the agent to list the iPhones. `list_devices` returns the devices and `pairing` (this computer's pairing name and jobs).
2. Ask it to pair a new iPhone. With `mcp_apps` on, the pairing view appears inline; follow it on the iPhone. Without it, the agent relays the instruction and the PIN from `pairing_status`.
3. After `ready`, the new device id works with every device tool.

What is verified: the view in a mock MCP Apps host (ext-apps `AppBridge`, sandboxed `srcdoc` iframe without same-origin, narrow width) and the tools through the stdio server, in automated tests. LobeHub Cloud end to end needs the `mcp_apps` flag enabled for the account after the LobeHub device-relay change (lobehub/lobehub#24039) is deployed.

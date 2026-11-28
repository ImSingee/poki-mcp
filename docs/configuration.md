# Configuration and sessions

Each (session, device) pair runs its calls in the order they were sent, and calls to different devices run at the same time; see [One daemon, several clients](tools.md#one-daemon-several-clients). Every setting below is optional.

The daemon reads its settings from its own environment. A daemon started automatically by a stdio client takes its settings from that client's environment (only the variables listed [below](#environment-of-a-daemon-a-client-starts)), so set daemon settings such as `POKI_MCP_APPROVAL_MODE` in the client's MCP `env`. The client that starts the daemon decides; other clients share it as it is. A daemon started with `npm start` or a user service uses the environment it was started with.


| Setting | Purpose |
| --- | --- |
| `POKI_MCP_STATE_DIR` | Override the state and endpoint directory. Clients with the same value share one daemon, and a daemon a client starts inherits the value. A daemon started with `npm start` needs the same value as its clients. |
| `POKI_MCP_SESSION` | Session identifier (`1–80` characters: letters, digits, `_`, or `-`). Simultaneously connected clients with the same identifier share a session and its leases and recordings, while distinct identifiers isolate them. The session closes as soon as any sharing client exits. Because of this, a shared value will not keep a recording or lease across separate `bin/call.mjs` runs, and reusing a running client's identifier in `bin/call.mjs` closes that client's session, with its work, recordings and leases, when the command exits. |
| `POKI_MCP_APPROVAL_MODE` | Who approves sensitive operations (listed under [Approval & Clipboard Behavior](tools.md#approval--clipboard-behavior)): `ask` (alias `ask-human`), a dialog on the Poki host; `host`, no dialog, and the MCP client decides; `allow`, nobody is asked. Defaults to `host` on a Linux host with neither `DISPLAY` nor `WAYLAND_DISPLAY`, otherwise `ask`. An unknown value stops the daemon from starting. In `host` mode a client that runs tools without asking, such as LobeHub with its default `auto` permission, runs these tools unconfirmed. |
| `POKI_MCP_TASK_APPROVAL=1` | Require per-task approval in the stdio client (`bin/poki-mcp`). It adds `begin_task` and `end_task`, and refuses every device tool except `list_devices` and `poki_mcp_status` until `begin_task` raises an MCP elicitation that the person accepts. One acceptance covers the task until `end_task`, an idle limit, or a total limit, whichever comes first. A client without elicitation support cannot start a task, so the gate fails closed. An answer that arrives after `end_task` or after a newer `begin_task` is ignored. This is separate from `POKI_MCP_APPROVAL_MODE`, which covers individual sensitive operations on the daemon. |
| `POKI_MCP_TASK_IDLE_MINUTES`, `POKI_MCP_TASK_MAX_MINUTES` | Idle and total limits of an approved task. Default to 10 and 60. |
| `POKI_MCP_TASK_APPROVAL_TIMEOUT_MINUTES` | How long `begin_task` waits for an answer. Defaults to 9. |
| `POKI_MCP_TASK_APPROVAL_CLIENT` | Name shown at the start of the approval prompt. Defaults to `An MCP client`. |
| `POKI_MCP_NATIVE_TRACE` | Enable native diagnostic timing output on `stderr`. |
| `POKI_BIND_HOST` | Addresses the local HTTP bridge listens on, comma-separated. Defaults to `127.0.0.1`; `127.0.0.1` is added to any list that has no `127.0.0.1` or wildcard entry, because local clients read a `127.0.0.1` endpoint from `mcp.json` and send that `Host` header. A wildcard address cannot be combined with others. |
| `POKI_HOST_ALLOW` | Comma-separated `Host` header allowlist, for example `127.0.0.1,192.168.1.20`. When set, `hostHeaderValidation(list)` replaces `localhostHostValidation()`, which otherwise rejects every non-loopback `Host` with `403` and makes a LAN bind unusable. It must contain `127.0.0.1` itself: an entry for `localhost` or `[::1]` does not match the `Host` header local clients send. |
| `POKI_MCP_TOKEN` | Fixed bearer token for the local HTTP bridge. Defaults to a random token generated at each start. Stdio clients read it from `mcp.json` themselves and never need it; direct HTTP clients must pick up the new one after each restart. A daemon a stdio client starts never takes it and makes its own; set it for `npm start` or a user service. |
| `POKI_MCP_AUTOSTART=0` | A stdio client only uses a daemon that already runs, and a call fails when none does, instead of starting one. For a client whose daemon runs elsewhere, such as the Telegram container in `deploy/istoreos`. |
| `POKI_MCP_HEARTBEAT_MS` | How often a stdio client tells the daemon it is still there (default `10000`, from `100` to `60000`). The daemon closes a session that misses three heartbeats and has no request open; time the daemon itself was stopped or blocked does not count. |
| `POKI_DAEMON_ENV` | Comma-separated names of further variables a daemon started by a stdio client receives (see below). Names of secrets (anything containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSCODE` or `CREDENTIAL`) and the client's own variables are never passed, with a note on stderr. |
| `POKI_DAEMON_IDLE_EXIT_MS` | How long a daemon started automatically by a stdio client waits while idle before it exits. Default 600000 (10 minutes). Idle means no session, no lease, no call in progress, and no background recording or simulated location. A session whose stdio process is gone is dropped first. A daemon started with `npm start` never exits on idle. |
| `POKI_TLS_CERT`, `POKI_TLS_KEY` | PEM certificate and key paths, set together. Listeners on addresses other than loopback then serve HTTPS; `127.0.0.1` stays plain HTTP, because local clients read a `http://127.0.0.1` endpoint from `mcp.json`. A wildcard `POKI_BIND_HOST` is refused with them, since it would also take `127.0.0.1`. |
| `POKI_ALLOW_PLAINTEXT_BIND=1` | Serve plain HTTP on addresses beyond loopback. Without TLS the daemon otherwise refuses them, because the bearer token would cross the network unencrypted. Set it only when that network is already encrypted end to end, such as a tailnet. |
| `IDEVICE_TOOLS` | Optional path override for the pinned upstream CLI. |
| `POKI_INPUT_LOCK_WAIT_MS` | How long a call waits for its device's input lock, held by another call to that device, before it fails and names the holder. Default 30000. |
| `POKI_MAX_CONCURRENT_READS` | How many read-only calls run at once. Default 4. |
| `POKI_MCP_CALL_LOG` | Path of a log with one JSON line per tool call: tool, duration, verdict and whether it failed, never arguments, text or images. |

The authenticated local HTTP bridge passes the session via the `x-poki-mcp-session` header. Standard MCP clients should always connect through `src/stdio.mjs`, which finds or starts the daemon, sends the session header, and sends a heartbeat so that the daemon can drop the session if the process dies without closing it. Process ids are not used for this, so a client and a daemon in different PID namespaces share the state directory safely. A direct HTTP client sends no heartbeat; its session is dropped once it holds nothing and has been idle for `POKI_DAEMON_IDLE_EXIT_MS`.

### Environment of a daemon a client starts

A daemon started by a stdio client outlives that client and serves every other client of the state directory, so it receives only what it and the host tools it runs need:

- the `POKI_` settings the daemon reads (those in the table above, except the client's own: `POKI_MCP_TOKEN`, `POKI_MCP_SESSION`, `POKI_MCP_AUTOSTART`, `POKI_MCP_HEARTBEAT_MS` and `POKI_DAEMON_ENV`);
- `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR` (`TMP`, `TEMP`), `LANG`, `LANGUAGE`, `LC_*`, `TZ` and `XDG_*`;
- for dialogs, Xcode, usbmuxd, certificates and proxies: `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `DEVELOPER_DIR`, `USBMUXD_SOCKET_ADDRESS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (either case), and `IDEVICE_TOOLS`;
- `TESSDATA_PREFIX`, and the `POKI_OCR_LANGS`, `POKI_OCR_PSM`, `POKI_OCR_UPSCALE` and `POKI_TYPE_KEY_MS` settings that its native helpers read;
- the names listed in `POKI_DAEMON_ENV`, except secrets and the client's own variables.

Everything else in the client's environment stays with the client, notably `POKI_IPHONE_PASSCODE`, model API keys and other secrets: neither the daemon nor the helpers and builds it runs see them. A daemon started with `npm start` or a user service keeps the whole environment it was started with.

On loopback the token file is a local convenience rather than a remote access mechanism: nothing off the machine can reach the bridge. That changes as soon as `POKI_BIND_HOST` points at something else, because the bearer token then becomes the only thing between the network and full control of the device. Give it to a LAN or tailnet you trust, keep it in a mode-0600 file rather than a command line, and expect `403` from every client whose `Host` header is not in `POKI_HOST_ALLOW`.

`poki_mcp_status` reports the version from the root `package.json`, the current short Git `commit` (`unknown` outside Git), and `native_build`, the bridge file’s UTC modification time (`unknown` when absent). A daemon startup warning reports Rust source or Cargo metadata newer than the bridge. It does not block startup or rebuild anything.

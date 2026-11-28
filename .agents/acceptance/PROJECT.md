# PROJECT.md — acceptance adapter for Poki MCP

## 1. Project summary

Poki MCP is a Node.js MCP daemon (`src/daemon.mjs`) plus a stdio bridge (`src/stdio.mjs`) that lets MCP clients operate a physical iPhone, with a Rust device bridge in `native/bridge/` and a standalone terminal agent in `agent/`. User-facing UI is MCP Apps views under `src/views/` (for example `src/views/pairing.html`, served as `ui://poki/pairing`). There is no web app or dev server.

## 2. Environment

- **Start the view host (mock MCP Apps host):** `node test/support/view-host.mjs --stub --port <free port>` from the repo root. It prints `{"event":"ready","url":...}`. It runs a real Poki stdio server and daemon from a temp copy of the worktree, with a stand-in `poki-native` (`test/support/pairing-native.mjs`) and one pre-paired iPhone "Lab iPhone".
- **Screen panel:** add `--view screen` (`node test/support/view-host.mjs --stub --view screen --port <free port>`). The header button becomes "Agent calls show_screen"; the view is `ui://poki/screen` in fullscreen mode (container height 900). The stand-in Lab iPhone sends the sample stream (180×390 colour bars, 8 frames looped at 10 fps, a key frame every 4) over `media_subscribe`; every input the view sends and `media_subscribe` / `media_unsubscribed` (the phone's camera and microphone held / released) land in `commands.jsonl` in the temp copy (`root` in the ready line). `POKI_SCREEN_RTC=0` in the view host's environment keeps the panel on tool calls; otherwise it uses WebRTC to the local daemon.
- **Stop:** SIGTERM the process; it removes its temp copy and stub helpers.
- **Required services:** none.
- **Already-running detection:** pick a free port; do not reuse a port another run holds.
- **Env / port resolution:** the `--port` flag.

## 3. Auth

None. No accounts, no login. No real iPhone is needed for the view host.

## 4. Surfaces

### Web

- Launch: view host above; base URL is the printed `url`.
- Driver: headless agent-browser or Playwright (installed in `node_modules`), not the Claude desktop Browser pane (hidden, throttles timers).
- agent-browser session name: `poki-pairing-<run-id>`.
- Header buttons: "Agent calls pair_device", "Remount view", "Unmount view", "iPhone accepts the PIN", Width select (360/520/760), Theme select. A log under the view lists every call the view makes.
- Text-only client view: `curl -s -X POST localhost:<port>/call -H 'Content-Type: application/json' -d '{"name":"pairing_status","arguments":{"job":"..."}}'`.
- Call log with millisecond timestamps, source (agent, view, direct) and returned job state: `curl -s localhost:<port>/calls`. Use it, not the page log (second precision), as evidence for polling and "no call was made" claims.
- Stand-in script: `pairing.json` in the temp copy (`root` in the ready line). `remote.installDelayMs` (default 4000) keeps the "Preparing developer services" step visible; `remote.hangInstall` keeps the helper busy forever; an `{"await": "<file>"}` step pauses until that file exists next to `fixture.json`.

## 5. Project probes & quick navigation

None beyond the host's own buttons and `/call` endpoint.

## 6. Known constraints

- Real iPhone pairing, real DDI install over the RemotePairing tunnel, a real iPhone's screen video, and LobeHub's own MCP Apps rendering are not exercised; the stand-in plays the phone. Disclose this in every report.
- Unit/Playwright/cargo tests are not acceptance checks.

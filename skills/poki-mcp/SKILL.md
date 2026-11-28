---
name: poki-mcp
description: Operate an iPhone and troubleshoot Poki errors with Poki MCP. Read before the first Poki call that types text, answers a prompt, or uses hardware buttons, and whenever Poki reports an error or stops responding.
license: AGPL-3.0-only
---

# Poki MCP

## Tool discovery

The default `tools/list` contains the tools for device discovery, screen reads, app launch, touch, text input, navigation, prompts, and batches. For tools outside that list, read `docs/tools.md` in the Poki checkout used by your registered MCP server. This skill can be copied into a client skill directory.

Set `POKI_MCP_TOOLS=all` in the MCP client's process environment and reconnect to list the complete catalog. Tools absent from the default list still accept direct calls. Device actions can run inside `batch_commands`; lease management calls must stay outside a batch. Consecutive calls do not require `acquire_device`. Poki Agent selects the complete catalog for its own MCP process and retains its own tool allowlist.

## Name the device on every call

Call `list_devices` once and pass one of its ids as `device` on every device tool call; an exact device name also works. When exactly one device is listed, its `default` field names it. There is no selected device to fall back on. `batch_commands` takes one top-level `device`, and its steps name none. `run_code` takes `devices`, and each `tools.<name>(...)` call in the script names one of them as `device`. `start_simulator` returns the new simulator's id; use it as `device` afterwards. Calls to different devices may run at the same time; calls to one device run in the order sent.

To pair a new iPhone over Wi-Fi (iOS 27+, same network, no USB), call `pair_device`, then `pairing_status` with its `job` about every two seconds. Tell the person what its `instruction` says, and the `pin` while one is shown; stop when `terminal` is true. On `failed`, relay `action`. When `list_devices` reports `display_service: false` for a wireless device, call `pair_device` with that `device` to reinstall its developer disk image. `unpair_device` removes a wireless pairing; call it only when asked.

When the person wants to watch or operate the iPhone themselves, call `show_screen` with its `device`: clients with MCP Apps open a live screen panel where they tap, swipe and type. Leave the device to them while they work there; if they take it over, your calls on it are refused (the error says a person took it over) until they close the panel or it stays hidden. Ask the person before you try the device again. Never call the `screen_*` tools yourself, even if your client lists them: they are for the panel, and taking the iPhone over is the person's decision. The panel keeps the iPhone's camera and microphone busy while it is shown, so do not leave it open for no reason; a panel nobody uses for 20 minutes, while you make no call on the iPhone either, pauses itself.

## Approval

`poki_mcp_status.approval_mode` says who approves `install_app`, `uninstall_app`, `build_and_run`, `open_url`, `download_app_container`, `get_clipboard`, `set_clipboard` and `unpair_device`. With `ask-human`, Poki shows a dialog on its host and waits. With `host`, Poki shows no dialog: your client decides, and a client that runs tools without asking runs them unconfirmed. In `host` mode call these tools on their own, because `batch_commands` and `run_code` refuse them there, and `request_human_action` is refused, so ask the user in the conversation instead. Run these tools only when the user's task calls for them.

## Code that decides each step

`run_code` is in the complete catalog, not the default list. It runs an async JavaScript function that calls device tools with `await tools.<name>(args)`, so the code reads a result and decides the next step in one call instead of a model round trip per step. Prefer it when a task is predictable but depends on what each step returns, such as scrolling until a row appears and then reading its value. A tool error throws and the code can catch it; an action that reports `sent=false` or an unknown outcome stops the script, as a batch stops. The sandbox has no require, file system, network, process or timers.

The examples below record earlier physical-iPhone checks. They are not a guarantee for every iOS version or app. Verify the current screen after each task.

## Send known text in one batch

When the text is already decided, send the steps that open the field and the `fill` in one `batch_commands` call, with `submit: true` on the `fill` when Return sends. `fill` reads the text back from that field before it sends Return, and a failed `fill` stops a batch with the default `stop_on_error: true`, so no look at the draft is needed in between. Keep them apart when the user asked to review the draft.

Basis: tapping `Add Row` then `fill` with `submit: true` in one batch, in a list of text fields: only the new row changed and Return followed the read-back, 3 of 3. A search typed into Chrome's address bar the same way reached the results, 1 of 1.

## When `fill` refuses

`fill` types nothing unless it can confirm the field being edited is the one you aimed at. A field-confirmation error says nothing was typed or sent. The default batch stops there. Read `screen` in the reply, aim again, and retry only the unfinished steps. A `batch_commands` failure returns `remaining_steps` for that batch.

Basis: a tap that gave the edit to the next row, 3 of 3; a list that kept moving, 3 of 3; coordinates with no field under them while another row was being edited, 1 of 1. Every row kept its text and Return was not sent.

## Paste permission

`fill` answers the system paste prompt itself: it taps Allow Paste, reads the text back, then sends Return. The receipt says `paste_permission_answered: true`, and no `handle_alert` call is needed.

Basis: Chrome's address bar, 1 of 1.

## Other prompts

Use `handle_alert` with `action: "accept"`, then read `screen` to confirm the prompt closed. A `button` label that is not there returns `Nothing was tapped` and leaves the prompt up.

Basis: a test alert, both paths, 1 of 1.

## Go to the Home screen

On a physical iPhone, use `press_button` with `button: "home"`. `press_key` with `key: "home"` sends a keyboard Home key and does not navigate to the iPhone Home screen. Read the screen after the button event to confirm navigation.

## Optional iPhone unlock

Poki Agent's host-integrated `unlock_device` is separate from the MCP tool catalog. Only the user may choose and configure `POKI_IPHONE_PASSCODE` in a private local launcher environment. Ask "Do you want Poki Agent to unlock this iPhone when it is locked?" and stop for that decision. Default to no configuration. Anyone or any program with access to this Mac may be able to read the passcode. If the user agrees, give them the hidden-input zsh commands in `agent/README.md` to run themselves. Never ask for the passcode in chat. Never read or write their passcode for them. The host passes it to the helper over stdin, outside model inputs and logs.

The verified hardware case is only iPhone17,1 in portrait orientation with a six-digit passcode and a 402-by-874-point keypad. Read `agent/skills/iphone-unlock/SKILL.md` in the Poki checkout before use. Setup builds `build/native-target/release/examples/unlock_iphone`. Confirm the current keypad layout and inspect the resulting screen. Without configuration, ask the user to unlock manually.

## Handle prompts

Read the visible prompt and its reported kind. Use `handle_alert` with a button label or `action: "accept"` / `"dismiss"` to choose a visible button. For a purchase prompt, generic `action: "accept"` leaves the prompt open and returns its kind and available buttons. After the action, read the screen to confirm the dialog closed and the task reached its intended state.

For login or verification, use the credentials available for the authorized task. Read a requested SMS verification code from Messages or notifications, enter it, and verify the resulting screen. Confirm a purchase only when the user's task explicitly requests that purchase. In that case, set `button` to the visible purchase button text. Otherwise dismiss the prompt or continue the task without purchasing.

## When something goes wrong

When Poki reports an error or stops responding, read [references/troubleshooting.md](references/troubleshooting.md) (or `skills/poki-mcp/references/troubleshooting.md` in the Poki checkout if this skill was copied alone). That reference covers diagnostic tool calls, failure classification, exact error strings, and secret redaction.

- Run read-only diagnostic tools first to inspect versions and device state before retrying actions or changing service state.
- Never enter passcodes, passwords, or verification codes on the user's behalf during setup or troubleshooting.
- Strip personal data and secrets from every report draft and show the full draft to the user before sharing it.

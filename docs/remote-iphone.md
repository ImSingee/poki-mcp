# Remote iPhone over LAN or Tailscale

RemotePairing lets Poki use a paired iPhone through a LAN Bonjour name, a LAN address, or a Tailscale address. It uses an encrypted userspace tunnel and does not change the host's default route, DNS, proxy, or other VPN settings. This is an opt-in transport; the existing USB path remains available for devices without a remote configuration. On iOS 27 and newer, the first RemotePairing pairing can also be created wirelessly; older iOS versions still need the USB bootstrap.

**Experimental cross-network support:** the host and iPhone no longer need to remain on the same LAN. The verified route initializes a session on Wi-Fi, then keeps it while the iPhone uses cellular data.

For LAN-only use, see [LAN addresses that change with DHCP](#lan-addresses-that-change-with-dhcp). Use either preparation below with the phone's advertised `.local` host as `HOST`; Tailscale installation and the cellular switch are only for cross-network use.

## Prepare

1. Run `./bin/setup` in this checkout. If the remote route uses Tailscale, install the Tailscale app on the iPhone and host, and connect both devices to the same tailnet.
2. Enable Developer Mode and UI Automation on the iPhone.
3. Pair the device in one of two ways:

   **Wireless first pairing from an MCP client (iOS 27+).** Ask the agent to pair the iPhone, or call `pair_device` and follow `pairing_status` (or the pairing view in an MCP Apps client such as LobeHub). Poki advertises this computer, shows the PIN to type on the iPhone, saves the pairing, and installs the developer disk image over the new tunnel, all without USB. See [Pair iPhones over Wi-Fi](tools.md#pair-iphones-over-wi-fi). The saved host is the address that paired; to keep a `.local` name or a Tailscale address instead, use the command below.

   **Wireless first pairing from a terminal (iOS 27+).** Keep the host and iPhone on the same local network with mDNS/Bonjour reachable. Set `POKI_MCP_STATE_DIR` to this installation's private state directory, then run:

   ```sh
   node bin/prepare-remote.mjs --wireless [HOST] [--port PORT] [--name HOST_NAME]
   ```

   The computer advertises itself as a pairable host. On the iPhone, open Settings › Privacy & Security › Developer Mode, tap **Pair with HOST_NAME**, and enter the six-digit code printed by the command. `HOST_NAME` defaults to the computer hostname. When `HOST` is omitted, Poki saves the LAN address that paired. That address can change with DHCP, so on a LAN prefer the phone's advertised `.local` name as `HOST` (see [LAN addresses that change with DHCP](#lan-addresses-that-change-with-dhcp)); pass the iPhone's Tailscale address as `HOST` when the long-term route should use Tailscale. `PORT` is the iPhone's RemotePairing service port and defaults to `49152`.

   The wireless pairing itself is LAN/mDNS-only. It does not cross Tailscale directly; pair on the LAN first, then use the Tailscale address in the saved configuration.

   **USB bootstrap (all supported iOS versions).** Connect the trusted, unlocked iPhone over USB and Wi-Fi, then run:

   ```sh
   node bin/prepare-remote.mjs DEVICE_ID IP_OR_BONJOUR_HOST [PORT]
   ```

   This verifies a RemotePairing record over the existing trusted USB connection.

   In every mode the pairing key remains in the private state directory. Ordinary operations never trigger a new pairing flow.

   **Developer disk image.** Touch and text input need displayservice, which the developer disk image (DDI) provides. `pair_device` installs it through cryptexd over the RemotePairing tunnel; after an iPhone restart, call `pair_device` with `device` set to its id to install it again. Over the tunnel the computer needs internet access for Apple's personalization (`gs.apple.com`). When the iPhone refuses the installation over the tunnel, connect USB once and run `node bin/prepare-device.mjs DEVICE_ID`.
4. Use Poki with the same state directory. Call `take_screenshot` with this device's ID as `device` while Wi-Fi is connected. Confirm the actual screen before disconnecting USB or leaving the LAN.
5. For a cellular/Tailscale route, disconnect Wi-Fi from Control Center, leaving the Wi-Fi setting enabled, Tailscale connected, and the phone unlocked. Verify the phone is using cellular data.

The configured device uses RemotePairing even when a USB connection is present, so testing does not silently fall back to USB.

## Operations and recovery

### LAN addresses that change with DHCP

For a host and iPhone on the same LAN, opt into Bonjour resolution by supplying
the phone's actual `.local` host name instead of a numeric address during setup,
in either pairing mode:

```sh
node bin/prepare-remote.mjs DEVICE_ID My-iPhone.local
node bin/prepare-remote.mjs --wireless My-iPhone.local
```

Use the host advertised by that phone, not its display name or an assumed
`iPhone.local` name. On macOS, `dns-sd -B _remotepairing._tcp local.` can browse
advertised instances; `dns-sd -L 'INSTANCE' _remotepairing._tcp local.` reports an
instance's host and port. Stop these browsing commands with Ctrl-C. Supply the
advertised port as the optional third argument if it differs from `49152`.
Advertisements identify candidates only: the saved pairing record and device ID
are still checked when connecting.

Setup saves the host name rather than resolving it once to an IP. A new control
connection resolves that name through the system resolver, including after a
dead tunnel is discarded. This uses the existing adapter/RSD health checks;
changing DNS answers alone never invalidates an established tunnel.
No helper restart or new USB pairing is needed for subsequent address changes.
Reads or inputs known not to have been sent can
recover through the existing bounded retry; uncertain inputs are never replayed.
An explicit `reconnect_device` also creates a fresh control connection to resolve
the Bonjour name again. A working tunnel remains usable if that replacement fails.

Existing numeric-IP configurations remain unchanged. To opt in, rerun setup
with the name while the trusted phone is connected over USB, after calling
`disconnect_device` with that device's ID to end its old helper. Existing valid
pairing records are reused. The name must still be advertised and reachable:
this does not discover renamed hosts, follow changed service ports, scan all
phones automatically, or make Bonjour work across different networks. Keep an
explicit Tailscale address for cross-network operation.

### When remote pairing is unreachable

`Remote pairing is unreachable` means the helper could not open a TCP connection
to the configured host and port. It fails before any pairing check or tunnel
handshake. The message lists each address the host resolved to, its interface
for IPv6 link-local addresses, and the error macOS returned for it:

- `Connection refused`: the address answered, but nothing accepted the port.
  Check the advertised port with `dns-sd -L`.
- `No route to host` or `did not resolve` for a LAN address or `.local` name
  can mean that the Mac sent the connection through an interface that cannot
  reach the phone, or that macOS Local Network privacy blocked the helper. macOS 15 and later grant
  local network access automatically only to programs started from Terminal or
  over SSH and the programs they start. When another app starts Poki, such as an
  editor's terminal or a desktop AI client, that app needs
  **System Settings > Privacy & Security > Local Network**. See
  [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
  Tailscale addresses use a VPN interface, which this privacy check does not cover.

The remote helper outlives the daemon, and macOS keeps attributing it to the app
that started it. To move Poki to a different app, call `disconnect_device` first,
then restart the daemon from that app.

### Shared transport behavior

Supported paths are screenshots, accessibility observations, app listing and launch, touches and gestures, keyboard events, and verified text input through Poki's existing clipboard/field verification flow. Clipboard restoration is reported separately; an unavailable snapshot means the prior clipboard cannot be restored.

The native connection helper is independent of MCP clients and the Poki daemon. Closing a client or restarting the daemon preserves an idle phone connection. The private local socket is under `/tmp/poki-remote-<uid>`; it exposes no network listener. Pairing keys remain in the state directory; ephemeral tunnel keys are not saved.

`reconnect_device` attempts a replacement tunnel before dropping a working one. It never repeats a previous input. If an operation loses its response, inspect the screen before retrying. `disconnect_device` explicitly closes the helper and phone connection. Cancelling an observation abandons only that request. The helper finishes the read and discards its response. Cancelling an input drops the in-flight operation without replaying it or closing the shared tunnel. Some input may already have reached the phone; inspect the screen before retrying. The helper processes one request at a time, so later operations cannot overtake a draining read.

Ordinary service errors and observation deadlines preserve a live tunnel. The helper clears a connection after its underlying adapter has stopped. After a socket error it also opens the tunnel's RSD port, and clears the connection when that fails too, because a phone that drops off Wi-Fi without a reset leaves the adapter running. If that happens before an input is written, the helper builds one replacement tunnel within the same request and tries again. A cancelled read can occupy the helper until its native deadline, so the next request may wait. Native connection setup has a 25-second limit and execution has a 90-second limit; the JavaScript request budget is 120 seconds.

When Bonjour (`.local` or `.local.`, case-insensitive) mode discards a dead tunnel, it also clears the cached control connection so the replacement resolves the name again. Numeric IP and other hostnames (including Tailscale MagicDNS) keep their existing control-reuse behavior.

On iOS, Tailscale cannot run alongside another ordinary VPN. Users who need that other VPN to reach their AI client must resolve the internet-access requirement too. A suitable Tailscale exit node is a possible topology, but it has not been validated in this experiment. See [Tailscale's VPN compatibility documentation](https://tailscale.com/docs/reference/faq/other-vpns).

Mac MCP's `get_clipboard` reads text and reports clipboard types over the existing RemotePairing tunnel, subject to the normal [operator approval](tools.md#approval--clipboard-behavior).

Device-management paths such as app installation, process termination, Settings deep links, recording, location simulation, and standalone clipboard writes are not supported by this transport. They report a transport limitation instead of silently using a local connection.

## Remove a pairing, or return to USB or local Wi-Fi

Call `unpair_device` with the iPhone's id as `device`. It stops that device's work in every session, closes its RemotePairing helper, and deletes its `remote-devices.json` entry and its `remote/DEVICE_ID/` directory (configuration and pairing record). The device leaves `list_devices` at once; no restart is needed. Connect the phone over USB or local Wi-Fi to use it that way, or pair it again with `pair_device`. Merely plugging in USB does not override a remote entry, so remove the entry first. The iPhone keeps its own record of this computer until you remove it there; the reply's `phone_cleanup` says how.

To keep the pairing files for later instead, call `disconnect_device`, remove only that device's entry from `remote-devices.json` (in the daemon's `POKI_MCP_STATE_DIR`, or the default `~/Library/Application Support/PokiMCP` when it is unset), and keep `remote/DEVICE_ID/`.

If the first connection reports that the saved pairing record did not verify, rename `remote/DEVICE_ID/pairing.plist` within the same private state directory, then run `bin/prepare-remote.mjs` again to create a new record. Use the wireless mode on iOS 27+ or the USB mode on older systems. Do not share the old or new pairing file.

## Verification status

See [LAN Bonjour recovery checks](verification/lan-bonjour-recovery.md) for the address-change experiments and their limits.

The initial transport checks used an iPhone17,1 running iOS 27.3 on 2026-11-06, before the cancellation fix:

- Wi-Fi initialization followed by cellular operation, with USB disconnected.
- Restarting the Poki daemon on 5G while retaining the native helper, then launching Settings and entering `poki123 AbC 中文24680` with exact accessibility readback and a matching screenshot.
- Continuing to read and clear the field after an explicit reconnect failed, demonstrating that the old working tunnel survived the failed replacement attempt.
- Returning an error without a cached image when Tailscale was disconnected.

Clipboard restoration was unavailable for the final mixed-text check and was reported as such. One accessibility-tree request took 46.8 seconds; this run is not a performance or long-duration stability acceptance. Continuous video/recording is outside the implemented remote transport.

The [cancellation repair checks](verification/tailscale-pr-validation.md#cancellation-repair-verification) separately verify timeout recovery, missing-element failure, and late screenshot cleanup on a real phone using Wi-Fi.

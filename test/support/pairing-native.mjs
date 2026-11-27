// A stand-in for build/poki-native in both modes the pairing flow starts, for tests and for the
// view harness (test/harness/view-host.mjs). Its behavior comes from pairing.json next to
// FIXTURE_STATE; every helper start and request is logged to FIXTURE_LOG.
// --pair-host: plays `pairHost`, waiting at each `await` step until that file exists next to
//   FIXTURE_STATE; on SIGTERM prints a cancelled event and exits 1, as pair_host.rs does.
// --remote-server: answers device_info, ddi_status, install_ddi and disconnect from `remote`.
export const pairingNative = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
const log = event => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(event) + '\\n');
const config = () => JSON.parse(readFileSync(join(dirname(process.env.FIXTURE_STATE), 'pairing.json'), 'utf8'));
const mode = process.argv[2];
log({ helper: mode, args: process.argv.slice(3), pid: process.pid });
if (mode === '--pair-host') {
  const [, , , hostState, output, name] = process.argv;
  process.on('SIGTERM', () => { log({ helper: 'pair-host-sigterm', pid: process.pid }); console.log(JSON.stringify({ event: 'cancelled' })); process.exit(1); });
  for (const step of config().pairHost) {
    if (step.await) { const gate = join(dirname(process.env.FIXTURE_STATE), step.await); while (!existsSync(gate)) await new Promise(r => setTimeout(r, 20)); rmSync(gate, { force: true }); continue; }
    if (step.fail) { console.error(step.fail); process.exit(1); }
    if (step.event === 'paired') writeFileSync(output, 'pairing record for ' + name);
    console.log(JSON.stringify(step));
  }
  process.exit(0);
}
if (mode === '--remote-server') {
  let installed = false;
  const server = createServer(socket => {
    socket.write(JSON.stringify({ pid: process.pid }) + '\\n');
    createInterface({ input: socket }).once('line', line => {
      const request = JSON.parse(line);
      log({ remote: request.op, request });
      const remote = config().remote ?? {};
      const reply = request.op === 'disconnect' ? { disconnected: true }
        : request.op === 'device_info' ? { properties: { DeviceName: config().names?.[JSON.parse(readFileSync(process.argv[3], 'utf8')).id] ?? 'Wireless iPhone', ProductType: 'iPhone17,1', ProductVersion: '27.0' } }
        : request.op === 'ddi_status' ? { display_service: installed || Boolean(remote.displayService), cryptexd: true, ddi: installed ? { identifier: 'com.apple.MobileAsset.DDI', version: '27B52' } : null }
        : request.op === 'install_ddi' ? (remote.install ?? (installed = true, { installed: true, display_service: true, ddi: { identifier: 'com.apple.MobileAsset.DDI', version: '27B52' } }))
        : { transport_error: true, error: 'Unexpected native request ' + request.op };
      socket.end(JSON.stringify(reply) + '\\n');
      if (request.op === 'disconnect') server.close(() => process.exit(0));
    });
  });
  server.listen(process.argv[4], () => console.log(JSON.stringify({ ready: true })));
} else if (mode !== '--pair-host') process.exit(1);
`;

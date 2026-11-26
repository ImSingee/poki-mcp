import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { root } from '../src/config.mjs';

const exec = promisify(execFile);

async function wirelessFixture(t, events) {
  const dir = await mkdtemp(join(tmpdir(), 'poki-wireless-pairing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  const native = join(dir, 'poki-native');
  await mkdir(stateDir);
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[4], 'wireless pairing secret fixture');
for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
`, { mode: 0o755 });
  return { dir, stateDir, native };
}

test('wireless pairing registers the paired iPhone without USB', async t => {
  const { stateDir, native } = await wirelessFixture(t, [
    { event: 'advertising', port: 53124 },
    { event: 'pin', pin: '123456' },
    { event: 'paired', device: { udid: 'phone-27', name: 'Bryan iPhone', model: 'iPhone17,1' }, peer: '192.0.2.10' },
  ]);
  const result = await exec(process.execPath, [join(root, 'bin/prepare-remote.mjs'), '--wireless', '198.51.100.20'], {
    env: { ...process.env, POKI_MCP_STATE_DIR: stateDir, POKI_NATIVE: native },
  });
  assert.match(result.stdout, /123456/);
  const directory = join(stateDir, 'remote', 'phone-27');
  assert.equal((await stat(join(directory, 'pairing.plist'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')), {
    id: 'phone-27',
    host: '198.51.100.20',
    port: 49152,
    pairing_file: join(directory, 'pairing.plist'),
  });
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'remote-devices.json'), 'utf8')), [
    { id: 'phone-27', name: 'Bryan iPhone', config_path: join(directory, 'config.json') },
  ]);
});

test('wireless pairing defaults the remote address to the pairing peer', async t => {
  const { stateDir, native } = await wirelessFixture(t, [
    { event: 'paired', device: { udid: 'phone-27', name: 'Bryan iPhone', model: 'iPhone17,1' }, peer: '192.0.2.10' },
  ]);
  await exec(process.execPath, [join(root, 'bin/prepare-remote.mjs'), '--wireless'], {
    env: { ...process.env, POKI_MCP_STATE_DIR: stateDir, POKI_NATIVE: native },
  });
  assert.equal(JSON.parse(await readFile(join(stateDir, 'remote/phone-27/config.json'), 'utf8')).host, '192.0.2.10');
});

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

test('wireless pairing persists a Bonjour host instead of the DHCP address that paired', async t => {
  const { stateDir, native } = await wirelessFixture(t, [
    { event: 'paired', device: { udid: 'phone-27', name: 'Bryan iPhone', model: 'iPhone17,1' }, peer: '192.0.2.10' },
  ]);
  for (const host of ['Bryan-iPhone.local', 'Bryan-iPhone.local.']) {
    const result = await exec(process.execPath, [join(root, 'bin/prepare-remote.mjs'), '--wireless', host], {
      env: { ...process.env, POKI_MCP_STATE_DIR: stateDir, POKI_NATIVE: native },
    });
    assert.equal(JSON.parse(await readFile(join(stateDir, 'remote/phone-27/config.json'), 'utf8')).host, host);
    assert.match(JSON.parse(result.stdout.trim().split('\n').at(-1)).next, /same LAN/);
  }
});

test('wireless pairing rejects an unusable host before advertising', async t => {
  const { dir, stateDir } = await wirelessFixture(t, []);
  const marker = join(dir, 'started');
  const native = join(dir, 'marking-native');
  await writeFile(native, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'started');
`, { mode: 0o755 });
  for (const host of ['example.com', 'phone', '-phone.local', 'phone.local:1234']) {
    await assert.rejects(exec(process.execPath, [join(root, 'bin/prepare-remote.mjs'), '--wireless', host], {
      env: { ...process.env, POKI_MCP_STATE_DIR: stateDir, POKI_NATIVE: native },
    }), error => /Usage:/.test(error.stderr), host);
  }
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

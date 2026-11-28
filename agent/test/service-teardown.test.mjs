import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { taskServices } from './fixtures/task-services.mjs';
import { PokiClient } from '../poki-client.mjs';

// A test's phone service stands in for the daemon. Closing it while Poki Agent's client is still
// connected must not make the stdio shim start a real daemon in its place: only a tool call does that.
test('closing the phone service while a client stays connected starts no service', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'poki-service-teardown-'));
  const state = join(directory, 'mcp');
  // A daemon this test fails to prevent must not run real device discovery.
  process.env.POKI_MCP_STATE_DIR = state; process.env.POKI_NO_UPDATE_CHECK = '1'; process.env.IDEVICE_TOOLS = process.execPath;
  const services = await taskServices(state);
  const client = new PokiClient();
  t.after(async () => {
    await client.close();
    // Any daemon the shim started anyway is stopped, so a failing run leaves nothing behind.
    for (const line of (await readFile(join(state, 'daemon.log'), 'utf8').catch(() => '')).split('\n')) {
      try { const event = JSON.parse(line); if (event.event === 'ready') process.kill(event.pid, 'SIGKILL'); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  });
  await client.open('teardown');
  assert.ok(!(await client.call('poki_mcp_status')).isError);
  await services.close();
  await sleep(8000);
  const log = await readFile(join(state, 'daemon.log'), 'utf8').catch(() => '');
  assert.equal(log, '', 'no daemon was started');
  assert.equal(JSON.parse(await readFile(join(state, 'mcp.json'), 'utf8')).pid, process.pid, 'mcp.json still names only the test service');
});

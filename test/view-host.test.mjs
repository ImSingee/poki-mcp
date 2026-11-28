import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { root } from '../src/config.mjs';

const running = path => { try { return execFileSync('pgrep', ['-f', path], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };

// test/support/view-host.mjs --stub runs Poki from a temporary copy: its stdio server starts an
// automatic service, which starts detached RemotePairing stand-ins. Stopping the host stops them all.
test('the view host leaves no service or helper running after it stops', { timeout: 60000 }, async () => {
  const host = spawn(process.execPath, [join(root, 'test/support/view-host.mjs'), '--stub', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: host.stdout });
  const ready = JSON.parse((await once(lines, 'line'))[0]);
  assert.equal(ready.event, 'ready');
  const call = (name, args = {}) => fetch(new URL('/call', ready.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) }).then(r => r.json());
  // list_devices starts the automatic service, and it starts the pre-paired phone's helper.
  const listed = await call('list_devices');
  assert.ok(listed.structuredContent.devices.some(d => d.id === 'lab-iphone'), JSON.stringify(listed));
  assert.ok(running(ready.root).length >= 2, 'a service and a helper run from the stub copy');
  const exited = once(host, 'exit');
  host.kill('SIGTERM');
  const stopped = JSON.parse((await once(lines, 'line'))[0]);
  const [code] = await exited;
  assert.deepEqual(stopped, { event: 'stopped', leftovers: [] });
  assert.equal(code, 0);
  assert.deepEqual(running(ready.root), []);
});

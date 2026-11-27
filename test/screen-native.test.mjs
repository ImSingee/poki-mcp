// The daemon's side of media_subscribe (src/remote.mjs) against a helper that greets and then
// never confirms the subscription.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { nativeSubscribe } from '../src/remote.mjs';

const until = async (predicate, ms = 3000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('the stalled socket stayed open'); await new Promise(r => setTimeout(r, 10)); } };

// A RemotePairing helper's socket: the path the daemon derives from the device's config path.
async function stalledHelper(t) {
  const target = { id: 'stalled-phone', remote: `/nonexistent/${randomUUID()}/config.json` };
  const directory = `/tmp/poki-remote-${process.getuid()}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = join(directory, createHash('sha256').update(target.remote).digest('hex').slice(0, 24) + '.sock');
  const sockets = new Set();
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.resume(); socket.write(JSON.stringify({ pid: process.pid }) + '\n'); });
  server.listen(path);
  await once(server, 'listening');
  t.after(async () => { server.close(); await unlink(path).catch(() => {}); });
  return { target, sockets };
}

test('a helper that never confirms the subscription times out, and its socket is closed', async t => {
  const { target, sockets } = await stalledHelper(t);
  const started = performance.now();
  await assert.rejects(nativeSubscribe(target, () => {}, { timeoutMs: 300 }), /did not start in time/);
  assert.ok(performance.now() - started < 2000);
  await until(() => sockets.size === 0);
});

test('a cancelled screen_open ends a pending subscription at once', async t => {
  const { target, sockets } = await stalledHelper(t);
  const controller = new AbortController();
  const pending = nativeSubscribe(target, () => {}, { signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('Request cancelled', 'AbortError')), 100);
  await assert.rejects(pending, /cancelled/);
  await until(() => sockets.size === 0);
});

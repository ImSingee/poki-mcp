import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { fileURLToPath } from 'node:url';

const daemon = fileURLToPath(new URL('../src/daemon.mjs', import.meta.url));
const token = 'a'.repeat(64);

// Starts the daemon with the given environment and resolves to its ready line, or to the error it
// exited with.
async function start(t, env) {
  const dir = await mkdtemp(join(tmpdir(), 'poki-bind-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [daemon, '--port', '0'], { env: { ...process.env, POKI_NO_UPDATE_CHECK: '1', POKI_MCP_STATE_DIR: join(dir, 'state'), POKI_MCP_TOKEN: token, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const ready = new Promise(resolve => child.stdout.on('data', () => { const line = out.split('\n').find(l => l.includes('"event":"ready"')); if (line) resolve({ ready: JSON.parse(line), dir }); }));
  const exited = once(child, 'exit').then(([code]) => ({ code, error: err }));
  return Promise.race([ready, exited]);
}

const lanAddress = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;

test('a listener beyond loopback without TLS is refused, with the way to fix it', async t => {
  const result = await start(t, { POKI_BIND_HOST: '0.0.0.0', POKI_HOST_ALLOW: '127.0.0.1,192.0.2.1' });
  assert.notEqual(result.code, 0);
  assert.match(result.error, /plain HTTP/);
  assert.match(result.error, /POKI_TLS_CERT/);
  assert.match(result.error, /POKI_ALLOW_PLAINTEXT_BIND=1/);
});

test('POKI_ALLOW_PLAINTEXT_BIND=1 serves plain HTTP beyond loopback on an already encrypted network', async t => {
  const result = await start(t, { POKI_BIND_HOST: '0.0.0.0', POKI_HOST_ALLOW: '127.0.0.1,192.0.2.1', POKI_ALLOW_PLAINTEXT_BIND: '1' });
  assert.ok(result.ready, result.error);
});

test('a certificate and key are required together', async t => {
  const result = await start(t, { POKI_TLS_CERT: '/nonexistent.pem' });
  assert.notEqual(result.code, 0);
  assert.match(result.error, /POKI_TLS_CERT and POKI_TLS_KEY must be set together/);
});

test('with a certificate, addresses beyond loopback serve HTTPS and 127.0.0.1 stays plain HTTP', { skip: !lanAddress && 'this host has no non-loopback IPv4 address' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'poki-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=poki-test', '-addext', `subjectAltName=IP:${lanAddress}`], { stdio: 'ignore' });
  const result = await start(t, { POKI_BIND_HOST: lanAddress, POKI_HOST_ALLOW: `127.0.0.1,${lanAddress}`, POKI_TLS_CERT: cert, POKI_TLS_KEY: key });
  assert.ok(result.ready, result.error);
  const port = result.ready.url.match(/:(\d+)\//)[1];
  assert.match(result.ready.url, /^http:\/\/127\.0\.0\.1:/, 'local clients keep their plain loopback endpoint');
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: lanAddress, port, path: '/mcp', method: 'POST', ca: [execFileSync('cat', [cert])], headers: { Host: `${lanAddress}:${port}`, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(status, 401, 'the HTTPS listener answers, and still requires the bearer token');
  const endpoint = JSON.parse(await readFile(join(result.dir, 'state/mcp.json'), 'utf8'));
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:/);
});

test('a wildcard address cannot carry TLS, because it would take over the plain loopback listener', async t => {
  const result = await start(t, { POKI_BIND_HOST: '0.0.0.0', POKI_HOST_ALLOW: '127.0.0.1', POKI_TLS_CERT: '/a.pem', POKI_TLS_KEY: '/b.pem' });
  assert.notEqual(result.code, 0);
  assert.match(result.error, /wildcard/);
});

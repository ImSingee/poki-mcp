import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync, readdirSync } from 'node:fs';
import { lines } from '../src/lines.mjs';

// readline re-emits its input's errors, and an unhandled one ends the process: a native helper that
// died mid-request (ECONNRESET on its socket) took the daemon down with every client's session.
test('a line reader whose input fails does not end the process', async () => {
  const input = new PassThrough();
  input.on('error', () => {});
  const reader = lines(input);
  const seen = [];
  reader.on('line', line => seen.push(line));
  input.write('{"pid":2}\n');
  await new Promise(resolve => setImmediate(resolve));
  input.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(seen, ['{"pid":2}'], 'lines before the failure still arrive, and the process is still here');
});

test('the daemon reads lines only through the guarded reader', () => {
  const dir = new URL('../src/', import.meta.url);
  const bare = readdirSync(dir).filter(name => name.endsWith('.mjs') && name !== 'lines.mjs')
    .filter(name => /\bcreateInterface\s*\(/.test(readFileSync(new URL(name, dir), 'utf8')));
  assert.deepEqual(bare, [], 'use lines() from src/lines.mjs instead of readline.createInterface');
});

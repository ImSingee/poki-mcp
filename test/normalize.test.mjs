import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { normalizeCode } from '../src/normalize.mjs';

// The worker evaluates `(${code})`, so a normalized arrow function must be an expression: a statement
// terminator left on it is a syntax error there.
const run = code => vm.runInNewContext(`(${normalizeCode(code)})`)();

test('an arrow function ending in a semicolon normalizes to the arrow expression alone', async () => {
  for (const code of ['async () => { return 42; };', 'async () => 42;', '  async () => { return 42; } ;  ', '() => 42;']) {
    assert.equal(await run(code), 42, code);
  }
  assert.equal(await run('async () => { return 42; }'), 42);
});

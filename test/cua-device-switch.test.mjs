import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';

const text = result => result.content.find(item => item.type === 'text')?.text ?? '';

test('CUA element numbers belong to the device they were read on', { timeout: 35000 }, async t => {
  const f = await fixture(t, { toolsProfile: 'cua' });
  await f.set({ twoPhones: true, label: 'Ready' });
  const onA = await f.call('look', { device: 'fixture-phone' });
  assert.match(text(onA), /1 (?:Button|StaticText) "Ready"/);
  // iPhone B has not been read in this session, so A's numbers mean nothing there.
  const result = await f.call('do', { device: 'fixture-phone-2', actions: [{ tap: 1 }] });
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /element 1 is not in the latest read; nothing was sent/i);
  assert.equal((await f.events()).filter(e => e.op === 'tap').length, 0, 'no tap is dispatched with another device’s coordinates');
  const fresh = await f.call('look', { device: 'fixture-phone-2' });
  assert.match(text(fresh), /1 (?:Button|StaticText) "Ready"/);
  const onB = await f.call('do', { device: 'fixture-phone-2', actions: [{ tap: 1 }] });
  assert.match(text(onB), /did: tap 1 \(sent,/);
  // Reading B left A's own read alone.
  const backOnA = await f.call('do', { device: 'fixture-phone', actions: [{ tap: 1 }] });
  assert.match(text(backOnA), /did: tap 1 \(sent,/);
  assert.deepEqual((await f.events()).filter(e => e.op === 'tap').map(e => e.device), ['fixture-phone-2', 'fixture-phone']);
});

test('look and do need device', { timeout: 35000 }, async t => {
  const f = await fixture(t, { toolsProfile: 'cua' });
  for (const [name, args] of [['look', {}], ['do', { actions: [] }]]) {
    const result = await f.a.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(text(result), /device/);
  }
});

// The native helper serves one request at a time, so a screenshot waits behind a slow accessibility
// read. look gives that read its own budget, which the helper enforces, instead of only racing it.
test('look gives the accessibility read its time budget, which the native helper enforces', { timeout: 35000 }, async t => {
  const f = await fixture(t, { toolsProfile: 'cua', extraEnv: () => ({ POKI_CUA_TREE_MS: '1200' }) });
  await f.set({ label: 'Ready' });
  await f.call('look');
  const reads = (await f.events()).filter(e => e.op === 'ax_tree').map(e => e.request);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(request => request.wait_ms === 1200), JSON.stringify(reads));
});

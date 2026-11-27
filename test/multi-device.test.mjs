import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, value } from './fixture.mjs';
import { approvalMode } from '../src/human.mjs';
import { Session } from '../src/device.mjs';

const A = 'fixture-phone', B = 'fixture-phone-2';
const text = result => result.content.map(block => block.text ?? '').join('\n');

test('with two phones nothing picks one: list_devices names no default and a call without device is refused', { timeout: 30000 }, async t => {
  // POKI_MCP_DEVICE used to pick a device; it is gone and changes nothing.
  const f = await fixture(t, { extraEnv: () => ({ POKI_MCP_DEVICE: B }) });
  await f.set({ twoPhones: true, label: 'Ready' });
  const listed = value(await f.call('list_devices'));
  assert.deepEqual(listed.devices.map(device => device.id).sort(), [A, B]);
  assert.equal(listed.default, undefined);
  for (const [name, args] of [['launch_app', { bundle_id: 'local.fixture' }], ['batch_commands', { commands: [{ tool: 'launch_app', arguments: { bundle_id: 'local.fixture' } }] }]]) {
    const result = await f.a.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(text(result), /device/);
  }
  assert.equal((await f.events()).filter(event => event.op === 'launch_app').length, 0, 'nothing launches without a named device');
  const named = await f.call('launch_app', { device: B, bundle_id: 'local.fixture' });
  assert.notEqual(named.isError, true, text(named));
  assert.deepEqual((await f.events()).filter(event => event.op === 'launch_app').map(event => event.device), [B]);
});

test('one session taps two phones at the same time, and two taps on one phone keep their order', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.set({ twoPhones: true, label: 'Ready', tapDelayMs: 1000 });
  const tap = (device, x) => f.call('tap', { device, x, y: 10, verify: false });
  // Warm both phones' screen sizes so the taps below wait only for each other.
  await Promise.all([f.call('get_device_info', { device: A }), f.call('get_device_info', { device: B })]);
  const results = await Promise.all([tap(A, 10), tap(B, 10), tap(A, 20)]);
  for (const result of results) assert.notEqual(result.isError, true, text(result));
  const events = await f.events();
  const spans = events.filter(event => event.op === 'tap_start').map(start => ({ ...start, end: events.find(end => end.op === 'tap_end' && end.device === start.device && end.at >= start.at).at }));
  const onA = spans.filter(span => span.device === A), onB = spans.filter(span => span.device === B);
  assert.equal(onA.length, 2); assert.equal(onB.length, 1);
  assert.ok(onA[0].at < onB[0].end && onB[0].at < onA[0].end, `A and B overlap: ${JSON.stringify(spans)}`);
  assert.ok(onA[1].at >= onA[0].end, `A's second tap starts after its first ends: ${JSON.stringify(onA)}`);
  assert.ok(onA[0].x < onA[1].x, 'the tap sent first runs first');
});

test('a session holds leases on two phones; releasing one leaves the other and its work alone', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.set({ twoPhones: true, label: 'Ready' });
  const other = await f.connect();
  const leaseA = value(await f.call('acquire_device', { device: A, ttl_seconds: 60 }));
  const leaseB = value(await f.call('acquire_device', { device: B, ttl_seconds: 60 }));
  assert.ok(leaseA.lease_id && leaseB.lease_id && leaseA.lease_id !== leaseB.lease_id);
  assert.match(text(await f.call('acquire_device', { device: A })), /already holds a lease on fixture-phone/);
  for (const device of [A, B]) assert.match(text(await other.call('acquire_device', { device })), /occupied/, device);
  // Work in progress on B while A's lease is released.
  const onB = f.call('wait', { device: B, seconds: 1.5 });
  await sleep(200);
  const released = value(await f.call('release_device', { lease_id: leaseA.lease_id }));
  assert.equal(released.device, A);
  assert.equal(released.cancelled_operations, 0);
  assert.notEqual((await onB).isError, true, 'work on B carries on');
  assert.ok(value(await other.call('acquire_device', { device: A, ttl_seconds: 60 })).lease_id, 'A is free for another session');
  assert.ok(value(await f.call('renew_device', { lease_id: leaseB.lease_id, ttl_seconds: 60 })).lease_id, 'B is still held');
  assert.match(text(await other.call('tap', { device: B, x: 10, y: 10 })), /occupied/);
});

test('expiry of one lease does not stop the session\'s work on its other device', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.set({ twoPhones: true, label: 'Ready' });
  // B first, so A's short lease starts its clock right before the calls that outlast it.
  assert.ok(value(await f.call('acquire_device', { device: B, ttl_seconds: 60 })).lease_id);
  assert.ok(value(await f.call('acquire_device', { device: A, ttl_seconds: 3 })).lease_id);
  const [onA, onB] = await Promise.all([f.call('wait', { device: A, seconds: 20 }), f.call('wait', { device: B, seconds: 5 })]);
  assert.equal(onA._meta.stop_reason, 'expired');
  assert.notEqual(onB.isError, true, text(onB));
  assert.equal(value(onB).waited, 5);
});

test('cancel_device with a device stops only that device\'s work', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.set({ twoPhones: true, label: 'Ready' });
  const onA = f.call('wait', { device: A, seconds: 20 }), onB = f.call('wait', { device: B, seconds: 1.5 });
  await sleep(300);
  const cancelled = value(await f.call('cancel_device', { device: A }));
  assert.deepEqual(cancelled.devices, [A]);
  assert.equal((await onA)._meta.stop_reason, 'cancelled');
  assert.notEqual((await onB).isError, true);
});

test('the approval mode follows POKI_MCP_APPROVAL_MODE, else the display', () => {
  assert.equal(approvalMode({}, 'linux'), 'host');
  assert.equal(approvalMode({ DISPLAY: ':0' }, 'linux'), 'ask');
  assert.equal(approvalMode({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), 'ask');
  assert.equal(approvalMode({}, 'darwin'), 'ask');
  assert.equal(approvalMode({ POKI_MCP_APPROVAL_MODE: 'ask' }, 'linux'), 'ask', 'an explicit mode beats the display check');
  assert.equal(approvalMode({ POKI_MCP_APPROVAL_MODE: 'host', DISPLAY: ':0' }, 'linux'), 'host');
  assert.equal(approvalMode({ POKI_MCP_APPROVAL_MODE: 'allow' }, 'darwin'), 'allow');
  assert.throws(() => approvalMode({ POKI_MCP_APPROVAL_MODE: 'hosts' }, 'linux'), /not one of ask, host or allow/);
});

const gated = ['install_app', 'uninstall_app', 'open_url', 'get_clipboard', 'set_clipboard', 'download_app_container', 'build_and_run'];

async function checkHost(f) {
  await f.set({ simulatorOnly: true, simulatorBooted: true });
  const { tools } = await (await f.connect('all')).listTools();
  for (const name of gated) {
    const annotations = tools.find(tool => tool.name === name).annotations;
    assert.ok(annotations.destructiveHint === true || annotations.openWorldHint === true, `${name}: ${JSON.stringify(annotations)}`);
  }
  assert.equal(tools.find(tool => tool.name === 'tap').annotations.destructiveHint, undefined);
  assert.equal(value(await f.call('poki_mcp_status')).approval_mode, 'host');
  const opened = await f.call('open_url', { url: 'https://example.com' });
  assert.notEqual(opened.isError, true, text(opened));
  assert.deepEqual(value(opened).approval, { mode: 'host', approved_by: 'mcp-client' });
  const asked = await f.call('request_human_action', { reason: 'Unlock the phone' });
  assert.equal(asked.isError, true);
  assert.match(text(asked), /host approval mode/);
  assert.equal(tools.find(tool => tool.name === 'get_clipboard').annotations.readOnlyHint, false, 'a client that auto-runs read-only tools still asks about the clipboard');
  // The client approves the tool it is asked about. Inside batch_commands or run_code it would only be
  // asked about the wrapper, so a gated tool does not run there.
  const opens = async () => (await f.events()).filter(event => event.args?.includes('openurl')).length;
  const before = await opens();
  const batch = await f.call('batch_commands', { commands: [{ tool: 'tap', arguments: { x: 5, y: 5 } }, { tool: 'open_url', arguments: { url: 'https://example.org' } }] });
  assert.equal(batch.isError, true);
  assert.match(text(batch), /host approval mode/);
  assert.match(text(batch), /Nothing ran/);
  const through = await f.call('batch_commands', { stop_on_error: false, commands: [{ tool: 'open_url', arguments: { url: 'https://example.org' } }, { tool: 'set_clipboard', arguments: { text: 'x' } }] });
  assert.equal(through.isError, true);
  assert.match(text(through), /call open_url on its own/);
  const script = await f.call('run_code', { code: `try { await tools.open_url({ device: ${JSON.stringify(f.device)}, url: 'https://example.org' }); return 'opened'; } catch (error) { return String(error.message ?? error); }` });
  assert.doesNotMatch(text(script), /"result": "opened"/);
  assert.match(text(script), /host approval mode/);
  assert.equal(await opens(), before, 'no URL was opened inside a batch or a script');
  assert.equal((await f.events()).filter(event => event.dialog).length, 0, 'no dialog process starts');
}

test('outside host mode a gated batch step still asks with the dialog', { timeout: 40000 }, async t => {
  const f = await fixture(t, { approvalMode: 'ask' });
  await f.set({ simulatorOnly: true, simulatorBooted: true });
  const pending = f.call('batch_commands', { commands: [{ tool: 'open_url', arguments: { url: 'https://example.com' } }] });
  await f.until(log => log.includes('"dialog":true'));
  assert.ok(value(await f.call('cancel_device')).stopped);
  assert.equal((await pending).isError, true);
});

test('in host mode Poki shows no dialog: gated tools carry annotations and run, and request_human_action is refused', { timeout: 40000 }, async t => {
  await checkHost(await fixture(t, { approvalMode: 'host', extraEnv: () => ({ DISPLAY: ':0' }) }));
});

test('a Linux host without a display uses host mode by default and starts no zenity', { timeout: 40000, skip: process.platform !== 'linux' && 'the display check applies to Linux' }, async t => {
  await checkHost(await fixture(t, { approvalMode: null, extraEnv: () => ({ DISPLAY: '', WAYLAND_DISPLAY: '' }) }));
});

test('with a display the dialog still asks, and the annotations are there too', { timeout: 40000 }, async t => {
  const f = await fixture(t, { approvalMode: null, extraEnv: () => ({ DISPLAY: ':0' }) });
  const { tools } = await (await f.connect('all')).listTools();
  assert.equal(tools.find(tool => tool.name === 'open_url').annotations.openWorldHint, true);
  await f.set({ simulatorOnly: true, simulatorBooted: true });
  const pending = f.call('open_url', { url: 'https://example.com' });
  await f.until(log => log.includes('"dialog":true'));
  assert.ok(value(await f.call('cancel_device')).stopped);
  assert.equal((await pending).isError, true);
});

// A shim numbers its calls; the daemon places them on their queues in that order. A call that takes no
// queue place (lease management) or was cancelled before it arrived is placed at once, and must not let
// a later call pass an earlier one that is still on its way.
test('a call placed after a gap does not let later calls past the gap', async () => {
  const session = new Session();
  const order = seq => ({ stream: 'shim', seq });
  let third = false;
  const waiting = session.inOrder(order(3)).then(() => { third = true; });
  session.placed(order(2));
  await sleep(50);
  assert.equal(third, false, 'call 3 waits for call 1');
  session.placed(order(1));
  await waiting;
  assert.equal(third, true);
  // A call that never arrives is skipped after the wait.
  const started = performance.now();
  await session.inOrder(order(5));
  assert.ok(performance.now() - started >= 400);
});

test('stopping one device\'s work leaves the background work a script started on another device', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.set({ twoPhones: true, label: 'Ready' });
  const script = f.call('run_code', { devices: [A, B], code: `await tools.start_recording({ device: ${JSON.stringify(B)} }); await tools.wait({ device: ${JSON.stringify(A)}, seconds: 20 }); return 'done';` });
  await f.until(log => log.includes('screencapture'));
  await sleep(300);
  const cancelled = value(await f.call('cancel_device', { device: A }));
  assert.deepEqual(cancelled.devices, [A]);
  await script;
  const stopped = await f.call('stop_recording', { device: B });
  assert.notEqual(stopped.isError, true, `B still records: ${text(stopped)}`);
});

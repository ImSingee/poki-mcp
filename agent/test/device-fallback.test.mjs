import './fixtures/in-process-device-tool.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { taskServices } from './fixtures/task-services.mjs';
import { PhoneTask } from '../task-runner.mjs';

// Every device tool names its device. A task given none uses the sole device list_devices names as
// its default, and with several (or none) it fails before any phone action.
async function run(t, devices) {
  const directory = await mkdtemp(join(tmpdir(), 'poki-device-fallback-'));
  const services = await taskServices(join(directory, 'mcp'), { route: true, devices, execution: [
    ['report_plan', { title: 'Read the fixture', steps: ['Read it'], currentStep: 1 }],
    ['list_elements', {}],
    ['finish_task', { success: true, summary: 'Fixture ready.', details: [{ label: 'Status', value: 'Fixture ready.' }],
      answer: { kind: 'field', items: [{ ref: 'e1', field: 'label' }] } }],
  ] });
  const before = { ...process.env };
  Object.assign(process.env, { POKI_MCP_STATE_DIR: join(directory, 'mcp'), OPENAI_BASE_URL: services.modelURL,
    OPENAI_API_KEY: 'sk-local-channel-fixture', POKI_AGENT_AUTH: 'api-key' });
  const task = new PhoneTask('Read the fixture', undefined, { stateDirectory: join(directory, 'state'), auth: 'api-key', model: 'gpt-5.4', stepTimeout: 10 });
  t.after(async () => {
    await task.close(); await services.close();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await rm(directory, { recursive: true, force: true });
  });
  const closed = once(task, 'closed');
  void task.start();
  await closed;
  return { task, services };
}

test('a task that names no device uses the only connected one', { timeout: 30000 }, async t => {
  const { services } = await run(t, [{ id: 'only-phone', kind: 'physical' }]);
  const onDevice = services.deviceCalls.filter(call => !['list_devices', 'poki_mcp_status'].includes(call.name));
  assert.ok(onDevice.length > 0);
  for (const call of onDevice) assert.equal(call.args.device, 'only-phone', `${call.name} names the sole device`);
});

test('a task that names no device fails before any phone action when several are connected', { timeout: 30000 }, async t => {
  const { task, services } = await run(t, [{ id: 'phone-a', kind: 'physical' }, { id: 'phone-b', kind: 'physical' }]);
  assert.equal(task.snapshot.phase, 'failed');
  assert.match(task.snapshot.result, /Several devices/);
  assert.deepEqual(services.deviceCalls.map(call => call.name).filter(name => name !== 'poki_mcp_status'), ['list_devices']);
});

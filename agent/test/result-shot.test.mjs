import './fixtures/in-process-device-tool.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { taskServices } from './fixtures/task-services.mjs';
import { PhoneTask } from '../task-runner.mjs';

// The result screenshot goes out with the final reply (Telegram photos). One taken before a later
// tap shows a screen the phone has left, so an input clears it, and a text-only read after the
// input leaves the result without a picture rather than with a stale one.
test('a screenshot taken before the last input is not the result screenshot', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'poki-result-shot-'));
  const services = await taskServices(join(directory, 'mcp'), { route: true, screenshots: true, execution: [
    ['report_plan', { title: 'Open the fixture', steps: ['Open it'], currentStep: 1 }],
    ['observe_device', {}],
    ['tap', { x: 10, y: 10 }],
    ['list_elements', {}],
    ['finish_task', { success: true, summary: 'Fixture ready.', details: [{ label: 'Status', value: 'Fixture ready.' }],
      answer: { kind: 'field', items: [{ ref: 'e1', field: 'label' }] } }],
  ] });
  const before = { ...process.env };
  Object.assign(process.env, { POKI_MCP_STATE_DIR: join(directory, 'mcp'), OPENAI_BASE_URL: services.modelURL,
    OPENAI_API_KEY: 'sk-local-channel-fixture', POKI_AGENT_AUTH: 'api-key' });
  const task = new PhoneTask('Open the fixture', 'synthetic-device', { stateDirectory: join(directory, 'state'), auth: 'api-key', model: 'gpt-5.4', stepTimeout: 10 });
  t.after(async () => {
    await task.close(); await services.close();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await rm(directory, { recursive: true, force: true });
  });
  const closed = once(task, 'closed');
  void task.start();
  await closed;
  const calls = services.deviceCalls.map(call => call.name);
  assert.ok(calls.includes('observe_device') && calls.includes('tap'), JSON.stringify(calls));
  assert.ok(task.shots.size > 0, 'the observation before the tap did carry a screenshot');
  assert.equal(task.snapshot.resultShot, null, 'the pre-tap screenshot is not offered as the result');
});

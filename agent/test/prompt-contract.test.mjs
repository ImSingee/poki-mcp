import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = rel => readFileSync(resolve(root, rel), 'utf8');
const words = text => text.trim().split(/\s+/).filter(Boolean).length;

test('Agent prompts preserve personal-assistant voice, device execution, verification, and safety contracts', () => {
  assert.equal(existsSync(resolve(root, 'agent/prompts/system.md')), false, 'Unused duplicate system.md stays removed');

  const piApp = read('agent/prompts/pi-app.md');
  const callDraft = read('agent/prompts/call-draft.md');
  const taskRunner = read('agent/task-runner.mjs');
  const combined = `${piApp}\n${callDraft}`;

  const firstParagraph = piApp.trim().split(/\n\s*\n/)[0];
  assert.match(firstParagraph, /personal assistant/i);
  assert.match(firstParagraph, /operate their iPhone directly/i);
  assert.match(taskRunner, /\[\s*await readFile\(new URL\('\.\/prompts\/pi-app\.md'/);

  assert.match(piApp, /latest message/i);
  assert.match(piApp, /report_plan/);
  assert.match(piApp, /currentStep/);
  assert.match(piApp, /unlock_device/);
  assert.match(piApp, /password manager/i);
  assert.match(piApp, /approval/i);
  assert.match(piApp, /Stop on the checkout or payment page/);
  assert.match(combined, /handle_alert/);
  assert.match(combined, /Messages or notifications/);
  assert.match(combined, /purchase/);
  assert.match(combined, /text_verified/);
  assert.match(combined, /Return/);
  assert.match(combined, /scrolling down|scroll down/i);
  assert.match(combined, /no longer changes|stops changing/i);
  assert.match(combined, /finish_task\(success=true\)/);
  assert.match(combined, /finish_task\(success=false\)/);
  assert.match(callDraft, /bundle_id/);
  assert.match(callDraft, /failed_step/);
  assert.match(callDraft, /remaining_steps/);

  assert.ok(words(piApp) + words(callDraft) < 618, `Agent prompts grew to ${words(piApp) + words(callDraft)} words`);

  for (const text of [piApp, callDraft]) {
    assert.doesNotMatch(text, /[—–]/);
    assert.doesNotMatch(text, /ESP-\d+/i);
    assert.doesNotMatch(text, /\p{Script=Han}/u);
  }
});

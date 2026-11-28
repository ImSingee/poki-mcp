// The screen panel end to end without an iPhone: the view host (test/support/view-host.mjs --stub
// --view screen) runs Poki's stdio server and daemon from a copy of this checkout, with a
// stand-in poki-native whose paired iPhone sends the sample stream over media_subscribe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from '../src/config.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}

async function viewHost(t) {
  const child = spawn(process.execPath, [join(root, 'test/support/view-host.mjs'), '--stub', '--view', 'screen', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [line] = await once(createInterface({ input: child.stdout }), 'line');
  const ready = JSON.parse(line);
  t.after(async () => { child.kill('SIGTERM'); await once(child, 'exit'); });
  const call = async (name, args) => (await fetch(`${ready.url}call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })).json();
  const commands = async () => (await readFile(join(ready.root, 'commands.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { ...ready, call, commands };
}
const until = async (predicate, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) { let value; try { value = await predicate(); } catch {} if (value) return value; if (Date.now() > deadline) throw new Error('Timed out'); await delay(100); }
};

test('show_screen, a stream, a tap and its end reach the phone through the daemon and its helper', { timeout: 60000 }, async t => {
  const host = await viewHost(t);
  const shown = await host.call('show_screen', { device: 'lab-iphone' });
  assert.equal(shown.structuredContent.device, 'lab-iphone');
  const opened = (await host.call('screen_open', { device: 'lab-iphone', codecs: ['hevc'] })).structuredContent;
  assert.equal(opened.codec, 'hevc');
  const frames = [];
  let ack;
  while (frames.length < 5) {
    const reply = (await host.call('screen_read', { stream: opened.stream, ack, wait_ms: 1000 })).structuredContent;
    if (!reply.frames.length) continue;
    assert.equal(reply.codec_string, 'hvc1.1.6.L60.90');
    // Frames follow on without a gap, except where the daemon starts again at a key frame (a slow
    // read missed a chain the phone replaced meanwhile): the reply then says so.
    const previous = frames.at(-1)?.seq;
    if (previous !== undefined && reply.frames[0].seq !== previous + 1) assert.ok(reply.discontinuity && reply.frames[0].key, `a gap after ${previous} without a discontinuity at a key frame: ${JSON.stringify(reply.frames.map(f => [f.seq, f.key]))}`);
    for (const [index, frame] of reply.frames.entries()) if (index) assert.equal(frame.seq, reply.frames[index - 1].seq + 1, 'a gap inside one batch');
    frames.push(...reply.frames);
    ack = frames.at(-1).seq;
  }
  assert.equal(frames[0].key, true, 'the stream did not start at a key frame');
  assert.equal((await host.call('screen_input', { stream: opened.stream, kind: 'tap', x: 0.25, y: 0.75 })).structuredContent.sent, true);
  await until(async () => (await host.commands()).some(c => c.remote === 'tap' && c.request.x === 16384 && c.request.y === 49151));
  await host.call('screen_close', { stream: opened.stream });
  // The last stream of the phone ended: the helper's subscription closes, releasing camera and microphone.
  await until(async () => (await host.commands()).some(c => c.remote === 'media_unsubscribed'));
});

test("a confirmed takeover through the daemon stops the agent's batch and keeps the agent off the phone", { timeout: 60000 }, async t => {
  const host = await viewHost(t);
  const opened = (await host.call('screen_open', { device: 'lab-iphone', codecs: ['hevc'] })).structuredContent;
  const started = Date.now();
  const batch = host.call('batch_commands', { device: 'lab-iphone', commands: [{ tool: 'wait', arguments: { seconds: 15 } }] });
  await delay(500);
  // The agent holds the input lock: the view's gesture comes back busy, and nothing reaches the phone.
  const busy = await host.call('screen_input', { stream: opened.stream, kind: 'tap', x: 0.5, y: 0.5 });
  assert.equal(busy.structuredContent.reason, 'busy', JSON.stringify(busy));
  // A model cannot take over on its own: the token comes from the gesture the agent refused.
  assert.equal((await host.call('screen_takeover', { stream: opened.stream, token: 'x'.repeat(32) })).structuredContent.reason, 'no_token');
  assert.ok(busy.structuredContent.takeover_token);
  const taken = await host.call('screen_takeover', { stream: opened.stream, token: busy.structuredContent.takeover_token });
  assert.equal(taken.structuredContent?.taken_over, true, JSON.stringify(taken));
  const stopped = await batch;
  assert.ok(Date.now() - started < 10000, 'the batch ran on after the takeover');
  assert.match(JSON.stringify(stopped.content), /taken_over/, JSON.stringify(stopped));
  const refused = await host.call('tap', { device: 'lab-iphone', x: 10, y: 10 });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /occupied: a person took over lab-iphone in the screen panel/);
  assert.equal((await host.call('screen_input', { stream: opened.stream, kind: 'tap', x: 0.1, y: 0.2 })).structuredContent.sent, true);
  const taps = (await host.commands()).filter(c => c.remote === 'tap');
  assert.deepEqual(taps.map(c => [c.request.x, c.request.y]), [[6554, 13107]], 'only the view\'s tap after the takeover reached the phone');
});

const browserReady = chromium && (existsSync(chromium.executablePath()) || ['/Applications/Google Chrome.app', '/usr/bin/google-chrome'].some(existsSync));
test('the view host page shows the live screen after the agent calls show_screen', { timeout: 60000, skip: !browserReady && !process.env.CI && 'no browser for Playwright' }, async t => {
  const host = await viewHost(t);
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  await page.goto(host.url);
  await page.getByRole('button', { name: 'Agent calls show_screen' }).click();
  const view = page.frameLocator('iframe');
  await view.locator('#screen:not([hidden])').waitFor({ timeout: 30000 });
  await until(async () => (await view.locator('#stats').textContent()).match(/[1-9]\d* fps/));
  const box = await view.locator('#screen').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(async () => (await host.commands()).some(c => c.remote === 'tap'));
});

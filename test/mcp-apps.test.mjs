import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { exportsAsGlobal, RESOURCE_MIME_TYPE, views } from '../src/views/index.mjs';

test('tools/list carries MCP Apps _meta and lists app-only tools; the shim serves views without a daemon', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false });
  const { tools } = await f.a.listTools();
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.deepEqual(byName.pair_device._meta.ui, { resourceUri: 'ui://poki/pairing', visibility: ['model', 'app'] });
  assert.equal(byName.pair_device._meta['ui/resourceUri'], 'ui://poki/pairing', 'the legacy key older hosts read');
  assert.deepEqual(byName.pair_device._meta['lobehub/ui'], { preferredModelDisplayMode: 'inline' });
  assert.deepEqual(byName.pairing_cancel._meta.ui.visibility, ['app'], 'app-only tools are listed; the host hides them from the model');
  assert.deepEqual(byName.pairing_status._meta.ui.visibility, ['model', 'app']);
  assert.deepEqual(byName.unpair_device.annotations, { readOnlyHint: false, title: 'Remove a wireless pairing', destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.equal(byName.pairing_status.annotations.readOnlyHint, true);
  assert.equal(byName.pair_device.annotations.openWorldHint, true);
  // The screen panel opens in LobeHub's side panel; its stream tools are the view's alone.
  assert.deepEqual(byName.show_screen._meta.ui, { resourceUri: 'ui://poki/screen', visibility: ['model', 'app'] });
  // A LobeHub thread entry point too: the person opens the panel from a conversation (getMcpAppEntrypoints).
  assert.deepEqual(byName.show_screen._meta['lobehub/ui'], { preferredModelDisplayMode: 'fullscreen', entrypoints: [{ type: 'thread' }] });
  // A takeover stops other sessions' work: gated and marked destructive.
  assert.deepEqual(byName.screen_takeover.annotations, { readOnlyHint: false, title: 'Take over the iPhone', destructiveHint: true, idempotentHint: true, openWorldHint: false });
  for (const name of ['screen_open', 'screen_read', 'screen_close', 'screen_keyframe', 'screen_input', 'screen_takeover', 'screen_rtc_config', 'screen_rtc_offer']) assert.deepEqual(byName[name]._meta.ui.visibility, ['app'], name);

  const { resources } = await f.a.listResources();
  assert.deepEqual(resources.map(r => [r.uri, r.mimeType]), [['ui://poki/pairing', RESOURCE_MIME_TYPE], ['ui://poki/screen', RESOURCE_MIME_TYPE]]);
  const screen = (await f.a.readResource({ uri: 'ui://poki/screen' })).contents[0];
  assert.match(screen.text, /globalThis\.PokiExtApps=/, 'the screen view carries the inlined ext-apps bundle');
  const read = await f.a.readResource({ uri: 'ui://poki/pairing' });
  const [content] = read.contents;
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert.match(content.text, /^<!doctype html>/i);
  assert.match(content.text, /globalThis\.PokiExtApps=Object\.freeze\(\{[^}]*"App":/, 'the ext-apps bundle is inlined');
  assert.doesNotMatch(content.text, /poki:ext-apps/, 'no marker is left');
  assert.doesNotMatch(content.text, /<script[^>]+src=/, 'the page loads no script from anywhere');
  assert.equal(content._meta.ui.prefersBorder, true);
  await assert.rejects(f.a.readResource({ uri: 'ui://poki/unknown' }), /unknown/i);
  // Listing tools and reading views never starts the service.
  await assert.rejects(access(join(f.dir, 'state/mcp.json')), { code: 'ENOENT' });
});

test('POKI_MCP_TOOLS=all lists the same _meta', { timeout: 30000 }, async t => {
  const f = await fixture(t, { daemon: false });
  const all = await f.connect('all');
  const tool = (await all.listTools()).tools.find(candidate => candidate.name === 'pair_device');
  assert.equal(tool._meta.ui.resourceUri, 'ui://poki/pairing');
  assert.equal((await all.listResources()).resources.length, views.length);
});

test('the bundle rewrite publishes the named exports and refuses anything it would drop', async () => {
  assert.equal(await exportsAsGlobal('const a=1,b=2;export{a as App,b};', 'X'), 'const a=1,b=2;globalThis.X=Object.freeze({"App":a,"b":b});');
  await assert.rejects(exportsAsGlobal('export default 1;'), /Unexpected export form/);
  await assert.rejects(exportsAsGlobal('export{a}from"./x.js";'), /Unexpected export form/);
  await assert.rejects(exportsAsGlobal('const a="</script>";export{a};'), /<\/script/);
});

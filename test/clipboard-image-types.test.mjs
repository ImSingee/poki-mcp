import test from 'node:test';
import assert from 'node:assert/strict';
import { platform } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, value } from './fixture.mjs';
import { containsImage } from '../src/uti.mjs';

test('image pasteboard types are recognized without a host helper', () => {
  for (const type of ['public.png', 'public.jpeg', 'public.heic', 'public.tiff', 'com.compuserve.gif', 'org.webmproject.webp', 'public.camera-raw-image', 'public.svg-image', 'public.image']) {
    assert.equal(containsImage([type]), true, type);
  }
  for (const types of [[], ['public.utf8-plain-text'], ['public.url', 'public.html'], ['com.adobe.pdf'], ['public.movie']]) {
    assert.equal(containsImage(types), false, types.join(','));
  }
  assert.equal(containsImage(['public.utf8-plain-text', 'public.jpeg']), true);
});

// build/simulator links AppKit and is only built on macOS. Off macOS a physical
// iPhone's clipboard read must not reach for it.
test('get_clipboard on a physical iPhone does not need build/simulator off macOS', { skip: platform() === 'darwin' && 'build/simulator exists on macOS' }, async t => {
  const f = await fixture(t, { approvalMode: 'allow', beforeStart: async dir => {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state/remote-devices.json'), JSON.stringify([{ id: 'remote-phone', config_path: join(dir, 'remote.json') }]));
    await rm(join(dir, 'build/simulator'), { force: true });
    await writeFile(join(dir, 'build/poki-native'), `#!/usr/bin/env node
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
if (process.argv[2] !== '--remote-server') process.exit(1);
const server = createServer(socket => {
  socket.write(JSON.stringify({pid:process.pid})+'\\n');
  createInterface({input:socket}).once('line', line => {
    const { op, action } = JSON.parse(line);
    const reply = op === 'disconnect' ? {disconnected:true}
      : op === 'pasteboard' && action === 'get' ? {text:'fixture'}
      : op === 'pasteboard' && action === 'items' ? {items:[{uti:'public.utf8-plain-text'},{uti:'public.heic'}]}
      : {transport_error:true,error:'Unexpected native request'};
    socket.end(JSON.stringify(reply)+'\\n');
    if (op === 'disconnect') server.close();
  });
});
server.listen(process.argv[4], () => console.log(JSON.stringify({ready:true})));
`, { mode: 0o755 });
  }});
  const args = { device: 'remote-phone' };
  try {
    const read = await f.call('get_clipboard', args);
    assert.ok(!read.isError, JSON.stringify(read));
    assert.equal(value(read).text, 'fixture');
    assert.equal(value(read).contains_image, true);
    assert.deepEqual(value(read).types, ['public.utf8-plain-text', 'public.heic']);
  } finally {
    await f.call('disconnect_device', args);
  }
});

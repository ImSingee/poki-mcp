// The sample streams in native/bridge/tests/fixtures (180x390, 8 frames, a key frame every 4),
// cut into frames as the native helper delivers them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../src/config.mjs';
import { nalUnits, hevcType, avcType } from '../src/stream/codec.mjs';

export const samplePath = codec => join(root, 'native/bridge/tests/fixtures', codec === 'hevc' ? 'sample.h265' : 'sample.h264');
const annexb = nals => Buffer.concat(nals.flatMap(nal => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));

export function sampleFrames(codec = 'hevc') {
  const type = codec === 'hevc' ? hevcType : avcType;
  const isVcl = codec === 'hevc' ? t => t <= 31 : t => t === 1 || t === 5;
  const starts = codec === 'hevc' ? t => t === 32 : t => t === 7;
  const isKey = codec === 'hevc' ? t => t >= 16 && t <= 23 : t => t === 5;
  const params = codec === 'hevc' ? [32, 33, 34] : [7, 8];
  const units = [];
  let current = [];
  for (const nal of nalUnits(readFileSync(samplePath(codec)))) {
    const t = type(nal);
    if (current.length && (starts(t) || (isVcl(t) && current.some(n => isVcl(type(n)))))) { units.push(current); current = []; }
    current.push(nal);
  }
  units.push(current);
  return units.map((nals, index) => {
    const key = nals.some(n => isKey(type(n)));
    return { seq: index + 1, key, reset: index === 0, pts_us: index * 100_000, config: key ? annexb(nals.filter(n => params.includes(type(n)))) : undefined, data: annexb(nals) };
  });
}

// A native subscription the test drives: send() delivers a frame, end() closes it as the helper
// would. Each subscribe() records itself in `subscriptions`.
export function fakeNative({ reply = { subscribed: true, codec: 'hevc', width: 180, height: 390 }, fail } = {}) {
  const subscriptions = [], keyframes = [];
  return {
    subscriptions, keyframes,
    subscribe: async (target, onFrame) => {
      if (fail) throw Object.assign(new Error(fail), { reason: 'display_service_missing' });
      let end;
      const closed = new Promise(resolve => { end = resolve; });
      const subscription = { target, open: true, send: frame => subscription.open && onFrame(frame), end: () => { subscription.open = false; end(); } };
      subscriptions.push(subscription);
      return { reply, closed, close: () => subscription.end() };
    },
    keyframe: async target => { keyframes.push({ target: target.id, at: performance.now() }); return { requested: true }; },
  };
}

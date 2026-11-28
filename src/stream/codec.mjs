// Annex-B parsing for the screen stream: NAL units, and the WebCodecs codec string and picture
// size a sequence parameter set describes. A view decodes Annex-B as is: WebCodecs reads Annex-B
// when a decoder is configured without a description, for both HEVC and H.264.

// The NAL units of an Annex-B buffer, without start codes, as subarrays of it.
export function nalUnits(buffer) {
  const starts = [];
  for (let i = 0; i + 3 <= buffer.length; i++) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  return starts.map((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1] - 3 : buffer.length;
    // A four-byte start code leaves its leading zero on the unit before it.
    while (n + 1 < starts.length && end > start && buffer[end - 1] === 0) end--;
    return buffer.subarray(start, end);
  }).filter(nal => nal.length >= 2);
}

export const hevcType = nal => (nal[0] >> 1) & 0x3f;
export const avcType = nal => nal[0] & 0x1f;

// The payload of a NAL unit without its emulation prevention bytes.
function rbsp(nal, header) {
  const out = [];
  let zeros = 0;
  for (let i = header; i < nal.length; i++) {
    const byte = nal[i];
    if (zeros >= 2 && byte === 3) { zeros = 0; continue; }
    zeros = byte === 0 ? zeros + 1 : 0;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

class Bits {
  constructor(data) { this.data = data; this.at = 0; }
  bit() {
    if (this.at >= this.data.length * 8) throw new Error('SPS ends early');
    const value = (this.data[this.at >> 3] >> (7 - (this.at & 7))) & 1;
    this.at++;
    return value;
  }
  bits(n) { let value = 0; for (let i = 0; i < n; i++) value = value * 2 + this.bit(); return value; }
  skip(n) { this.at += n; if (this.at > this.data.length * 8) throw new Error('SPS ends early'); }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) if (++zeros > 31) throw new Error('Invalid SPS');
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se() { const value = this.ue(); return value % 2 ? (value + 1) / 2 : -value / 2; }
}

const hex = value => value.toString(16).toUpperCase();
const reverse32 = value => { let out = 0; for (let i = 0; i < 32; i++) out = out * 2 + ((value >>> i) & 1); return out; };

// The codec string (ISO/IEC 14496-15 annex E) and displayed size of an HEVC SPS NAL unit.
export function hevcSps(nal) {
  const data = rbsp(nal, 2);
  const bits = new Bits(data);
  bits.skip(4);
  const subLayers = bits.bits(3);
  bits.skip(1);
  const space = bits.bits(2), tier = bits.bit(), profile = bits.bits(5);
  const compatibility = bits.bits(32);
  const constraints = [];
  for (let i = 0; i < 6; i++) constraints.push(bits.bits(8));
  const level = bits.bits(8);
  const present = [];
  for (let i = 0; i < subLayers; i++) present.push([bits.bit(), bits.bit()]);
  if (subLayers > 0) bits.skip(2 * (8 - subLayers));
  for (const [profilePresent, levelPresent] of present) { if (profilePresent) bits.skip(88); if (levelPresent) bits.skip(8); }
  bits.ue();
  const chroma = bits.ue();
  if (chroma === 3) bits.skip(1);
  let width = bits.ue(), height = bits.ue();
  if (bits.bit()) {
    const [subWidth, subHeight] = chroma === 1 ? [2, 2] : chroma === 2 ? [2, 1] : [1, 1];
    const left = bits.ue(), right = bits.ue(), top = bits.ue(), bottom = bits.ue();
    width -= subWidth * (left + right); height -= subHeight * (top + bottom);
  }
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  const codec = ['hvc1', `${['', 'A', 'B', 'C'][space]}${profile}`, hex(reverse32(compatibility)), `${tier ? 'H' : 'L'}${level}`, ...constraints.map(hex)].join('.');
  return { codec, width, height };
}

// The codec string and displayed size of an H.264 SPS NAL unit.
export function avcSps(nal) {
  const codec = 'avc1.' + [nal[1], nal[2], nal[3]].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const bits = new Bits(rbsp(nal, 1));
  const profile = bits.bits(8);
  bits.skip(16);
  bits.ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = bits.ue();
    if (chroma === 3) bits.skip(1);
    bits.ue(); bits.ue(); bits.skip(1);
    if (bits.bit()) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!bits.bit()) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + bits.se() + 256) % 256; last = next || last; }
      }
    }
  }
  bits.ue();
  const order = bits.ue();
  if (order === 0) bits.ue();
  else if (order === 1) { bits.skip(1); bits.se(); bits.se(); const cycle = bits.ue(); for (let i = 0; i < cycle; i++) bits.se(); }
  bits.ue(); bits.skip(1);
  const widthMbs = bits.ue() + 1, heightUnits = bits.ue() + 1;
  const frameOnly = bits.bit();
  if (!frameOnly) bits.skip(1);
  bits.skip(1);
  let width = widthMbs * 16, height = heightUnits * 16 * (2 - frameOnly);
  if (bits.bit()) {
    const [cropX, cropY] = chroma === 0 ? [1, 2 - frameOnly] : chroma === 3 ? [1, 2 - frameOnly] : chroma === 2 ? [2, 2 - frameOnly] : [2, 2 * (2 - frameOnly)];
    const left = bits.ue(), right = bits.ue(), top = bits.ue(), bottom = bits.ue();
    width -= cropX * (left + right); height -= cropY * (top + bottom);
  }
  return { codec, width, height };
}

// The codec string and size of the first SPS in an Annex-B buffer (a key frame or its config).
export function describe(codec, annexb) {
  for (const nal of nalUnits(annexb)) {
    if (codec === 'hevc' && hevcType(nal) === 33) return hevcSps(nal);
    if (codec === 'h264' && avcType(nal) === 7) return avcSps(nal);
  }
  return undefined;
}

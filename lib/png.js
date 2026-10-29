// A small PNG reader (8-bit, not interlaced: grey, RGB, palette, grey+alpha, RGBA) -> RGBA pixels.
// Enough for the app icon (Omega.png) without pulling in an image library.
import { inflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file.');
  let o = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), name = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace || !(type in CHANNELS)) throw new Error(`Unsupported PNG (bit depth ${depth}, colour type ${type}${interlace ? ', interlaced' : ''}). Save it as an 8-bit RGBA PNG.`);
  const bpp = CHANNELS[type], stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      if (type === 6) cur.copy(out, d, s, s + 4);
      else if (type === 2) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; }
      else if (type === 0) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
      else if (type === 4) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }
      else { const i = cur[s]; out[d] = palette[i * 3]; out[d + 1] = palette[i * 3 + 1]; out[d + 2] = palette[i * 3 + 2]; out[d + 3] = trns && i < trns.length ? trns[i] : 255; }
    }
    prev = cur;
  }
  return { width: w, height: h, rgba: out };
}

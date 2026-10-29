// Writes assets/icon.ico (desktop shortcut, window and taskbar icon) from Omega.png via lib/icon.js.
// Run: node assets/make-icon.mjs
import { writeFileSync } from 'node:fs';
import { iconBitmap } from '../lib/icon.js';

const SIZES = [16, 32, 48, 64, 128, 256];   // whole multiples of the 16x16 pixel art, so it stays crisp

// One ICO image: a 32-bit bottom-up DIB followed by an (empty) AND mask.
function dib(size) {
  const bgra = iconBitmap(size);
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8);          // XOR + AND mask heights
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) bgra.copy(pixels, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([head, pixels, mask]);
}

const images = SIZES.map(dib);
const dir = Buffer.alloc(6 + 16 * SIZES.length);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(SIZES.length, 4);
let offset = dir.length;
SIZES.forEach((s, i) => {
  const e = 6 + 16 * i;
  dir.writeUInt8(s >= 256 ? 0 : s, e);
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(images[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
const out = new URL('./icon.ico', import.meta.url);
writeFileSync(out, Buffer.concat([dir, ...images]));
console.log('wrote', out.pathname, offset, 'bytes');

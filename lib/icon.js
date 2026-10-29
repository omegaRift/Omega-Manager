// The app icon as a BGRA bitmap of any size, from the user's pixel-art Omega.png (app folder).
// Pixel art is scaled nearest-neighbour so it stays crisp. Tray states add a small dot:
// running = orange, alert (a timer is ringing) = yellow; paused = grey. If Omega.png is missing or
// can't be read, a drawn Ω on a cyan tile is used instead.
import { readFileSync } from 'node:fs';
import { decodePng } from './png.js';

export const ICON_PNG = new URL('../Omega.png', import.meta.url);

let art;            // { width, height, rgba } | null
export function iconArt() {
  if (art === undefined) {
    try { art = decodePng(readFileSync(ICON_PNG)); } catch { art = null; }
  }
  return art;
}

const BADGE = { running: [0xe0, 0x8a, 0x1e], alert: [0xff, 0xd4, 0x00] };

export function iconBitmap(size, state = 'idle') {
  const src = iconArt();
  const buf = src ? scaled(src, size) : drawnOmega(size);
  if (state === 'paused') {
    for (let o = 0; o < buf.length; o += 4) {
      const g = Math.round(0.3 * buf[o + 2] + 0.59 * buf[o + 1] + 0.11 * buf[o]);
      buf[o] = buf[o + 1] = buf[o + 2] = Math.round(g * 0.75 + 40);
    }
  }
  if (BADGE[state]) badge(buf, size, BADGE[state]);
  return buf;
}

// Nearest-neighbour scale, RGBA in -> BGRA out.
function scaled({ width, height, rgba }, size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.min(width - 1, Math.floor((x * width) / size)), sy = Math.min(height - 1, Math.floor((y * height) / size));
    const s = (sy * width + sx) * 4, d = (y * size + x) * 4;
    buf[d] = rgba[s + 2]; buf[d + 1] = rgba[s + 1]; buf[d + 2] = rgba[s]; buf[d + 3] = rgba[s + 3];
  }
  return buf;
}

// A round dot with a dark rim in the bottom-right corner.
function badge(buf, size, rgb) {
  const r = Math.max(2.5, size * 0.21), cx = size - r - size * 0.02, cy = size - r - size * 0.02, rim = Math.max(1, size * 0.06);
  const SS = 4;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r); x++) {
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    let fill = 0, edge = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const d = Math.hypot(x + (sx + 0.5) / SS - cx, y + (sy + 0.5) / SS - cy);
      if (d <= r - rim) fill++; else if (d <= r) edge++;
    }
    const n = SS * SS, a = (fill + edge) / n;
    if (!a) continue;
    const o = (y * size + x) * 4, k = fill / (fill + edge);
    const col = [rgb[0] * k + 0x33 * (1 - k), rgb[1] * k, rgb[2] * k];
    const ba = buf[o + 3] / 255, oa = a + ba * (1 - a);
    for (let i = 0; i < 3; i++) {
      const under = buf[o + 2 - i];
      buf[o + 2 - i] = Math.round((col[i] * a + under * ba * (1 - a)) / (oa || 1));
    }
    buf[o + 3] = Math.round(255 * oa);
  }
}

// Fallback: a white Ω on a cyan tile (24-unit grid, same shape as before Omega.png existed).
const CX = 12, CY = 12.625, R = 5.7, HW = 1.05, GAP = Math.asin(3.4 / R);
const ENDS = [[8.6, 17.2], [15.4, 17.2]], FEET = [[[5.8, 18.2], [9.6, 18.2]], [[14.4, 18.2], [18.2, 18.2]]];
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function inOmega(x, y) {
  const d = Math.hypot(x - CX, y - CY);
  if (Math.abs(d - R) <= HW && Math.abs(Math.atan2(x - CX, y - CY)) >= GAP) return true;
  return ENDS.some(([ex, ey]) => Math.hypot(x - ex, y - ey) <= HW) || FEET.some(([a, b]) => segDist(x, y, a, b) <= HW);
}
function drawnOmega(size) {
  const buf = Buffer.alloc(size * size * 4), tile = [0x06, 0xb6, 0xd4], r = size * 0.25, SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let tc = 0, ic = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      const dx = Math.max(r - px, 0, px - (size - r)), dy = Math.max(r - py, 0, py - (size - r));
      if (dx * dx + dy * dy <= r * r) tc++;
      if (inOmega(px * 24 / size, py * 24 / size)) ic++;
    }
    const a = tc / (SS * SS), w = ic / (SS * SS), o = (y * size + x) * 4;
    const rgb = tile.map(c => Math.round(c * (1 - w) + 255 * w));
    buf[o] = rgb[2]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[0]; buf[o + 3] = Math.round(255 * a);
  }
  return buf;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconArt, iconBitmap } from '../lib/icon.js';

const px = (buf, size, x, y) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];   // BGRA

test('the icon comes from Omega.png, scaled crisp', () => {
  const art = iconArt();
  assert.ok(art, 'Omega.png is in the app folder and readable');
  assert.deepEqual([art.width, art.height], [16, 16]);
  const b = iconBitmap(32);
  assert.deepEqual(px(b, 32, 0, 0), [0, 0, 0, 0], 'corner stays see-through');
  // Source pixel (5, 0) is the dark red outline #660000: at 2x it fills (10..11, 0..1) exactly.
  for (const [x, y] of [[10, 0], [11, 0], [10, 1], [11, 1]]) assert.deepEqual(px(b, 32, x, y), [0x00, 0x00, 0x66, 0xff]);
  // Source (1, 13) is pure red #ff0000.
  assert.deepEqual(px(iconBitmap(16), 16, 1, 13), [0x00, 0x00, 0xff, 0xff]);
});

test('tray states: a dot for running and alerts, grey when paused', () => {
  const idle = iconBitmap(32), run = iconBitmap(32, 'running'), alert = iconBitmap(32, 'alert'), paused = iconBitmap(32, 'paused');
  const c = 32 - 1 - Math.round(32 * 0.21 + 32 * 0.02);   // inside the dot
  assert.deepEqual(px(run, 32, c, c).slice(0, 3), [0x1e, 0x8a, 0xe0], 'orange dot while a task runs');
  assert.deepEqual(px(alert, 32, c, c).slice(0, 3), [0x00, 0xd4, 0xff], 'yellow dot while a timer rings');
  assert.deepEqual(px(run, 32, 10, 0), px(idle, 32, 10, 0), 'the rest of the icon is unchanged');
  const [b, g, r] = px(paused, 32, 10, 0);
  assert.ok(b === g && g === r, 'paused is grey');
});

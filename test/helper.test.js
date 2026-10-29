// Starts the real PowerShell helper in DRY mode: it reads windows and the cursor, and input commands
// only report what they would do. Nothing moves the mouse or presses keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Native } from '../lib/native.js';

test('helper starts, reads windows, and stays dry', { timeout: 60e3 }, async () => {
  const n = new Native({ dry: true });
  try {
    const info = await n.start();
    assert.equal(info.dry, true);
    assert.equal(info.inputSize, 40, 'INPUT struct must be 40 bytes on x64 or SendInput fails');
    const wins = await n.windows();
    assert.ok(Array.isArray(wins));
    for (const w of wins) {
      assert.equal(typeof w.hwnd, 'number');
      assert.equal(typeof w.title, 'string');
      assert.ok(Array.isArray(w.rect) && w.rect.length === 4, 'rect for ' + w.title);
    }
    if (wins.length) {
      const r = await n.rect(wins[0].hwnd);
      assert.ok(r && r.w >= 0);
    }
    assert.equal(await n.rect(1), null, 'no such window');
    const before = await n.cursor();
    assert.ok(Number.isInteger(before.x));
    const c = await n.click(before.x + 300, before.y + 300, 'left', 2);
    assert.deepEqual(c.dry, [`left click x2 at ${before.x + 300},${before.y + 300}`]);
    assert.deepEqual((await n.type('héllo ✓\n')).dry, ['type héllo ✓\n']);
    assert.deepEqual((await n.keys([0x11, 0x53])).dry, ['keys 17+83']);
    assert.deepEqual((await n.scroll(5, 6, -3, false)).dry, ['scroll v -3 at 5,6']);
    const pi = await n.procinfo(n.child.pid);
    assert.match(pi.path, /powershell.exe$/i, 'the helper itself is a PowerShell process');
    assert.match(pi.commandLine, /native.ps1/i);
    assert.equal(typeof pi.aumid, 'string');
    await assert.rejects(n.call('bogus'), /unknown command/);
    assert.deepEqual(await n.cursor(), { x: 5, y: 6 }, 'dry mode keeps a pretend cursor at the last dry spot');
  } finally { n.stop(); }
});

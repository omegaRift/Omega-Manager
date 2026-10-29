import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommandLine, launchFromProcess, openWindow, adoptWindow, canOpen, programName } from '../lib/launch.js';

test('command lines split into program and arguments', () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\App\\app.exe" --open "my file.txt"'), { exe: 'C:\\Program Files\\App\\app.exe', args: '--open "my file.txt"' });
  assert.deepEqual(splitCommandLine('notepad.exe C:\\notes.txt'), { exe: 'notepad.exe', args: 'C:\\notes.txt' });
  assert.deepEqual(splitCommandLine('C:\\x.exe'), { exe: 'C:\\x.exe', args: '' });
  assert.deepEqual(splitCommandLine(''), { exe: '', args: '' });
  assert.deepEqual(launchFromProcess({ path: 'C:\\a.exe', commandLine: '"C:\\a.exe"  b.txt ' }), { path: 'C:\\a.exe', args: 'b.txt', aumid: '', settle: 2 });
  assert.equal(launchFromProcess({}), null);
  assert.equal(launchFromProcess({ aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }).aumid, 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App');
  assert.equal(canOpen({ kind: 'window', launch: { path: '' } }), false);
  assert.equal(programName({ launch: { path: 'C:\\Tools\\Thing.exe' } }), 'Thing');
});

function fakeDesktop({ appearsAfter = 3, process = 'notepad', title = 'Untitled - Notepad', existing = [] } = {}) {
  let t = 0, started = null, polls = 0;
  return {
    started: () => started,
    deps: {
      now: () => t,
      sleep: async ms => { t += ms; },
      start: async L => { started = L; },
      windows: async () => {
        if (started) polls++;
        const list = [...existing];
        if (started && polls >= appearsAfter) list.push({ hwnd: 77, title, process, rect: [0, 0, 800, 600], minimized: false });
        return list;
      },
    },
  };
}

test('opens the program and waits for its new window', async () => {
  const vp = { kind: 'window', hwnd: 5, title: 'notes.txt - Notepad', process: 'notepad', launch: { path: 'C:\\Windows\\notepad.exe', args: 'notes.txt', settle: 0 } };
  const d = fakeDesktop({ existing: [{ hwnd: 9, title: 'Inbox', process: 'olk', rect: [0, 0, 1, 1] }] });
  const progress = [];
  const w = await openWindow(vp, { ...d.deps, onProgress: p => progress.push(p) });
  assert.equal(w.hwnd, 77);
  assert.deepEqual(d.started(), vp.launch);
  assert.ok(progress.length >= 2 && progress.every(p => p >= 0 && p < 1));
  assert.deepEqual(adoptWindow(vp, w), { ...vp, hwnd: 77, sourceId: 'window:77:0', title: 'Untitled - Notepad', process: 'notepad' });
});

test('a window of another program does not count; it times out in plain words', async () => {
  const vp = { kind: 'window', hwnd: 5, title: 'x', process: 'notepad', launch: { path: 'C:\\n.exe', settle: 0 } };
  const d = fakeDesktop({ process: 'chrome', title: 'New tab' });
  await assert.rejects(openWindow(vp, d.deps, { timeoutMs: 5000 }), /Opened notepad, but its window did not show up within 5 s/);
});

test('without launch settings it says how to fix it', async () => {
  await assert.rejects(openWindow({ kind: 'window', title: 'Mail' }, fakeDesktop().deps), /doesn't know how to open "Mail"/);
});

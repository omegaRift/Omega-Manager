import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCombo, keyCode } from '../lib/keys.js';
import { parseSourceId, toScreen, rectToFraction, matchWindow, containFraction, fitLongEdge, boxCenter } from '../lib/geometry.js';
import { nextFire, validateTrigger, describeTrigger, staleOnce } from '../lib/schedule.js';
import { parseItems, parseFind, salvageJson, boxToFraction, normType } from '../lib/detect.js';
import { runTask, expandText, stepProblem, describeStep, Stopped } from '../lib/runner.js';
import { Scheduler } from '../lib/scheduler.js';

test('key combos', () => {
  assert.deepEqual(parseCombo('Ctrl+S'), { vks: [0x11, 0x53] });
  assert.deepEqual(parseCombo('s+ctrl+shift').vks.slice(-1), [0x53]);
  assert.deepEqual(parseCombo('enter'), { vks: [0x0D] });
  assert.equal(keyCode('F12'), 0x7B);
  assert.equal(keyCode('f1'), 0x70);
  assert.deepEqual(parseCombo('ctrl++'), { vks: [0x11, 0xBB] });
  assert.match(parseCombo('ctrl+banana').error, /banana/);
  assert.match(parseCombo('a+b').error, /one main key/);
  assert.match(parseCombo('').error, /Enter a key/);
});

test('geometry', () => {
  assert.deepEqual(parseSourceId('window:132456:0'), { kind: 'window', hwnd: 132456 });
  assert.deepEqual(parseSourceId('screen:1:0'), { kind: 'screen', index: 1 });
  assert.equal(parseSourceId('nope'), null);
  const rect = { x: -1920, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(toScreen(rect, 0, 0), { x: -1920, y: 0 });
  assert.deepEqual(toScreen(rect, 1, 1), { x: -1, y: 1079 });
  assert.deepEqual(toScreen(rect, 0.5, 0.5), { x: -960, y: 540 });
  assert.deepEqual(toScreen(rect, 7, -3), { x: -1, y: 0 });       // clamped
  const f = rectToFraction({ x: 100, y: 100, w: 1000, h: 500 }, { x: 200, y: 150, w: 100, h: 50 });
  assert.deepEqual(f, { fx1: 0.1, fy1: 0.1, fx2: 0.2, fy2: 0.2 });
  assert.deepEqual(boxCenter(f), { fx: 0.15000000000000002, fy: 0.15000000000000002 });
  const c = containFraction(1000, 1000, 2000, 1000, 500, 500);   // letterboxed: picture 1000x500 at y 250
  assert.ok(Math.abs(c.fx - 0.5) < 1e-9 && Math.abs(c.fy - 0.5) < 1e-9 && c.inside);
  assert.equal(containFraction(1000, 1000, 2000, 1000, 500, 100).inside, false);
  assert.deepEqual(fitLongEdge(2560, 1440), { w: 1280, h: 720 });
  assert.deepEqual(fitLongEdge(800, 600), { w: 800, h: 600 });
});

test('window matching after a restart', () => {
  const wins = [
    { hwnd: 1, title: 'Inbox - Mail', process: 'olk' },
    { hwnd: 2, title: 'Untitled - Notepad', process: 'Notepad' },
    { hwnd: 3, title: 'notes.txt - Notepad', process: 'Notepad' },
  ];
  assert.equal(matchWindow({ hwnd: 2, process: 'Notepad', title: 'x' }, wins).hwnd, 2);
  assert.equal(matchWindow({ hwnd: 99, process: 'Notepad', title: 'notes.txt - Notepad' }, wins).hwnd, 3);
  assert.equal(matchWindow({ hwnd: 99, process: 'olk', title: 'Sent - Mail' }, wins).hwnd, 1);
  assert.equal(matchWindow({ hwnd: 99, process: 'Notepad', title: 'other' }, wins), null);   // ambiguous
  assert.equal(matchWindow({ hwnd: 99, process: 'Notepad', title: 'other', titleMatch: 'notes' }, wins).hwnd, 3);
  assert.equal(matchWindow({ hwnd: 1, process: 'Notepad', title: 'x' }, [{ hwnd: 1, title: 'y', process: 'chrome' }]), null); // HWND reused by another app
});

test('timers', () => {
  const now = new Date(2026, 9, 29, 10, 0, 0).getTime();   // Thu 29 Oct 2026 10:00
  assert.equal(nextFire({ kind: 'interval', every: 5, unit: 's' }, now), now + 5000);
  assert.equal(nextFire({ kind: 'interval', every: 2, unit: 'min' }, now, now - 30e3), now + 90e3);
  assert.equal(nextFire({ kind: 'interval', every: 1, unit: 's' }, now, now - 60e3), now, 'overdue = now, no burst');
  assert.equal(nextFire({ kind: 'interval', every: 1, unit: 's', maxRuns: 3, runs: 3 }, now), null);
  assert.equal(nextFire({ kind: 'interval', every: 1, unit: 's', enabled: false }, now), null);
  assert.equal(nextFire({ kind: 'daily', time: '09:00' }, now), new Date(2026, 9, 30, 9, 0).getTime());
  assert.equal(nextFire({ kind: 'daily', time: '10:30' }, now), new Date(2026, 9, 29, 10, 30).getTime());
  assert.equal(nextFire({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, new Date(2026, 9, 30, 12, 0).getTime()), new Date(2026, 10, 2, 9, 0).getTime(), 'Fri noon -> Mon');
  const once = { kind: 'once', at: new Date(2026, 9, 29, 11, 0).toISOString() };
  assert.equal(nextFire(once, now), new Date(2026, 9, 29, 11, 0).getTime());
  assert.equal(nextFire({ ...once, runs: 1 }, now), null);
  assert.equal(staleOnce({ kind: 'once', at: new Date(now - 3600e3).toISOString() }, now), true);
  assert.match(validateTrigger({ kind: 'interval', every: 0.5, unit: 's' }), /at least 1 second/);
  assert.match(validateTrigger({ kind: 'daily', time: '25:00' }), /time of day/);
  assert.equal(validateTrigger({ kind: 'daily', time: '07:05', days: [0, 6] }), null);
  assert.equal(describeTrigger({ kind: 'interval', every: 30, unit: 's' }), 'Every 30 seconds');
  assert.equal(describeTrigger({ kind: 'interval', every: 1, unit: 'h', maxRuns: 4 }), 'Every hour, 4 times');
  assert.equal(describeTrigger({ kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }), 'Weekdays at 08:30');
});

test('model answers become boxes', () => {
  // A real qwen3.5:9b answer for test/fixtures/form.html at 1280x800 (0..1000 grid).
  const answer = '{"items":[{"type":"textbox","label":"Customer name","box":[34,135,267,180]},{"type":"searchfield","label":"Search orders","box":[789,12,970,62]},{"type":"button","label":"Place order","box":[511,460,605,510]}]}';
  const items = parseItems(answer, 1280, 800);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { type: 'textbox', label: 'Customer name', fx1: 0.034, fy1: 0.135, fx2: 0.267, fy2: 0.18, source: 'ai' });
  assert.equal(items[1].type, 'textbox');
  // Truncated answer still yields the complete items.
  const cut = answer.slice(0, answer.indexOf('{"type":"button"') + 20);
  assert.equal(parseItems(cut, 1280, 800).length, 2);
  // Pixel boxes (some numbers > 1000) are scaled by the picture size.
  assert.deepEqual(boxToFraction([640, 400, 1280, 800], 1280, 800), { fx1: 0.5, fy1: 0.5, fx2: 1, fy2: 1 });
  assert.equal(boxToFraction([5, 5, 5, 9], 100, 100), null);
  assert.equal(normType('Search Field'), 'textbox');
  assert.equal(normType('combo-box'), 'dropdown');
  assert.equal(parseFind('{"found":false}', 100, 100), null);
  assert.deepEqual(parseFind('{"found":true,"label":"Send","box":[100,200,300,400]}', 1, 1), { label: 'Send', fx1: 0.1, fy1: 0.2, fx2: 0.3, fy2: 0.4 });
  assert.equal(salvageJson('nonsense'), null);
  // Duplicate boxes are merged.
  assert.equal(parseItems('{"items":[{"type":"textbox","box":[0,0,100,100]},{"type":"textbox","box":[2,2,101,99]}]}', 1, 1).length, 1);
});

export function fakeDeps(log, { rect = { x: 100, y: 50, w: 1000, h: 500 }, cursorMoves = null, find = null } = {}) {
  let cur = { x: 0, y: 0 };
  return {
    resolve: async () => ({ rect, hwnd: 42 }),
    aiFind: async (v, d) => (find ? find(d) : null),
    sleep: async () => {},
    onStep: (s, p) => log.push(['step', s.type, p.x, p.y]),
    input: {
      focus: async h => log.push(['focus', h]),
      cursor: async () => (cursorMoves ? cursorMoves(cur) : cur),
      click: async (x, y, b, n) => { cur = { x, y }; log.push(['click', x, y, b, n]); },
      scroll: async (x, y, c, h) => { cur = { x, y }; log.push(['scroll', x, y, c, h]); },
      type: async t => log.push(['type', t]),
      keys: async v => log.push(['keys', v.join('+')]),
    },
  };
}

test('runner turns steps into input at the right spots', async () => {
  const log = [];
  const task = {
    viewport: { kind: 'window', hwnd: 42 }, repeat: 2,
    steps: [
      { type: 'click', fx: 0, fy: 0 },
      { type: 'type', fx: 0.5, fy: 0.5, text: 'run {run}', enter: true },
      { type: 'scroll', fx: 1, fy: 1, direction: 'down', clicks: 3 },
      { type: 'key', keys: 'ctrl+s' },
      { type: 'wait', ms: 100 },
      { type: 'click', fx: 0.5, fy: 0.5, disabled: true },
    ],
  };
  const r = await runTask(task, fakeDeps(log), { run: 7 });
  assert.deepEqual(r, { steps: 10, rounds: 2, ended: false, notes: [] });
  const input = log.filter(l => l[0] !== 'step');
  assert.deepEqual(input.slice(0, 7), [
    ['focus', 42],
    ['click', 100, 50, 'left', 1],
    ['click', 600, 300, 'left', 1], ['type', 'run 7'], ['keys', '13'],
    ['scroll', 1099, 549, -3, false],
    ['keys', '17+83'],
  ]);
});

test('rehearsal sends no input; failsafe stops on mouse movement; AI find replaces the spot', async () => {
  const log = [];
  await runTask({ viewport: { kind: 'window' }, steps: [{ type: 'click', fx: 0.5, fy: 0.5 }, { type: 'type', text: 'x' }] }, fakeDeps(log), { rehearse: true });
  assert.ok(log.every(l => l[0] === 'step'), 'only step reports');

  const log2 = [];
  const deps = fakeDeps(log2, { cursorMoves: c => ({ x: c.x + 200, y: c.y }) });
  await assert.rejects(runTask({ viewport: { kind: 'screen' }, steps: [{ type: 'click', fx: 0.1, fy: 0.1 }, { type: 'click', fx: 0.2, fy: 0.2 }] }, deps), e => e instanceof Stopped && /moved the mouse/.test(e.message));
  assert.equal(log2.filter(l => l[0] === 'click').length, 1);

  const log3 = [];
  await runTask({ viewport: { kind: 'screen' }, steps: [{ type: 'click', find: 'the Send button' }] }, fakeDeps(log3, { find: () => ({ fx: 1, fy: 0 }) }));
  assert.deepEqual(log3.find(l => l[0] === 'click'), ['click', 1099, 50, 'left', 1]);
  await assert.rejects(runTask({ viewport: { kind: 'screen' }, steps: [{ type: 'click', find: 'ghost' }] }, fakeDeps([])), /could not find "ghost"/);

  await assert.rejects(runTask({ steps: [] }, fakeDeps([])), /no steps/);
  await assert.rejects(runTask({ steps: [{ type: 'click' }] }, fakeDeps([])), /Step 1: Pick a spot/);
  const ac = new AbortController(); ac.abort(new Error('Stopped by Ctrl+Alt+X.'));
  await assert.rejects(runTask({ viewport: {}, steps: [{ type: 'wait', ms: 1 }] }, fakeDeps([]), { signal: ac.signal }), /Ctrl\+Alt\+X/);
});

test('step texts', () => {
  assert.equal(expandText('{date} {time} #{run}', { now: new Date(2026, 0, 2, 3, 4).getTime(), run: 5 }), '2026-01-02 03:04 #5');
  assert.equal(describeStep({ type: 'click', count: 2 }), 'Double-click');
  assert.equal(describeStep({ type: 'wait', ms: 1500 }), 'Wait 1.5 s');
  assert.equal(stepProblem({ type: 'type', text: '' }), 'Enter the text to type.');
  assert.equal(stepProblem({ type: 'type', text: '', enter: true }), null);
});

test('scheduler fires due timers one task at a time', async () => {
  let t = 1_000_000;
  const ran = [];
  const tasks = [
    { id: 'a', triggers: [{ kind: 'interval', every: 1, unit: 's', maxRuns: 2 }] },
    { id: 'b', triggers: [{ kind: 'once', at: new Date(t + 1500).toISOString() }] },
    { id: 'c', enabled: false, triggers: [{ kind: 'interval', every: 1, unit: 's' }] },
  ];
  let release;
  const s = new Scheduler({ tasks: () => tasks, now: () => t, tickMs: 1e9, runTask: async task => { ran.push(task.id); await new Promise(r => (release = r)); } });
  s.start(); s.stop();
  assert.equal(tasks[0].triggers[0].next, t + 1000);
  assert.equal(tasks[2].triggers[0].next, null);
  t += 1000; s.tick();
  assert.deepEqual(ran, ['a']);
  t += 600; s.tick();                     // b is due but a is still running
  assert.deepEqual(ran, ['a']);
  release(); await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(tasks[1].triggers[0].enabled, false);
  release(); await new Promise(r => setTimeout(r, 5));
  t += 2000; s.tick(); release(); await new Promise(r => setTimeout(r, 5));
  t += 2000; s.tick();
  assert.deepEqual(ran, ['a', 'b', 'a'], 'maxRuns 2 stops a');
});

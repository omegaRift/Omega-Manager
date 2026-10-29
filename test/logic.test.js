// Groups, If/Else, Loops and Stop: the step tree and how the runner walks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTask, evalCond, T, stepProblem } from '../lib/runner.js';

let n = 0;
const id = () => 'id' + ++n;
const click = (fx, extra = {}) => ({ id: id(), type: 'click', fx, fy: 0.5, after: 0, ...extra });
const typeStep = text => ({ id: id(), type: 'type', text, after: 0 });

function deps({ windows = [], pixel = [0, 0, 0], sees = () => false, log = [] } = {}) {
  let cur = { x: 0, y: 0 };
  return {
    log,
    resolve: async () => ({ rect: { x: 0, y: 0, w: 101, h: 101 } }),
    aiFind: async () => null,
    sleep: async () => {},
    onStep: (s, p) => log.push(['on', s.type, p.result ?? p.round ?? null]),
    check: { windows: async () => windows, pixel: async () => pixel, aiSees: async (vp, d) => sees(d) },
    input: {
      focus: async () => {}, cursor: async () => cur,
      click: async (x, y) => { cur = { x, y }; log.push(['click', x]); },
      scroll: async () => {}, type: async t => log.push(['type', t]), keys: async () => {},
    },
  };
}
const clicks = log => log.filter(l => l[0] === 'click').map(l => l[1]);

test('tree: find, move, insert, unwrap, labels, clone', () => {
  const a = click(0.1), b = click(0.2), c = click(0.3);
  const loop = { id: 'L', type: 'loop', mode: 'times', times: 2, children: [b] };
  const iff = { id: 'I', type: 'if', cond: { kind: 'time', from: '00:00', to: '23:59' }, children: [], else: [c] };
  const steps = [a, loop, iff];
  assert.equal(T.find(steps, b.id).parent.id, 'L');
  assert.equal(T.find(steps, c.id).branch, 'else');
  const lab = T.labels(steps);
  assert.deepEqual([a, loop, b, iff, c].map(s => lab.get(s.id)), ['1', '2', '2.1', '3', '3.1']);
  // Move a into the loop, before b.
  assert.ok(T.move(steps, a.id, { ref: b.id, where: 'before' }));
  assert.deepEqual(loop.children.map(s => s.id), [a.id, b.id]);
  // Move the loop into the If's Then branch, then try to move the If into the loop inside it.
  assert.ok(T.move(steps, 'L', { parent: 'I', branch: 'children' }));
  assert.equal(T.find(steps, 'L').parent.id, 'I');
  assert.equal(T.move(steps, 'I', { parent: 'L', branch: 'children' }), false, 'cannot drop a step into itself');
  assert.equal(T.move(steps, 'I', { ref: b.id, where: 'after' }), false);
  assert.equal(steps.length, 1);
  // Move c from Else to the top level, first.
  assert.ok(T.move(steps, c.id, { parent: null, index: 0 }));
  assert.deepEqual(steps.map(s => s.id), [c.id, 'I']);
  // Unwrap the If: its Then (the loop) replaces it.
  assert.ok(T.unwrap(steps, 'I'));
  assert.deepEqual(steps.map(s => s.id), [c.id, 'L']);
  const copy = T.cloneFresh(steps[1], id);
  assert.notEqual(copy.id, 'L');
  assert.notEqual(copy.children[0].id, a.id);
  assert.equal(copy.children.length, 2);
  // Pins: action spots plus colour-check spots.
  const px = { id: id(), type: 'if', cond: { kind: 'pixel', fx: 0.4, fy: 0.4, color: '#ff0000' }, children: [click(0.9)], else: [] };
  const sp = T.spots([px]);
  assert.deepEqual(sp.map(p => [p.kind, p.label]), [['cond', '1'], ['step', '1.1']]);
});

test('checks for logic steps', () => {
  assert.equal(stepProblem({ type: 'if', cond: { kind: 'ai', describe: '' } }), 'Describe what the AI should look for.');
  assert.equal(stepProblem({ type: 'if', cond: { kind: 'pixel', fx: 0.1, fy: 0.1 } }), 'Pick the colour to compare with.');
  assert.equal(stepProblem({ type: 'loop', mode: 'times', times: 0 }), 'Repeat at least 1 time.');
  assert.equal(stepProblem({ type: 'loop', mode: 'while', max: 5, cond: { kind: 'window', text: 'x' } }), null);
  assert.equal(stepProblem({ type: 'loop', mode: 'until', max: 0, cond: { kind: 'window', text: 'x' } }), 'Set the most rounds the loop may run (1 or more).');
  assert.equal(stepProblem({ type: 'key', keys: 'ctrl+banana' }), '"banana" is not a key name this app knows.');
  // The first problem is reported with its tree number, and skipped steps are ignored.
  const steps = [{ id: 'a', type: 'group', children: [{ id: 'b', type: 'click', disabled: true }, { id: 'c', type: 'wait', ms: 1 }, { id: 'd', type: 'click' }] }];
  assert.deepEqual(T.firstProblem(steps), { id: 'd', label: '1.3', message: 'Pick a spot on the viewport.' });
  assert.equal(T.describeStep({ type: 'loop', mode: 'until', cond: { kind: 'window', text: 'Done', not: true } }), 'Repeat until no window with "Done" is open');
  assert.equal(T.describeStep({ type: 'if', cond: { kind: 'ai', describe: 'a Save button' } }), 'If the AI sees "a Save button"');
});

test('conditions', async () => {
  const d = deps({ windows: [{ title: 'notes.txt - Notepad', process: 'Notepad' }], pixel: [250, 10, 12], sees: x => x === 'yes' });
  const at = h => new Date(2026, 9, 29, h, 30).getTime();
  assert.equal((await evalCond({ kind: 'time', from: '09:00', to: '17:00' }, {}, d, at(10))).result, true);
  assert.equal((await evalCond({ kind: 'time', from: '09:00', to: '17:00' }, {}, d, at(18))).result, false);
  assert.equal((await evalCond({ kind: 'time', from: '22:00', to: '06:00' }, {}, d, at(2))).result, true, 'overnight range');
  assert.equal((await evalCond({ kind: 'time', from: '22:00', to: '06:00', not: true }, {}, d, at(2))).result, false);
  assert.deepEqual(await evalCond({ kind: 'window', text: 'notepad' }, {}, d), { result: true, detail: 'found "notes.txt - Notepad"' });
  assert.equal((await evalCond({ kind: 'window', text: 'Excel' }, {}, d)).result, false);
  assert.deepEqual(await evalCond({ kind: 'pixel', fx: 0, fy: 0, color: '#ff0000', tolerance: 20 }, {}, d), { result: true, detail: 'the spot is #fa0a0c' });
  assert.equal((await evalCond({ kind: 'pixel', fx: 0, fy: 0, color: '#ff0000', tolerance: 3 }, {}, d)).result, false);
  assert.equal((await evalCond({ kind: 'ai', describe: 'yes' }, {}, d)).result, true);
  assert.equal((await evalCond({ kind: 'ai', describe: 'no', not: true }, {}, d)).result, true);
  await assert.rejects(evalCond({ kind: 'window', text: '' }, {}, d), /Enter part of the window title/);
});

test('if / else picks one branch', async () => {
  const mk = text => [{ id: id(), type: 'if', cond: { kind: 'window', text }, children: [click(0.1)], else: [click(0.9)] }];
  const d1 = deps({ windows: [{ title: 'Inbox', process: 'olk' }] });
  await runTask({ viewport: {}, steps: mk('Inbox') }, d1);
  assert.deepEqual(clicks(d1.log), [10]);
  const d2 = deps();
  await runTask({ viewport: {}, steps: mk('Inbox') }, d2);
  assert.deepEqual(clicks(d2.log), [90]);
  assert.deepEqual(d2.log[0], ['on', 'if', false]);
});

test('loops: times, {loop} in text, nested, while with a limit, until', async () => {
  const d = deps();
  const r = await runTask({ viewport: {}, steps: [{ id: id(), type: 'loop', mode: 'times', times: 3, children: [typeStep('row {loop}'), { id: id(), type: 'loop', times: 2, children: [click(0.5)] }] }] }, d);
  assert.deepEqual(d.log.filter(l => l[0] === 'type').map(l => l[1]), ['row 1', 'row 2', 'row 3']);
  assert.equal(clicks(d.log).length, 6);
  assert.equal(r.steps, 9);

  // while a window is open: the window "closes" after 2 checks.
  let checks = 0;
  const d2 = deps();
  d2.check.windows = async () => (++checks <= 2 ? [{ title: 'Busy', process: 'x' }] : []);
  await runTask({ viewport: {}, steps: [{ id: id(), type: 'loop', mode: 'while', max: 50, cond: { kind: 'window', text: 'Busy' }, children: [click(0.2)] }] }, d2);
  assert.equal(clicks(d2.log).length, 2);

  // while forever -> stops at its limit and says so.
  const d3 = deps({ windows: [{ title: 'Busy', process: 'x' }] });
  const r3 = await runTask({ viewport: {}, steps: [{ id: 'W', type: 'loop', mode: 'while', max: 4, cond: { kind: 'window', text: 'Busy' }, children: [click(0.2)] }] }, d3);
  assert.equal(clicks(d3.log).length, 4);
  assert.deepEqual(r3.notes, ['loop 1 hit its limit of 4 rounds']);

  // until the AI sees "Done": seen on the 3rd check.
  let looks = 0;
  const d4 = deps({ sees: () => ++looks >= 3 });
  await runTask({ viewport: {}, steps: [{ id: id(), type: 'loop', mode: 'until', max: 10, cond: { kind: 'ai', describe: 'Done' }, children: [click(0.3)] }] }, d4);
  assert.equal(clicks(d4.log).length, 2);

  // Rehearsal never runs a loop more than 3 rounds.
  const d5 = deps();
  await runTask({ viewport: {}, steps: [{ id: id(), type: 'loop', times: 50, children: [click(0.3)] }] }, d5, { rehearse: true });
  assert.equal(d5.log.filter(l => l[0] === 'on' && l[1] === 'loop').length, 3);
});

test('stop: leaves the loop, or ends the task', async () => {
  // Loop 5 times; on round 3 an If (time always true... we use run-count via the AI fake) stops the loop.
  let round = 0;
  const d = deps({ sees: () => ++round === 3 });
  const steps = [
    { id: id(), type: 'loop', times: 5, children: [
      click(0.1),
      { id: id(), type: 'if', cond: { kind: 'ai', describe: 'end' }, children: [{ id: id(), type: 'stop', what: 'loop' }], else: [] },
    ] },
    click(0.9),
  ];
  const r = await runTask({ viewport: {}, steps }, d);
  assert.deepEqual(clicks(d.log), [10, 10, 10, 90], 'left the loop after round 3, then went on');
  assert.equal(r.ended, false);

  const d2 = deps();
  const r2 = await runTask({ viewport: {}, repeat: 3, steps: [click(0.1), { id: id(), type: 'stop', what: 'task' }, click(0.9)] }, d2);
  assert.deepEqual(clicks(d2.log), [10], 'ends the task, including later repeats');
  assert.equal(r2.ended, true);

  // Disabled containers are skipped with everything inside.
  const d3 = deps();
  await runTask({ viewport: {}, steps: [{ id: id(), type: 'group', disabled: true, children: [click(0.1)] }, click(0.5)] }, d3);
  assert.deepEqual(clicks(d3.log), [50]);
});

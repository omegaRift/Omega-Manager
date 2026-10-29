// Runs one task's steps. Everything that touches the OS comes in through `deps`, so tests use fakes.
// Steps form a tree (ui/step-tree.js): Group, If/Else and Loop hold other steps; Stop leaves a loop or the task.
import '../ui/step-tree.js';
import { toScreen } from './geometry.js';
import { parseCombo } from './keys.js';

export const T = globalThis.StepTree;
export const STEP_TYPES = ['click', 'type', 'scroll', 'key', 'wait', 'group', 'if', 'loop', 'stop'];
export const NEEDS_SPOT = new Set(['click', 'scroll']);
export const REHEARSAL_LOOP_LIMIT = 3;

export class Stopped extends Error { constructor(msg) { super(msg); this.stopped = true; } }
class BreakLoop extends Error { }
class EndTask extends Error { }

export const keyError = keys => parseCombo(keys).error || null;
export const stepProblem = s => T.stepProblem(s, keyError);
export const describeStep = s => T.describeStep(s);

const pad = n => String(n).padStart(2, '0');
export function expandText(text, ctx = {}) {
  const d = ctx.now ? new Date(ctx.now) : new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return String(text ?? '').replace(/\{(date|time|datetime|run|loop)\}/g, (_, k) =>
    k === 'date' ? date : k === 'time' ? time : k === 'datetime' ? `${date} ${time}` : k === 'run' ? String(ctx.run ?? 1) : String(ctx.loop ?? 1));
}

/**
 * Is a condition true right now? deps.check = {
 *   aiSees(viewport, describe) -> bool, pixel(viewport, fx, fy) -> [r,g,b], windows() -> [{title, process}] }
 * Returns { result, detail } where detail says what was seen.
 */
export async function evalCond(c, viewport, deps, now = Date.now()) {
  const p = T.condProblem(c);
  if (p) throw new Error(p);
  let r, detail = '';
  if (c.kind === 'time') { r = T.inTimeRange(c.from, c.to, new Date(now)); detail = `it is ${new Date(now).toTimeString().slice(0, 5)}`; }
  else if (c.kind === 'window') {
    const needle = c.text.trim().toLowerCase();
    const hit = (await deps.check.windows()).find(w => `${w.title} ${w.process}`.toLowerCase().includes(needle));
    r = !!hit; detail = hit ? `found "${hit.title}"` : 'no such window';
  } else if (c.kind === 'pixel') {
    const rgb = await deps.check.pixel(viewport, c.fx, c.fy);
    r = T.colorClose(rgb, c.color, Number(c.tolerance ?? 30));
    detail = `the spot is ${T.rgbHex(rgb)}`;
  } else if (c.kind === 'ai') {
    r = !!(await deps.check.aiSees(viewport, c.describe));
    detail = r ? 'the AI found it' : 'the AI did not find it';
  }
  return { result: c.not ? !r : r, detail };
}

/**
 * deps: {
 *   resolve(viewport) -> { rect:{x,y,w,h}, hwnd? }   throws a plain-language Error if it is gone
 *   input: { focus(hwnd), cursor(), click(x,y,button,count), scroll(x,y,clicks,horizontal), type(text,delay), keys(vks) }
 *   aiFind(viewport, describe) -> { fx, fy } | null
 *   check: see evalCond
 *   sleep(ms, signal)
 *   onStep(step, info)   info: { x, y, fx, fy } for actions, { result, detail } for If, { round } for Loop
 * }
 * opts: { rehearse, failsafe, signal, run, typeDelay, now }
 */
export async function runTask(task, deps, opts = {}) {
  const { rehearse = false, failsafe = true, signal, typeDelay = 15 } = opts;
  const steps = task.steps || [];
  if (!T.active(steps).length) throw new Error('This task has no steps yet.');
  const problem = T.firstProblem(steps, keyError);
  if (problem) throw new Error(`Step ${problem.label}: ${problem.message}`);
  const rounds = Math.max(1, Math.min(10000, Number(task.repeat) || 1));
  const check = () => { if (signal?.aborted) throw new Stopped(signal.reason?.message || 'Stopped.'); };
  const lab = T.labels(steps);
  const ctx = { loops: [], actions: 0, notes: [], ended: false };
  let lastPos = null;

  const watchMouse = async () => {
    if (!failsafe || rehearse || !lastPos) return;
    const now = await deps.input.cursor();
    if (Math.hypot(now.x - lastPos.x, now.y - lastPos.y) > 25) throw new Stopped('You moved the mouse, so the run stopped (safety stop).');
  };
  const cond = async c => evalCond(c, task.viewport, deps, opts.now ? opts.now() : Date.now());

  async function action(s) {
    await watchMouse();
    const view = await deps.resolve(task.viewport);          // the window may have moved since the last step
    let fx = s.fx, fy = s.fy;
    if (s.find && (NEEDS_SPOT.has(s.type) || s.type === 'type')) {
      const hit = await deps.aiFind(task.viewport, s.find);
      check();
      if (hit) ({ fx, fy } = hit);
      else if (!(Number.isFinite(fx) && Number.isFinite(fy))) throw new Error(`Step ${lab.get(s.id)}: the AI could not find "${s.find}" on the viewport.`);
    }
    const hasSpot = Number.isFinite(fx) && Number.isFinite(fy);
    const p = hasSpot ? toScreen(view.rect, fx, fy) : null;
    deps.onStep?.(s, { ...(p || {}), fx, fy });

    if (!rehearse) {
      const inp = deps.input;
      if (s.type === 'click') {
        await inp.click(p.x, p.y, s.button || 'left', s.count === 2 ? 2 : 1); lastPos = p;
      } else if (s.type === 'scroll') {
        const n = Math.round(Number(s.clicks) || 3);
        const dir = s.direction || 'down';
        await inp.scroll(p.x, p.y, dir === 'down' || dir === 'left' ? -n : n, dir === 'left' || dir === 'right'); lastPos = p;
      } else if (s.type === 'type') {
        if (p && s.clickFirst !== false) { await inp.click(p.x, p.y, 'left', 1); lastPos = p; await deps.sleep(120, signal); }
        if (s.selectAll) { await inp.keys([0x11, 0x41]); await deps.sleep(40, signal); }
        const text = expandText(s.text, { run: opts.run, loop: ctx.loops.at(-1) });
        if (text) await inp.type(text, typeDelay);
        if (s.enter) await inp.keys([0x0D]);
      } else if (s.type === 'key') {
        await inp.keys(parseCombo(s.keys).vks);
      }
    }
    if (s.type === 'wait') await deps.sleep(Number(s.ms) || 0, signal);
    ctx.actions++;
    const after = s.after ?? 300;
    if (after > 0) await deps.sleep(after, signal);
  }

  async function runList(list) {
    for (const s of list || []) {
      if (s.disabled) continue;
      check();
      await runStep(s);
    }
  }

  async function runStep(s) {
    if (s.type === 'group') return runList(s.children);
    if (s.type === 'if') {
      const c = await cond(s.cond);
      check();
      deps.onStep?.(s, c);
      return runList(c.result ? s.children : s.else);
    }
    if (s.type === 'loop') {
      const mode = s.mode || 'times';
      let max = mode === 'times' ? Math.round(Number(s.times) || 1) : Math.round(Number(s.max) || 100);
      max = Math.max(1, Math.min(100000, max));
      if (rehearse) max = Math.min(max, REHEARSAL_LOOP_LIMIT);
      let round = 0;
      for (; round < max; round++) {
        check();
        if (mode !== 'times') {
          const c = await cond(s.cond);
          check();
          if (mode === 'while' ? !c.result : c.result) break;
        }
        deps.onStep?.(s, { round: round + 1 });
        ctx.loops.push(round + 1);
        try { await runList(s.children); }
        catch (e) { if (e instanceof BreakLoop) { round++; break; } throw e; }
        finally { ctx.loops.pop(); }
      }
      if (mode !== 'times' && round >= max && !rehearse) ctx.notes.push(`loop ${lab.get(s.id)} hit its limit of ${max} rounds`);
      return;
    }
    if (s.type === 'stop') {
      deps.onStep?.(s, {});
      throw s.what === 'task' || !ctx.loops.length ? new EndTask() : new BreakLoop();
    }
    return action(s);
  }

  let view = await deps.resolve(task.viewport);
  if (!rehearse && task.viewport?.kind === 'window' && task.focus !== false && view.hwnd) {
    await deps.input.focus(view.hwnd);
    await deps.sleep(150, signal);
  }

  let done = 0;
  for (; done < rounds; done++) {
    try { await runList(steps); }
    catch (e) { if (e instanceof EndTask) { ctx.ended = true; done++; break; } throw e; }
  }
  return { steps: ctx.actions, rounds: done, ended: ctx.ended, notes: ctx.notes };
}

// Sleep that wakes early (and throws Stopped) when the signal fires.
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped(signal.reason?.message || 'Stopped.'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(t); reject(new Stopped(signal.reason?.message || 'Stopped.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

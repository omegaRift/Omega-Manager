// Steps form a tree: Group, If and Loop steps hold other steps. Shared by the window (classic <script>)
// and the main process (imported for its side effect), so both read steps the same way.
// Exposes globalThis.StepTree.
(function (root) {
  'use strict';

  const CONTAINERS = ['group', 'if', 'loop'];
  const isContainer = s => !!s && CONTAINERS.includes(s.type);
  // Child lists of a step: an If has "children" (then) and "else"; Group and Loop only "children".
  const branches = s => (s && s.type === 'if' ? ['children', 'else'] : isContainer(s) ? ['children'] : []);
  const listOf = (s, b) => (Array.isArray(s[b]) ? s[b] : (s[b] = []));

  // Calls fn(step, info) depth first. info = { list, index, parent, branch, depth }. Return false to skip children.
  function walk(list, fn, parent = null, branch = null, depth = 0) {
    for (let i = 0; i < (list || []).length; i++) {
      const s = list[i];
      if (fn(s, { list, index: i, parent, branch, depth }) === false) continue;
      for (const b of branches(s)) walk(listOf(s, b), fn, s, b, depth + 1);
    }
  }

  function find(list, id) {
    let hit = null;
    walk(list, (s, info) => { if (hit) return false; if (s.id === id) { hit = { step: s, ...info }; return false; } });
    return hit;
  }

  // True if `id` is the step itself or anywhere inside it.
  function contains(step, id) {
    if (!step) return false;
    if (step.id === id) return true;
    let hit = false;
    for (const b of branches(step)) walk(listOf(step, b), s => { if (s.id === id) hit = true; return !hit; });
    return hit;
  }

  function remove(list, id) {
    const f = find(list, id);
    if (!f) return null;
    f.list.splice(f.index, 1);
    return f.step;
  }

  // target: { ref: id, where: 'before'|'after' }   next to another step
  //      or { parent: id|null, branch: 'children'|'else', index?: n }   into a list (null parent = top level)
  function targetList(list, target) {
    if (target.ref) {
      const f = find(list, target.ref);
      if (!f) return null;
      return { list: f.list, index: f.index + (target.where === 'after' ? 1 : 0), parent: f.parent };
    }
    if (target.parent == null) return { list, index: target.index ?? list.length, parent: null };
    const p = find(list, target.parent);
    if (!p || !isContainer(p.step)) return null;
    const b = branches(p.step).includes(target.branch) ? target.branch : 'children';
    const l = listOf(p.step, b);
    return { list: l, index: target.index ?? l.length, parent: p.step };
  }

  function insert(list, step, target = { parent: null }) {
    const t = targetList(list, target);
    if (!t) return false;
    t.list.splice(Math.max(0, Math.min(t.index, t.list.length)), 0, step);
    return true;
  }

  // Moves a step (with everything inside it). Refuses to drop a step into itself.
  function move(list, id, target) {
    const f = find(list, id);
    if (!f) return false;
    if (target.ref && contains(f.step, target.ref)) return false;
    if (target.parent && contains(f.step, target.parent)) return false;
    f.list.splice(f.index, 1);
    if (insert(list, f.step, target)) return true;
    f.list.splice(f.index, 0, f.step);   // put it back
    return false;
  }

  // Replaces a container with its own steps (Then first, then Else).
  function unwrap(list, id) {
    const f = find(list, id);
    if (!f || !isContainer(f.step)) return false;
    const inner = branches(f.step).flatMap(b => listOf(f.step, b));
    f.list.splice(f.index, 1, ...inner);
    return true;
  }

  function cloneFresh(step, uid) {
    const c = JSON.parse(JSON.stringify(step));
    const renew = s => { s.id = uid(); for (const b of branches(s)) listOf(s, b).forEach(renew); };
    renew(c);
    return c;
  }

  // "1", "2", "2.1", "2.2" ... Inside an If, Then and Else are numbered on from each other.
  function labels(list) {
    const out = new Map();
    const go = (l, prefix) => l.forEach((s, i) => {
      const lab = prefix + (i + 1);
      out.set(s.id, lab);
      if (isContainer(s)) go(branches(s).flatMap(b => listOf(s, b)), lab + '.');
    });
    go(list || [], '');
    return out;
  }

  // Steps that will actually run (skips disabled steps and everything inside a disabled container).
  function active(list) {
    const out = [];
    walk(list, s => { if (s.disabled) return false; out.push(s); });
    return out;
  }

  // ---------- conditions ----------
  // { kind: 'ai', describe }               the AI can see something on the viewport
  // { kind: 'pixel', fx, fy, color, tolerance }   the colour at a spot (0..1 fractions, '#rrggbb')
  // { kind: 'window', text }               a window whose title or program contains the text is open
  // { kind: 'time', from: 'HH:MM', to: 'HH:MM' }   the time of day is in this range (may cross midnight)
  // not: true flips the answer.
  const COND_KINDS = { ai: 'The AI sees…', pixel: 'The colour at a spot is…', window: 'A window is open…', time: 'The time is between…' };
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  function condProblem(c) {
    if (!c || !COND_KINDS[c.kind]) return 'Choose what to check.';
    if (c.kind === 'ai' && !String(c.describe || '').trim()) return 'Describe what the AI should look for.';
    if (c.kind === 'pixel') {
      if (!(Number.isFinite(c.fx) && Number.isFinite(c.fy))) return 'Pick the spot whose colour to check.';
      if (!/^#[0-9a-f]{6}$/i.test(c.color || '')) return 'Pick the colour to compare with.';
    }
    if (c.kind === 'window' && !String(c.text || '').trim()) return 'Enter part of the window title or program name.';
    if (c.kind === 'time' && !(HHMM.test(c.from || '') && HHMM.test(c.to || ''))) return 'Enter both times, like 09:00 and 17:30.';
    return null;
  }

  function describeCond(c) {
    if (!c || !COND_KINDS[c.kind]) return '…';
    const n = !!c.not;
    if (c.kind === 'ai') return `${n ? 'the AI does not see' : 'the AI sees'} "${c.describe || '…'}"`;
    if (c.kind === 'pixel') return `the colour at the spot ${n ? 'is not' : 'is'} ${c.color || '…'}`;
    if (c.kind === 'window') return `${n ? 'no window' : 'a window'} with "${c.text || '…'}" is open`;
    if (c.kind === 'time') return `the time ${n ? 'is not' : 'is'} ${c.from || '…'}–${c.to || '…'}`;
    return '…';
  }

  function inTimeRange(from, to, date) {
    const m = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const t = date.getHours() * 60 + date.getMinutes();
    const a = m(from), b = m(to);
    return a <= b ? t >= a && t < b : t >= a || t < b;   // b < a: crosses midnight
  }

  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const colorClose = (rgb, hex, tol = 30) => { const t = hexRgb(hex); return rgb.every((v, i) => Math.abs(v - t[i]) <= tol); };
  const rgbHex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  // ---------- describing and checking steps ----------
  function describeStep(s) {
    const where = s.find ? ` · AI: ${s.find}` : '';
    switch (s.type) {
      case 'click': return (s.count === 2 ? 'Double-click' : s.button === 'right' ? 'Right-click' : s.button === 'middle' ? 'Middle-click' : 'Click') + (s.name ? ` "${s.name}"` : '') + where;
      case 'type': return `Type "${String(s.text || '').replace(/\n/g, '⏎').slice(0, 40)}"${s.enter ? ' + Enter' : ''}${s.name ? ` in "${s.name}"` : ''}${where}`;
      case 'scroll': return `Scroll ${s.direction || 'down'} ${s.clicks || 3}` + where;
      case 'key': return `Press ${s.keys || '…'}`;
      case 'wait': return `Wait ${+((Number(s.ms) || 0) / 1000).toFixed(2)} s`;
      case 'group': return s.name ? s.name : 'Group';
      case 'if': return `If ${describeCond(s.cond)}`;
      case 'loop':
        if (s.mode === 'while') return `Repeat while ${describeCond(s.cond)}`;
        if (s.mode === 'until') return `Repeat until ${describeCond(s.cond)}`;
        return `Repeat ${Number(s.times) || 1} time${Number(s.times) === 1 ? '' : 's'}`;
      case 'stop': return s.what === 'task' ? 'Stop the task' : 'Stop the loop';
    }
    return s.type;
  }

  // keyError(text) -> message or null; the window and main check key names their own way.
  function stepProblem(s, keyError) {
    const spot = Number.isFinite(s.fx) && Number.isFinite(s.fy);
    switch (s.type) {
      case 'click': case 'scroll':
        if (!spot && !s.find) return 'Pick a spot on the viewport.';
        if (s.type === 'scroll' && !(Number(s.clicks) >= 1)) return 'Scroll at least 1 notch.';
        return null;
      case 'type': return !String(s.text ?? '').length && !s.enter ? 'Enter the text to type.' : null;
      case 'key': return keyError ? keyError(s.keys) : null;
      case 'wait': return Number(s.ms) >= 0 ? null : 'Wait needs a number of seconds.';
      case 'group': case 'stop': return null;
      case 'if': return condProblem(s.cond);
      case 'loop':
        if (!s.mode || s.mode === 'times') return Number(s.times) >= 1 ? null : 'Repeat at least 1 time.';
        if (!(Number(s.max) >= 1)) return 'Set the most rounds the loop may run (1 or more).';
        return condProblem(s.cond);
    }
    return `Unknown step "${s.type}".`;
  }

  // First problem among the steps that will run, as "Step 2.1: …", or null.
  function firstProblem(list, keyError) {
    const lab = labels(list);
    for (const s of active(list)) {
      const p = stepProblem(s, keyError);
      if (p) return { id: s.id, label: lab.get(s.id), message: p };
    }
    return null;
  }

  // Every step with a spot on the viewport (for pins), plus pixel-condition spots.
  function spots(list) {
    const lab = labels(list);
    const out = [];
    walk(list, (s, info) => {
      const off = s.disabled;
      if (Number.isFinite(s.fx) && Number.isFinite(s.fy)) out.push({ step: s, kind: 'step', fx: s.fx, fy: s.fy, label: lab.get(s.id), off });
      const c = s.cond;
      if ((s.type === 'if' || (s.type === 'loop' && s.mode && s.mode !== 'times')) && c && c.kind === 'pixel' && Number.isFinite(c.fx)) {
        out.push({ step: s, kind: 'cond', fx: c.fx, fy: c.fy, label: lab.get(s.id), off, color: c.color });
      }
    });
    return out;
  }

  root.StepTree = {
    CONTAINERS, COND_KINDS, isContainer, branches, walk, find, contains, remove, insert, move, unwrap, cloneFresh,
    labels, active, condProblem, describeCond, inTimeRange, colorClose, hexRgb, rgbHex, describeStep, stepProblem, firstProblem, spots,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

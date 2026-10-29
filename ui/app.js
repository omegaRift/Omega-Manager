/* Omega Manager window. Talks to the main process only through window.ap (preload.cjs). */
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const clamp01 = v => Math.min(1, Math.max(0, v));

const TYPE_NAMES = { textbox: 'Text box', textarea: 'Text area', dropdown: 'Dropdown', checkbox: 'Checkbox', radio: 'Radio button', button: 'Button', link: 'Link', slider: 'Slider', other: 'Control' };
const STEP_ICON = { click: 'click', type: 'type', scroll: 'scroll', key: 'key', wait: 'clock', group: 'group', if: 'branch', loop: 'repeat', stop: 'stop' };
const SPOT_TYPES = new Set(['click', 'type', 'scroll']);
const TOOL_KEYS = { v: 'select', c: 'click', d: 'double', r: 'right', t: 'type', s: 'scroll' };
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const S = { tasks: [], settings: {}, history: [], running: null, paused: false, queue: [], hotkey: 'Ctrl+Alt+X', hotkeyOk: true, reminders: [] };
let selId = null, draft = null, selStep = null, tool = 'select', repickStep = null, repickWhat = 'step';
let found = new Map();            // taskId -> { items, method }
let view = { w: 0, h: 0, ok: false, error: '' };
let stream = null, frozen = false, previewToken = 0;
let tab = 'steps';
let runningStep = null;
const unsaved = new Set();      // tasks made here that main has not stored yet

// ---------- night mode ----------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function renderThemeBtn() {
  const b = $('themeBtn'); if (!b) return;
  const night = darkQuery.matches;
  b.innerHTML = icon(night ? 'sun' : 'moon');
  b.title = night ? 'Day mode' : 'Night mode';
  b.setAttribute('aria-label', b.title);
  b.classList.toggle('on', night);
}
darkQuery.addEventListener('change', renderThemeBtn);

// ---------- helpers ----------
let toastTimer;
function toast(msg, err = false, ms = 3800) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
async function tryIt(fn) { try { return await fn(); } catch (e) { toast(e.message, true, 6000); return undefined; } }

function fmtIn(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m} min ${s % 60 ? (s % 60) + ' s' : ''}`.trim();
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} h ${m % 60} min`;
  return `in ${Math.floor(h / 24)} d ${h % 24} h`;
}
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayClock = ms => {
  const d = new Date(ms), now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? clock(ms) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

const KNOWN_KEYS = /^(ctrl|control|shift|alt|win|windows|meta|cmd|enter|return|tab|esc|escape|space|backspace|delete|del|insert|ins|home|end|pageup|pgup|pagedown|pgdn|up|down|left|right|capslock|printscreen|menu|apps|pause|plus|minus|comma|period|volumeup|volumedown|mute|playpause|nexttrack|prevtrack|[a-z0-9]|f([1-9]|1\d|2[0-4])|num[0-9]|[=\-,./;'[\]\\`])$/;
function keyError(keys) {
  const raw = String(keys || '').trim();
  if (!raw) return 'Enter a key, for example Enter or Ctrl+S.';
  const parts = raw.replace(/\+\+$/, '+plus').split('+').map(x => x.trim().toLowerCase()).filter(Boolean);
  const bad = parts.find(p => !KNOWN_KEYS.test(p));
  return bad ? `"${bad}" is not a key name this app knows.` : null;
}
const describeStep = s => window.StepTree.describeStep(s);
const stepProblem = s => window.StepTree.stepProblem(s, keyError);

// ---------- state from main ----------
function applyState(st) {
  Object.assign(S, st);
  if (draft) {
    const srv = S.tasks.find(t => t.id === draft.id);
    if (!srv && unsaved.has(draft.id)) S.tasks.push(clone(draft));
    else if (!srv) { draft = null; selId = null; }
    else {
      // Only runtime fields come back into the draft; what the user is editing is never overwritten.
      draft.runCount = srv.runCount;
      for (const tr of draft.triggers || []) {
        const st2 = (srv.triggers || []).find(x => x.id === tr.id);
        if (st2) { tr.next = st2.next; tr.runs = st2.runs; tr.lastRun = st2.lastRun; tr.missed = st2.missed; if (tr.kind === 'once' && st2.enabled === false && tr.enabled !== false && st2.runs) tr.enabled = false; }
      }
      if (srv.viewport && draft.viewport && srv.viewport.hwnd !== draft.viewport.hwnd) {
        draft.viewport = srv.viewport;            // e.g. a timer run opened the window again
        if (!view.ok) setTimeout(startPreview, 0);
      }
    }
  }
  renderStatus(); renderTaskList(); renderTimerNext(); renderHistory(); MyTimers.render();
  if (!draft) renderEditor();
}

function renderStatus() {
  const run = S.running && S.tasks.find(t => t.id === S.running.taskId);
  const el = $('status');
  if (run) {
    el.innerHTML = `<span class="pill running"><span class="dot"></span>${S.running.rehearse ? 'Rehearsing' : 'Running'} "${esc(run.name)}"<button class="btn sm stop" id="stopBtn">${icon('stop')}Stop</button></span>`;
    $('stopBtn').onclick = () => ap.stopAll();
  } else {
    const timers = S.tasks.filter(t => t.enabled !== false && (t.triggers || []).some(tr => tr.next)).length;
    el.innerHTML = `<span class="pill ${S.paused ? 'paused' : ''}"><span class="dot"></span>${S.paused ? 'Timers paused' : timers ? `${timers} task${timers === 1 ? '' : 's'} on a timer` : 'Ready'}${S.queue?.length ? ` · ${S.queue.length} waiting` : ''}</span>`;
  }
  renderThemeBtn();
  $('pauseBtn').innerHTML = S.paused ? `${icon('play')}Resume timers` : `${icon('pause')}Pause timers`;
  $('hotkeyHint').innerHTML = S.hotkeyOk ? `Emergency stop: ${S.hotkey.split('+').map(k => `<kbd>${k}</kbd>`).join('+')}` : `<span class="problem">${icon('alert')}${esc(S.hotkey)} is taken by another app</span>`;
  $('runBtn').disabled = !!S.running;
  $('rehearseBtn').disabled = !!S.running;
}

function nextOf(t) {
  if (t.enabled === false) return null;
  const n = (t.triggers || []).map(tr => tr.enabled !== false && tr.next).filter(Boolean);
  return n.length ? Math.min(...n) : null;
}

function renderTaskList() {
  const ul = $('taskList');
  if (!S.tasks.length) {
    ul.innerHTML = `<li class="empty-list">No tasks yet. A task is a list of clicks, typing and scrolling on one screen or window, run by hand or on a timer.</li>`;
    return;
  }
  const now = Date.now();
  ul.innerHTML = S.tasks.map(t => {
    const vp = t.viewport;
    const where = !vp ? 'No viewport yet' : vp.kind === 'screen' ? vp.label : (vp.title || vp.label);
    const n = nextOf(t);
    const running = S.running?.taskId === t.id;
    const hasTimers = (t.triggers || []).length > 0;
    const next = running ? (S.running.rehearse ? 'Rehearsing…' : 'Running…') : !hasTimers ? 'No timer' : t.enabled === false ? 'Timers off' : S.paused ? 'Timers paused' : n ? `Next ${fmtIn(n - now)}` : 'Timers finished';
    return `<li class="task-item ${t.id === selId ? 'sel' : ''} ${running ? 'running' : ''}" data-id="${t.id}">
      <span class="name">${esc(t.name)}</span>
      ${hasTimers ? `<label class="toggle" title="Timers on/off"><input type="checkbox" data-en="${t.id}" ${t.enabled !== false ? 'checked' : ''}><span></span></label>` : '<span></span>'}
      <span class="meta">${icon(vp?.kind === 'window' ? 'window' : 'screen')}<span>${esc(where)}</span></span>
      <span class="next ${!n && !running ? 'off' : ''}">${esc(next)}</span>
    </li>`;
  }).join('');
}

// ---------- selecting / editing a task ----------
function selectTask(id) {
  if (selId === id && draft) return;
  flushSave();
  selId = id;
  const t = S.tasks.find(x => x.id === id);
  draft = t ? clone(t) : null;
  selStep = null; repickStep = null; closePopover();
  renderTaskList(); renderEditor(); startPreview();
}

function renderEditor() {
  $('editorEmpty').hidden = !!draft;
  $('editor').hidden = !draft;
  if (!draft) { renderViewportChip(); renderStage(); return; }
  $('taskName').value = draft.name;
  $('taskRepeat').value = draft.repeat || 1;
  $('taskFocus').checked = draft.focus !== false;
  $('focusOpt').hidden = draft.viewport?.kind !== 'window';
  $('reopenOpt').hidden = draft.viewport?.kind !== 'window';
  $('taskReopen').checked = !!draft.reopen;
  $('taskEnabled').checked = draft.enabled !== false;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.dataset.body !== tab;
  renderSteps(); renderTimers(); renderHistory(); renderViewportChip(); renderOverlay();
}

let saveTimer = null, savePending = false;
function saveSoon(ms = 350) { savePending = true; clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, ms); }
async function flushSave() {
  clearTimeout(saveTimer);
  if (!savePending || !draft) return;
  savePending = false;
  const sent = clone(draft);
  const saved = await tryIt(() => ap.saveTask(sent));
  if (!saved) return;
  const i = S.tasks.findIndex(t => t.id === saved.id);
  if (i >= 0) S.tasks[i] = saved; else S.tasks.push(saved);
  unsaved.delete(saved.id);
  if (draft && draft.id === saved.id) {
    for (const tr of draft.triggers || []) {
      const s2 = saved.triggers.find(x => x.id === tr.id);
      if (s2) { tr.next = s2.next; tr.problem = s2.problem; }
    }
  }
  renderTaskList(); renderTimerNext(); renderTimerProblems();
}

// ---------- steps (a tree: Group, If/Else and Loop hold other steps) ----------
const T = window.StepTree;
let insertHere = null;            // { parent, branch }: an empty list the user clicked, new steps go there
let dnd = null, dndGhost = null, dndJustDropped = 0;

const stepsOf = () => (draft.steps = draft.steps || []);
const findStep = id => (id ? T.find(stepsOf(), id) : null);
const countInside = s => { let n = 0; for (const b of T.branches(s)) T.walk(s[b] || [], () => { n++; }); return n; };
const COND_DEFAULTS = { ai: { describe: '' }, pixel: { tolerance: 30 }, window: { text: '' }, time: { from: '09:00', to: '17:00' } };

function renderSteps() {
  const ol = $('steps');
  const steps = stepsOf();
  let n = 0; T.walk(steps, () => { n++; });
  $('stepCount').textContent = n || '';
  if (!steps.length) {
    ol.innerHTML = `<li class="hint">No steps yet. Choose <b>Click</b>, <b>Type</b> or <b>Scroll</b> above the viewport and click where it should happen, or use <b>Find inputs</b> to let the AI mark the text boxes.</li>`;
    return;
  }
  const lab = T.labels(steps);
  ol.innerHTML = steps.map(s => stepHtml(s, lab)).join('') + `<li class="drop-end" data-parent="" data-branch="children">Drop here to move to the end</li>`;
  applyIcons(ol);
  const sel = findStep(selStep);
  if (sel) {
    const body = ol.querySelector(`[data-step="${selStep}"] > .step-body`);
    if (body) bindStepBody(body, sel.step);
  }
}

function stepHtml(s, lab) {
  const p = stepProblem(s);
  const open = s.id === selStep;
  const cont = T.isContainer(s);
  const inside = cont ? countInside(s) : 0;
  return `<li class="step t-${s.type} ${cont ? 'container' : ''} ${open ? 'sel' : ''} ${p ? 'bad' : ''} ${s.disabled ? 'off' : ''}" data-step="${s.id}">
    <div class="step-row">
      <span class="grip" data-grip title="Drag to move (into or out of a group, If or loop)">${icon('grip')}</span>
      <span class="step-num">${lab.get(s.id)}</span>
      <span class="step-sum">${icon(STEP_ICON[s.type] || 'click')}<span class="sum-text">${esc(describeStep(s))}</span></span>
      ${cont ? `<button class="btn icon-only sm ghost fold" data-act="fold" title="${s.collapsed ? 'Show' : 'Hide'} the steps inside" aria-label="${s.collapsed ? 'Show' : 'Hide'} the steps inside" data-icon="${s.collapsed ? 'chevright' : 'down'}"></button>` : ''}
      <span class="step-acts">
        <button class="btn icon-only sm ghost" data-act="up" title="Move up" aria-label="Move up" data-icon="up"></button>
        <button class="btn icon-only sm ghost" data-act="down" title="Move down" aria-label="Move down" data-icon="down"></button>
        <button class="btn icon-only sm ghost" data-act="dup" title="Duplicate" aria-label="Duplicate" data-icon="copy"></button>
        ${cont ? `<button class="btn icon-only sm ghost" data-act="unwrap" title="Take the steps out and remove this ${s.type === 'group' ? 'group' : s.type === 'if' ? 'If' : 'loop'}" aria-label="Unwrap" data-icon="unwrap"></button>` : ''}
        <button class="btn icon-only sm ghost danger" data-act="del" title="Delete step" aria-label="Delete step" data-icon="trash"></button>
      </span>
    </div>
    ${open ? `<div class="step-body">${stepBodyHtml(s)}</div>` : ''}
    ${cont && !s.collapsed ? T.branches(s).map(b => branchHtml(s, b, lab)).join('') : ''}
    ${cont && s.collapsed ? `<div class="folded" data-act="fold">${inside} step${inside === 1 ? '' : 's'} inside · show</div>` : ''}
  </li>`;
}

function branchHtml(s, b, lab) {
  const list = s[b] || (s[b] = []);
  const title = s.type === 'if' ? (b === 'else' ? 'Otherwise' : 'Then') : s.type === 'loop' ? 'Each round' : '';
  const here = insertHere && insertHere.parent === s.id && insertHere.branch === b;
  return `<div class="branch b-${b} ${here ? 'here' : ''}" data-parent="${s.id}" data-branch="${b}">
    ${title ? `<div class="branch-label" data-here title="Click, then add steps to put them here">${title}</div>` : ''}
    <ol class="steps sub">${list.map(c => stepHtml(c, lab)).join('')}${list.length
      ? `<li class="drop-end" data-parent="${s.id}" data-branch="${b}">Drop here</li>`
      : `<li class="drop-empty" data-parent="${s.id}" data-branch="${b}" data-here>Drag steps here, or click and add new ones</li>`}</ol>
  </div>`;
}

function spotHtml(s) {
  const has = Number.isFinite(s.fx) && Number.isFinite(s.fy);
  return `<div class="field"><span>Spot</span><div class="inline">
    <span class="spot">${has ? `${(s.fx * 100).toFixed(1)}% across, ${(s.fy * 100).toFixed(1)}% down` : s.type === 'type' ? 'None: types where the cursor already is' : 'Not set'}</span>
    <button class="btn sm" data-act="repick" data-icon="target">${has ? 'Move' : 'Pick'}</button>
    ${has && s.type === 'type' ? '<button class="btn sm ghost" data-act="clearspot">Remove</button>' : ''}
  </div></div>`;
}

function aiHtml(s) {
  const on = !!s.find;
  const text = s.find || s.findText || (s.name ? `the "${s.name}" ${TYPE_NAMES[s.foundType] ? TYPE_NAMES[s.foundType].toLowerCase() : 'control'}` : '');
  return `<div class="ai-box">
    <label class="head"><input type="checkbox" data-f="aiOn" ${on ? 'checked' : ''}>${icon('sparkle')}Find it with AI on every run</label>
    <input class="wide" data-f="findText" placeholder='Describe it, e.g. the "Search orders" box' value="${esc(text)}">
    <div class="inline"><button class="btn sm" data-act="testfind" data-icon="sparkle">Test now</button><span class="muted">Slower, but keeps working if the layout moves.</span></div>
  </div>`;
}

function condHtml(s) {
  const c = s.cond || (s.cond = { kind: 'ai', describe: '' });
  let h = `<div class="cond-box">
    <div class="field"><span>Check if</span><select data-c="kind">${Object.entries(T.COND_KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>`;
  if (c.kind === 'ai') h += `<div class="field"><span>Looks for</span><input class="wide" data-c="describe" value="${esc(c.describe || '')}" placeholder='e.g. a "Saved" message, or a red error banner'></div>`;
  if (c.kind === 'pixel') {
    const has = Number.isFinite(c.fx);
    h += `<div class="field"><span>Spot</span><div class="inline">
        ${c.color ? `<span class="swatch" style="background:${esc(c.color)}" title="${esc(c.color)}"></span><span class="spot">${esc(c.color)}</span>` : ''}
        <span class="spot">${has ? `at ${(c.fx * 100).toFixed(1)}%, ${(c.fy * 100).toFixed(1)}%` : 'Not set'}</span>
        <button class="btn sm" data-act="pickcond" data-icon="target">${has ? 'Pick again' : 'Pick on viewport'}</button></div></div>
      <div class="field"><span>Colour</span><div class="inline"><input type="color" data-c="color" value="${esc(c.color || '#000000')}"><span class="muted">Picking a spot takes its colour from the preview.</span></div></div>
      <div class="field"><span>Tolerance</span><div class="inline"><input type="number" class="num" min="0" max="255" data-c="tolerance" value="${esc(c.tolerance ?? 30)}"><span class="muted">0 = exact colour</span></div></div>`;
  }
  if (c.kind === 'window') h += `<div class="field"><span>Title has</span><input class="wide" data-c="text" value="${esc(c.text || '')}" placeholder="Part of the title or program, e.g. Notepad"></div>`;
  if (c.kind === 'time') h += `<div class="field"><span>Between</span><div class="inline"><input type="time" data-c="from" value="${esc(c.from || '')}"> and <input type="time" data-c="to" value="${esc(c.to || '')}"></div></div>`;
  h += `<div class="field"><span></span><div class="checks"><label><input type="checkbox" data-c="not" ${c.not ? 'checked' : ''}> Reverse it: true when it does NOT match</label></div></div>
    <div class="field"><span></span><div class="inline"><button class="btn sm" data-act="testcond" data-icon="check">Test now</button><span class="cond-result muted"></span></div></div>
  </div>`;
  return h;
}

function stepBodyHtml(s) {
  const p = stepProblem(s);
  let h = '';
  if (s.type === 'click') {
    h += `<div class="field"><span>Button</span><div class="inline">
      <select data-f="button"><option value="left">Left</option><option value="right">Right</option><option value="middle">Middle</option></select>
      <select data-f="count"><option value="1">Single click</option><option value="2">Double-click</option></select></div></div>`;
    h += spotHtml(s) + aiHtml(s);
  } else if (s.type === 'type') {
    h += `<div class="field" style="align-items:start"><span>Text</span><div><textarea data-f="text" rows="2" spellcheck="false" placeholder="What to type">${esc(s.text || '')}</textarea>
      <div class="muted" style="font-size:11.5px;margin-top:3px">You can use {date}, {time}, {datetime}, {run} and {loop} (the loop round).</div></div></div>
      <div class="field"><span></span><div class="checks">
        <label><input type="checkbox" data-f="enter" ${s.enter ? 'checked' : ''}> Press Enter after</label>
        <label><input type="checkbox" data-f="selectAll" ${s.selectAll ? 'checked' : ''}> Replace what is there (Ctrl+A)</label>
      </div></div>`;
    h += spotHtml(s);
    if (Number.isFinite(s.fx)) h += aiHtml(s);
  } else if (s.type === 'scroll') {
    h += `<div class="field"><span>Scroll</span><div class="inline">
      <select data-f="direction"><option value="down">Down</option><option value="up">Up</option><option value="left">Left</option><option value="right">Right</option></select>
      <input type="number" class="num" min="1" max="200" data-f="clicks" value="${s.clicks || 3}"> notches</div></div>`;
    h += spotHtml(s) + aiHtml(s);
  } else if (s.type === 'key') {
    h += `<div class="field"><span>Keys</span><input class="wide" data-f="keys" value="${esc(s.keys || '')}" placeholder="e.g. Ctrl+S" spellcheck="false"></div>
      <div class="field"><span></span><div class="inline">${['Enter', 'Tab', 'Esc', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+S', 'Alt+Tab', 'F5'].map(k => `<button class="btn sm" data-key="${k}">${k}</button>`).join('')}</div></div>`;
  } else if (s.type === 'wait') {
    h += `<div class="field"><span>Wait</span><div class="inline"><input type="number" class="num" min="0" step="0.1" data-f="waitS" value="${(Number(s.ms) || 0) / 1000}"> seconds</div></div>`;
  } else if (s.type === 'group') {
    h += `<div class="field"><span>Name</span><input class="wide" data-f="name" value="${esc(s.name || '')}" placeholder="e.g. Log in"></div>
      <div class="muted">A group keeps related steps together. Fold it away with the arrow, or turn it all off with "Skip".</div>`;
  } else if (s.type === 'if') {
    h += condHtml(s) + `<div class="muted">Runs the <b>Then</b> steps when this is true, otherwise the <b>Otherwise</b> steps.</div>`;
  } else if (s.type === 'loop') {
    const mode = s.mode || 'times';
    h += `<div class="field"><span>Repeat</span><select data-f="mode"><option value="times">a number of times</option><option value="while">while something is true</option><option value="until">until something is true</option></select></div>`;
    if (mode === 'times') h += `<div class="field"><span>Times</span><div class="inline"><input type="number" class="num" min="1" max="100000" data-f="times" value="${esc(s.times ?? 3)}"> rounds</div></div>`;
    else h += condHtml(s) + `<div class="field"><span>At most</span><div class="inline"><input type="number" class="num" min="1" max="100000" data-f="max" value="${esc(s.max ?? 100)}"> rounds <span class="muted">(a safety limit)</span></div></div>
      <div class="muted">Checked before each round.</div>`;
  } else if (s.type === 'stop') {
    h += `<div class="field"><span>Stop</span><select data-f="what"><option value="loop">the loop it is in</option><option value="task">the whole task</option></select></div>
      <div class="muted">Put it inside an If, e.g. "If the AI sees "No more results" → Stop the loop".</div>`;
  }
  if (!T.isContainer(s) && s.type !== 'wait' && s.type !== 'stop') h += `<div class="field"><span>Then wait</span><div class="inline"><input type="number" class="num" min="0" step="0.1" data-f="afterS" value="${(s.after ?? 300) / 1000}"> seconds</div></div>`;
  h += `<div class="field"><span></span><div class="checks"><label><input type="checkbox" data-f="disabled" ${s.disabled ? 'checked' : ''}> Skip this step${T.isContainer(s) ? ' and everything in it' : ''}</label></div></div>`;
  if (p) h += `<div class="problem">${icon('alert')}${esc(p)}</div>`;
  return h;
}

function bindStepBody(body, s) {
  for (const el of body.querySelectorAll('select[data-f]')) {
    const f = el.dataset.f;
    el.value = String(f === 'count' ? (s.count === 2 ? 2 : 1) : (s[f] || el.options[0].value));
  }
  const k = body.querySelector('select[data-c=kind]');
  if (k) k.value = s.cond?.kind || 'ai';
}

function stepChanged(s, { structure = false } = {}) {
  saveSoon();
  const li = $('steps').querySelector(`[data-step="${s.id}"]`);
  if (structure || !li) { renderSteps(); }
  else {
    li.querySelector(':scope > .step-row .sum-text').textContent = describeStep(s);
    const p = stepProblem(s);
    li.classList.toggle('bad', !!p); li.classList.toggle('off', !!s.disabled);
    const body = li.querySelector(':scope > .step-body');
    let pe = body && body.querySelector(':scope > .problem');
    if (p && body && !pe) { body.insertAdjacentHTML('beforeend', `<div class="problem"></div>`); pe = body.querySelector(':scope > .problem'); }
    if (pe) { if (p) pe.innerHTML = icon('alert') + esc(p); else pe.remove(); }
  }
  renderOverlay();
}

function onStepInput(e) {
  const li = e.target.closest('[data-step]'); if (!li) return;
  const f0 = findStep(li.dataset.step); if (!f0) return;
  const s = f0.step;
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  const c = e.target.dataset.c;
  if (c) {
    s.cond = s.cond || { kind: 'ai' };
    if (c === 'kind') { s.cond = { kind: v, not: s.cond.not, ...COND_DEFAULTS[v] }; stepChanged(s, { structure: true }); return; }
    if (c === 'tolerance') s.cond.tolerance = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
    else s.cond[c] = v;
    if (c === 'color') { const sw = li.querySelector(':scope > .step-body .swatch'); if (sw) sw.style.background = v; }
    stepChanged(s);
    return;
  }
  const f = e.target.dataset.f; if (!f) return;
  let structure = false;
  if (f === 'count') s.count = Number(v);
  else if (f === 'clicks') s.clicks = Math.max(1, Math.round(Number(v) || 1));
  else if (f === 'waitS') s.ms = Math.max(0, Math.round((Number(v) || 0) * 1000));
  else if (f === 'afterS') s.after = Math.max(0, Math.round((Number(v) || 0) * 1000));
  else if (f === 'times' || f === 'max') s[f] = Math.max(1, Math.round(Number(v) || 1));
  else if (f === 'mode') { s.mode = v; if (v !== 'times') { s.cond = s.cond || { kind: 'ai', describe: '' }; s.max = s.max || 100; } structure = true; }
  else if (f === 'aiOn') { s.find = v ? (li.querySelector('[data-f=findText]').value.trim() || '') : ''; if (v && !s.find) toast('Describe the element first.', true); }
  else if (f === 'findText') { s.findText = v; if (s.find) s.find = v.trim(); }
  else s[f] = v;
  stepChanged(s, { structure });
}

async function onStepClick(e) {
  if (Date.now() - dndJustDropped < 80) return;      // the click that ends a drag
  const here = e.target.closest('[data-here]');
  if (here) {
    const br = here.closest('[data-branch]');
    insertHere = { parent: br.dataset.parent, branch: br.dataset.branch };
    selStep = null; renderSteps(); renderOverlay();
    toast('New steps will go here. Add them with the buttons below or the tools above the viewport.');
    return;
  }
  const li = e.target.closest('[data-step]'); if (!li) return;
  const f = findStep(li.dataset.step); if (!f) return;
  const s = f.step;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (key) { s.keys = key; li.querySelector('[data-f=keys]').value = key; stepChanged(s); return; }
  if (act === 'up' && f.index > 0) { [f.list[f.index - 1], f.list[f.index]] = [f.list[f.index], f.list[f.index - 1]]; stepChanged(s, { structure: true }); return; }
  if (act === 'down' && f.index < f.list.length - 1) { [f.list[f.index + 1], f.list[f.index]] = [f.list[f.index], f.list[f.index + 1]]; stepChanged(s, { structure: true }); return; }
  if (act === 'up' || act === 'down') return;
  if (act === 'dup') { const c = T.cloneFresh(s, uid); f.list.splice(f.index + 1, 0, c); selStep = c.id; stepChanged(c, { structure: true }); return; }
  if (act === 'del') { deleteStep(s.id); return; }
  if (act === 'unwrap') { T.unwrap(stepsOf(), s.id); if (selStep === s.id) selStep = null; saveSoon(); renderSteps(); renderOverlay(); return; }
  if (act === 'fold') { s.collapsed = !s.collapsed; stepChanged(s, { structure: true }); return; }
  if (act === 'repick') { repickStep = s.id; repickWhat = 'step'; setTool(s.type === 'click' ? (s.count === 2 ? 'double' : s.button === 'right' ? 'right' : 'click') : s.type, true); toast('Click the viewport where this step should happen.'); return; }
  if (act === 'pickcond') { repickStep = s.id; repickWhat = 'cond'; setTool('select', true); renderFoot(); toast('Click the spot on the viewport whose colour to check.'); return; }
  if (act === 'clearspot') { delete s.fx; delete s.fy; s.find = ''; stepChanged(s, { structure: true }); return; }
  if (act === 'testfind') {
    const d = li.querySelector('[data-f=findText]').value.trim();
    if (!d) { toast('Describe the element first.', true); return; }
    const hit = await tryIt(() => ap.aiFind(draft.viewport, d));
    if (hit === null) toast(`The AI could not find "${d}".`, true);
    else if (hit) { ripple(hit.fx, hit.fy); toast(`Found it at ${(hit.fx * 100).toFixed(0)}% across, ${(hit.fy * 100).toFixed(0)}% down.`); }
    return;
  }
  if (act === 'testcond') {
    const out = li.querySelector(':scope > .step-body .cond-result');
    const p = T.condProblem(s.cond);
    if (p) { toast(p, true); return; }
    if (out) out.textContent = 'Checking…';
    const r = await tryIt(() => ap.checkCond(draft.viewport, s.cond));
    if (out) out.innerHTML = r ? `<b class="${r.result ? 'yes' : 'no'}">${r.result ? 'True' : 'False'}</b> · ${esc(r.detail)}` : '';
    return;
  }
  if (!act && e.target.closest('.step-row') === li.querySelector(':scope > .step-row')) {
    selStep = selStep === s.id ? null : s.id; insertHere = null;
    renderSteps(); renderOverlay();
  }
}

function deleteStep(id) {
  const f = findStep(id); if (!f) return;
  const inside = T.isContainer(f.step) ? countInside(f.step) : 0;
  if (inside && !confirm(`Delete "${describeStep(f.step)}" and the ${inside} step${inside === 1 ? '' : 's'} inside it?`)) return;
  T.remove(stepsOf(), id);
  if (selStep === id || (selStep && !findStep(selStep))) selStep = null;
  saveSoon(); renderSteps(); renderOverlay();
}

// Where a new step goes: an empty list the user clicked, inside a selected Group/If/Loop, after the selected step, or at the end.
function insertTarget() {
  if (insertHere && findStep(insertHere.parent)) return { parent: insertHere.parent, branch: insertHere.branch };
  const f = findStep(selStep);
  if (!f) return { parent: null };
  if (T.isContainer(f.step) && !f.step.collapsed) return { parent: f.step.id, branch: 'children' };
  return { ref: f.step.id, where: 'after' };
}

function addStep(step, { select = true } = {}) {
  const s = { id: uid(), after: 300, ...step };
  if (T.isContainer(s)) { s.children = s.children || []; if (s.type === 'if') s.else = s.else || []; delete s.after; }
  if (!T.insert(stepsOf(), s, insertTarget())) T.insert(stepsOf(), s, { parent: null });
  insertHere = null;
  if (select) selStep = s.id;
  tab = 'steps'; renderEditor(); saveSoon();
  scrollStepIntoView(s.id);
  return s;
}

const NEW_LOGIC = {
  group: () => ({ type: 'group', name: '' }),
  if: () => ({ type: 'if', cond: { kind: 'ai', describe: '' } }),
  loop: () => ({ type: 'loop', mode: 'times', times: 3, max: 100 }),
  stop: () => ({ type: 'stop', what: 'loop', after: 0 }),
};

function newStepOfTool(t, fx, fy, extra = {}) {
  const base = { fx, fy, ...extra };
  if (t === 'click') return { type: 'click', button: 'left', count: 1, ...base };
  if (t === 'double') return { type: 'click', button: 'left', count: 2, ...base };
  if (t === 'right') return { type: 'click', button: 'right', count: 1, ...base };
  if (t === 'type') return { type: 'type', text: '', enter: false, clickFirst: true, ...base };
  if (t === 'scroll') return { type: 'scroll', direction: 'down', clicks: 3, ...base };
}

function focusStepText(id) {
  setTimeout(() => {
    const el = $('steps').querySelector(`[data-step="${id}"] [data-f=text]`);
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
  }, 30);
}

// ---------- drag and drop of step cards (by the grip) ----------
function onGripDown(e) {
  const grip = e.target.closest('[data-grip]');
  if (!grip || e.button !== 0) return;
  dnd = { id: grip.closest('[data-step]').dataset.step, x: e.clientX, y: e.clientY, started: false, target: null };
  e.preventDefault();
}

function clearDropMarks() {
  for (const el of $('steps').querySelectorAll('.drop-before, .drop-after, .drop-first, .drop-into')) el.classList.remove('drop-before', 'drop-after', 'drop-first', 'drop-into');
}

// What is under the pointer: next to a card, first inside an open container, or into a list.
function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !$('steps').contains(el)) return null;
  if (el.closest(`[data-step="${dnd.id}"]`)) return null;           // on itself or inside itself
  const zone = el.closest('.drop-empty, .drop-end');
  if (zone) return { parent: zone.dataset.parent || null, branch: zone.dataset.branch || 'children', mark: zone, cls: 'drop-into' };
  const li = el.closest('[data-step]');
  if (!li) return null;
  const s = findStep(li.dataset.step)?.step;
  if (!s) return null;
  const row = li.querySelector(':scope > .step-row').getBoundingClientRect();
  const cont = T.isContainer(s);
  if (!cont || y <= row.bottom) {
    const r = cont ? row : li.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { ref: s.id, where: 'before', mark: li, cls: 'drop-before' };
    if (cont && !s.collapsed) return { parent: s.id, branch: 'children', index: 0, mark: li.querySelector(':scope > .branch'), cls: 'drop-first' };
    return { ref: s.id, where: 'after', mark: li, cls: 'drop-after' };
  }
  const br = el.closest('.branch');
  if (br && li.contains(br)) return { parent: br.dataset.parent, branch: br.dataset.branch, mark: br, cls: 'drop-into' };
  return { ref: s.id, where: 'after', mark: li, cls: 'drop-after' };
}

function onDndMove(e) {
  if (!dnd) return;
  if (!dnd.started) {
    if (Math.hypot(e.clientX - dnd.x, e.clientY - dnd.y) < 5) return;
    dnd.started = true;
    document.body.classList.add('dnd-on');
    $('steps').querySelector(`[data-step="${dnd.id}"]`)?.classList.add('dragging');
    dndGhost = document.createElement('div');
    dndGhost.className = 'dnd-ghost';
    const st = findStep(dnd.id)?.step;
    dndGhost.innerHTML = icon(STEP_ICON[st?.type] || 'click') + esc(st ? describeStep(st) : '');
    document.body.appendChild(dndGhost);
  }
  dndGhost.style.left = e.clientX + 14 + 'px';
  dndGhost.style.top = e.clientY + 10 + 'px';
  clearDropMarks();
  dnd.target = dropTargetAt(e.clientX, e.clientY);
  if (dnd.target?.mark) dnd.target.mark.classList.add(dnd.target.cls);
  const body = $('steps').closest('.tab-body').getBoundingClientRect();
  if (e.clientY < body.top + 36) $('steps').closest('.tab-body').scrollTop -= 14;
  else if (e.clientY > body.bottom - 36) $('steps').closest('.tab-body').scrollTop += 14;
}

function onDndUp() {
  if (!dnd) return;
  const d = dnd; dnd = null;
  dndGhost?.remove(); dndGhost = null;
  document.body.classList.remove('dnd-on');
  clearDropMarks();
  if (!d.started) return;
  dndJustDropped = Date.now();
  if (d.target) {
    const { mark, cls, ...target } = d.target;
    if (T.move(stepsOf(), d.id, target)) { selStep = d.id; insertHere = null; saveSoon(); }
  }
  renderSteps(); renderOverlay();
}

// ---------- timers ----------
function renderTimers() {
  const ul = $('timers');
  const trs = draft.triggers || [];
  $('timerCount').textContent = trs.length ? trs.length : '';
  if (!trs.length) { ul.innerHTML = '<li class="hint">No timers. This task only runs when you press Run now.</li>'; return; }
  ul.innerHTML = trs.map(tr => {
    let body = '';
    if (tr.kind === 'interval') {
      body = `<div class="field"><span>Every</span><div class="inline"><input type="number" class="num" min="1" data-t="every" value="${esc(tr.every)}">
        <select data-t="unit"><option value="s">seconds</option><option value="min">minutes</option><option value="h">hours</option></select></div></div>
        <div class="field"><span>Stop after</span><div class="inline"><input type="number" class="num" min="1" data-t="maxRuns" value="${esc(tr.maxRuns ?? '')}" placeholder="∞"> runs <span class="muted">${tr.runs ? `(${tr.runs} done)` : ''}</span></div></div>`;
    } else if (tr.kind === 'daily') {
      const days = tr.days && tr.days.length ? tr.days : [0, 1, 2, 3, 4, 5, 6];
      body = `<div class="field"><span>At</span><input type="time" data-t="time" value="${esc(tr.time)}"></div>
        <div class="field"><span>On</span><div class="days">${[1, 2, 3, 4, 5, 6, 0].map(d => `<button type="button" data-day="${d}" class="${days.includes(d) ? 'on' : ''}">${DAY[d]}</button>`).join('')}</div></div>`;
    } else {
      body = `<div class="field"><span>At</span><div class="inline"><input type="datetime-local" data-t="at" value="${esc(toLocalInput(tr.at))}">
        <button class="btn sm" data-plus="5">+5 min</button><button class="btn sm" data-plus="60">+1 h</button></div></div>`;
    }
    const title = tr.kind === 'interval' ? 'Repeat' : tr.kind === 'daily' ? 'Daily' : 'Once';
    return `<li class="timer ${tr.enabled === false ? 'off' : ''}" data-tr="${tr.id}">
      <div class="timer-top">${icon(tr.kind === 'interval' ? 'repeat' : tr.kind === 'daily' ? 'calendar' : 'clock')}<span class="grow">${title}</span>
        <label class="toggle" title="This timer on/off"><input type="checkbox" data-t="enabled" ${tr.enabled !== false ? 'checked' : ''}><span></span></label>
        <button class="btn icon-only sm ghost danger" data-trdel title="Delete timer" aria-label="Delete timer" data-icon="trash"></button></div>
      ${body}
      <div class="timer-next"></div>
      <div class="problem" hidden></div>
    </li>`;
  }).join('');
  for (const tr of trs) {
    const sel = ul.querySelector(`[data-tr="${tr.id}"] select[data-t=unit]`);
    if (sel) sel.value = tr.unit || 's';
  }
  applyIcons(ul);
  renderTimerNext(); renderTimerProblems();
}

function toLocalInput(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderTimerNext() {
  if (!draft) return;
  const now = Date.now();
  for (const tr of draft.triggers || []) {
    const el = document.querySelector(`[data-tr="${tr.id}"] .timer-next`);
    if (!el) continue;
    let txt, off = false;
    if (S.paused) { txt = 'Paused (all timers)'; off = true; }
    else if (draft.enabled === false) { txt = 'Off: timers are off for this task'; off = true; }
    else if (tr.enabled === false) { txt = tr.kind === 'once' && tr.runs ? `Done (ran ${dayClock(tr.lastRun)})` : tr.missed ? 'Missed while the app was closed' : 'Off'; off = true; }
    else if (tr.next) txt = `Next run ${fmtIn(tr.next - now)} (${dayClock(tr.next)})`;
    else if (tr.problem) { txt = ''; off = true; }
    else if (tr.kind === 'interval' && tr.maxRuns && (tr.runs || 0) >= tr.maxRuns) { txt = `Finished: ran ${tr.runs} time${tr.runs === 1 ? '' : 's'}. Raise or clear "Stop after" to run again.`; off = true; }
    else { txt = savePending ? 'Saving…' : 'Not scheduled'; off = true; }
    el.textContent = txt; el.classList.toggle('off', off);
  }
}
function renderTimerProblems() {
  if (!draft) return;
  for (const tr of draft.triggers || []) {
    const el = document.querySelector(`[data-tr="${tr.id}"] .problem`);
    if (el) { el.hidden = !tr.problem; el.innerHTML = tr.problem ? icon('alert') + esc(tr.problem) : ''; }
  }
}

function addTimer(kind) {
  draft.triggers = draft.triggers || [];
  const tr = { id: uid(), kind, enabled: true };
  if (kind === 'interval') Object.assign(tr, { every: 5, unit: 'min' });
  if (kind === 'daily') Object.assign(tr, { time: '09:00', days: [1, 2, 3, 4, 5] });
  if (kind === 'once') tr.at = new Date(Date.now() + 10 * 60e3).toISOString();
  draft.triggers.push(tr);
  if (draft.enabled === false) draft.enabled = true;
  renderTimers(); $('taskEnabled').checked = true; saveSoon(100);
}

function onTimerInput(e) {
  const li = e.target.closest('[data-tr]'); if (!li) return;
  const tr = draft.triggers.find(x => x.id === li.dataset.tr);
  const f = e.target.dataset.t; if (!f) return;
  if (f === 'enabled') { tr.enabled = e.target.checked; if (tr.enabled && tr.kind === 'once') { tr.runs = 0; tr.missed = false; } li.classList.toggle('off', !tr.enabled); }
  else if (f === 'every') tr.every = Number(e.target.value);
  else if (f === 'maxRuns') tr.maxRuns = e.target.value === '' ? null : Number(e.target.value);
  else if (f === 'at') { const d = new Date(e.target.value); if (!isNaN(d)) tr.at = d.toISOString(); }
  else tr[f] = e.target.value;
  tr.next = null;
  renderTimerNext(); saveSoon();
}
function onTimerClick(e) {
  const li = e.target.closest('[data-tr]'); if (!li) return;
  const tr = draft.triggers.find(x => x.id === li.dataset.tr);
  if (e.target.closest('[data-trdel]')) { draft.triggers = draft.triggers.filter(x => x !== tr); renderTimers(); saveSoon(100); return; }
  const day = e.target.closest('[data-day]');
  if (day) {
    const d = Number(day.dataset.day);
    let days = tr.days && tr.days.length ? [...tr.days] : [0, 1, 2, 3, 4, 5, 6];
    days = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    if (!days.length) { toast('Keep at least one day.', true); return; }
    tr.days = days; day.classList.toggle('on'); tr.next = null; saveSoon(); return;
  }
  const plus = e.target.closest('[data-plus]');
  if (plus) {
    tr.at = new Date(Date.now() + Number(plus.dataset.plus) * 60e3).toISOString(); tr.enabled = true; tr.runs = 0; tr.next = null;
    li.querySelector('[data-t=at]').value = toLocalInput(tr.at); li.querySelector('[data-t=enabled]').checked = true; li.classList.remove('off');
    saveSoon(100);
  }
}

// ---------- history ----------
function renderHistory() {
  const ul = $('history'); if (!ul) return;
  const list = (S.history || []).filter(h => !draft || h.taskId === draft.id).slice(0, 40);
  ul.innerHTML = list.length ? list.map(h => `<li class="${h.ok ? 'ok' : 'bad'}">${icon(h.ok ? 'check' : 'alert')}
      <div><div>${h.ok ? 'Done' : 'Stopped'} · by ${esc(h.by)} · ${(h.ms / 1000).toFixed(1)} s</div><div class="msg">${esc(h.msg)}</div></div>
      <span class="when">${esc(dayClock(h.at))}</span></li>`).join('') : '<li class="hint" style="display:block;background:none">No runs yet.</li>';
}

// ---------- viewport preview ----------
function renderViewportChip() {
  const chip = $('viewportChip');
  const vp = draft?.viewport;
  chip.disabled = !draft;
  chip.classList.toggle('missing', !!(vp && !view.ok && view.error));
  chip.innerHTML = !draft ? `${icon('screen')}<span>No task selected</span>` : !vp ? `${icon('target')}<span>Choose a screen or window…</span>`
    : `${icon(vp.kind === 'window' ? 'window' : 'screen')}<span>${esc(vp.kind === 'window' ? vp.title : vp.label)}</span>`;
  chip.title = view.error || 'Choose which screen or window this task works on';
}

function stopStream() {
  if (stream) for (const tr of stream.getTracks()) tr.stop();
  stream = null;
  $('video').srcObject = null;
}

async function startPreview() {
  const token = ++previewToken;
  stopStream();
  view = { w: 0, h: 0, ok: false, error: '' };
  frozen = false; $('freezeBtn').classList.remove('on');
  renderViewportChip(); renderStage();
  const vp = draft?.viewport;
  if (!vp) return;
  try {
    const r = await ap.resolveViewport(vp);
    if (token !== previewToken) return;
    if (r.minimized) throw new Error('The window is minimized. Restore it to see it here.');
    view.rect = r.rect;
    if (r.launch && !vp.launch && draft?.viewport === vp) { vp.launch = r.launch; saveSoon(); }
    await ap.setPreview(r.sourceId);
    let s;
    try { s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
    catch { s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: r.sourceId, maxFrameRate: 15 } } }); }
    if (token !== previewToken) { for (const tr of s.getTracks()) tr.stop(); return; }
    stream = s;
    const v = $('video');
    v.srcObject = s;
    s.getVideoTracks()[0].addEventListener('ended', () => { if (token === previewToken) { view.ok = false; view.error = 'The window was closed.'; renderViewportChip(); renderStage(); } });
    await new Promise(res => { if (v.readyState >= 1) res(); else v.onloadedmetadata = res; });
    await v.play().catch(() => {});
    view.w = v.videoWidth; view.h = v.videoHeight; view.ok = true;
  } catch (e) {
    if (token !== previewToken) return;
    view.ok = false; view.error = e.message;
  }
  renderViewportChip(); renderStage();
}

function renderStage() {
  const has = !!(draft && draft.viewport && view.ok && view.w);
  $('stage').hidden = !has;
  const empty = $('stageEmpty');
  empty.hidden = has;
  if (!has) {
    if (!S.tasks.length) empty.innerHTML = `<b>Automate clicks, typing and scrolling</b>Make a task, pick the screen or window it works on, then click the preview to place steps. Let the local AI find text boxes for you, and add timers to run it on its own.<br><button class="btn primary" id="emptyNew">${icon('plus')}New task</button>`;
    else if (!draft) empty.innerHTML = '<b>No task selected</b>Pick a task on the left.';
    else if (!draft.viewport) empty.innerHTML = `<b>Where should this task work?</b>Choose the entire screen or one window.<br><button class="btn primary" id="emptyPick">${icon('target')}Choose a viewport</button>`;
    else if (view.error && isClosedError(view.error)) {
      const can = canOpenVp(draft.viewport);
      empty.innerHTML = `<b>The window is closed</b>${esc(view.error)}<div class="empty-actions">`
        + (can ? `<button class="btn primary" id="emptyOpen">${icon('play')}Open ${esc(progName(draft.viewport))} again</button> <button class="btn" id="emptyHow">How to open it…</button>`
               : `<button class="btn primary" id="emptyHow">${icon('settings')}Set how to open it…</button>`)
        + ` <button class="btn" id="emptyRetry">Try again</button> <button class="btn" id="emptyPick">Choose another</button></div>`;
    }
    else if (view.error) empty.innerHTML = `<b>Can't show the viewport</b>${esc(view.error)}<br><button class="btn" id="emptyRetry">Try again</button> <button class="btn" id="emptyPick">Choose another</button>`;
    else empty.innerHTML = 'Connecting to the viewport…';
    $('emptyNew') && ($('emptyNew').onclick = newTask);
    $('emptyPick') && ($('emptyPick').onclick = () => openPicker());
    $('emptyRetry') && ($('emptyRetry').onclick = startPreview);
    $('emptyOpen') && ($('emptyOpen').onclick = openAgain);
    $('emptyHow') && ($('emptyHow').onclick = openLaunchDlg);
  }
  layoutStage(); renderOverlay(); renderFoot();
}

function layoutStage() {
  if (!view.w) return;
  const wrap = $('stageWrap').getBoundingClientRect();
  const pad = 16;
  const s = Math.min((wrap.width - pad * 2) / view.w, (wrap.height - pad * 2) / view.h);
  const w = Math.max(10, Math.floor(view.w * s)), h = Math.max(10, Math.floor(view.h * s));
  const st = $('stage');
  st.style.width = w + 'px'; st.style.height = h + 'px';
  st.style.left = Math.round((wrap.width - w) / 2) + 'px'; st.style.top = Math.round((wrap.height - h) / 2) + 'px';
}

function renderFoot() {
  const f = $('viewFoot');
  if (!draft) { f.innerHTML = ''; return; }
  const items = found.get(draft.id)?.items || [];
  const counts = {};
  for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
  const legend = Object.entries(counts).map(([t, n]) => `<span class="legend"><i style="background:var(--t-${t in TYPE_NAMES ? t : 'other'})"></i>${n} ${esc(TYPE_NAMES[t] || t).toLowerCase()}${n > 1 ? 's' : ''}</span>`).join('');
  const hint = repickStep ? (repickWhat === 'cond' ? 'Click the spot whose colour to check (Esc to cancel).' : 'Click where the step should go (Esc to cancel).') : tool === 'select' ? 'Pick a tool, then click the preview to add a step. Click a found input for options.' : `Click the preview to add a ${tool === 'double' ? 'double-click' : tool === 'right' ? 'right-click' : tool} step.`;
  f.innerHTML = `<span>${esc(hint)}</span><span class="sep"></span>${legend}${view.ok && view.rect ? `<span>${view.rect.w}×${view.rect.h}</span>` : ''}`;
}

// ---------- overlay: found inputs and pins ----------
function renderOverlay() {
  const ov = $('overlay');
  ov.classList.toggle('hide-found', !$('showFound').checked);
  $('stage').className = 'stage tool-' + tool;
  if (!draft || !view.ok) { ov.innerHTML = ''; return; }
  const items = found.get(draft.id)?.items || [];
  let h = items.map((it, i) => `<div class="found ${it.fy1 < 0.05 ? 'below' : ''}" data-t="${it.type in TYPE_NAMES ? it.type : 'other'}" data-found="${i}" style="left:${it.fx1 * 100}%;top:${it.fy1 * 100}%;width:${(it.fx2 - it.fx1) * 100}%;height:${(it.fy2 - it.fy1) * 100}%" title="${esc(TYPE_NAMES[it.type] || it.type)}${it.label ? ': ' + esc(it.label) : ''}"><span class="tag">${esc(it.label || TYPE_NAMES[it.type] || it.type)}</span></div>`).join('');
  for (const p of T.spots(stepsOf())) {
    const s = p.step, sel = s.id === selStep;
    const title = p.kind === 'cond' ? `Colour check for "${describeStep(s)}"` : describeStep(s);
    h += `<div class="pin t-${s.type} ${p.kind === 'cond' ? 'cond' : ''} ${sel ? 'sel' : ''} ${s.find ? 'ai' : ''} ${p.off ? 'disabled' : ''}" data-pin="${s.id}" data-pk="${p.kind}" style="left:${p.fx * 100}%;top:${p.fy * 100}%;${p.color ? '--pc:' + p.color : ''}" title="${esc(title)}"><span>${esc(p.label)}</span></div>`;
    if (sel) h += `<div class="pin-label" data-for="${p.kind}" style="left:${p.fx * 100}%;top:${p.fy * 100}%">${esc(title)}</div>`;
  }
  ov.innerHTML = h;
  renderFoot();
}

function ripple(fx, fy) {
  if (!view.ok || !Number.isFinite(fx)) return;
  const r = document.createElement('div');
  r.className = 'ripple'; r.style.left = fx * 100 + '%'; r.style.top = fy * 100 + '%';
  $('overlay').appendChild(r);
  setTimeout(() => r.remove(), 1000);
}

function stagePoint(e) {
  const b = $('overlay').getBoundingClientRect();
  return { fx: clamp01((e.clientX - b.left) / b.width), fy: clamp01((e.clientY - b.top) / b.height) };
}

let drag = null;
function onOverlayDown(e) {
  if (e.button !== 0 || !draft) return;
  closePopover();
  const pin = e.target.closest('[data-pin]');
  const box = e.target.closest('[data-found]');
  const p = stagePoint(e);
  if (pin && !repickStep) {
    const s = findStep(pin.dataset.pin)?.step;
    if (!s) return;
    drag = { s, kind: pin.dataset.pk, el: pin, x: e.clientX, y: e.clientY, moved: false };
    e.preventDefault();
    return;
  }
  const item = box && $('showFound').checked ? found.get(draft.id)?.items[Number(box.dataset.found)] : null;
  const center = item ? { fx: (item.fx1 + item.fx2) / 2, fy: (item.fy1 + item.fy2) / 2 } : p;
  if (repickStep) {
    const s = findStep(repickStep)?.step;
    repickStep = null;
    if (s && repickWhat === 'cond') {
      s.cond = { ...s.cond, kind: 'pixel', fx: p.fx, fy: p.fy };
      const col = sampleColor(p.fx, p.fy);
      if (col) s.cond.color = col; else toast('Could not read the colour from the preview; set it by hand.', true);
      selStep = s.id; stepChanged(s, { structure: true });
    } else if (s) { Object.assign(s, center); if (item) { s.name = item.label; s.foundType = item.type; } selStep = s.id; stepChanged(s, { structure: true }); }
    repickWhat = 'step';
    setTool('select');
    return;
  }
  if (tool === 'select') {
    if (item) showFoundPopover(item, box);
    else if (selStep) { selStep = null; renderSteps(); renderOverlay(); }
    return;
  }
  const extra = item ? { name: item.label, foundType: item.type, findText: `the "${item.label || TYPE_NAMES[item.type]}" ${(TYPE_NAMES[item.type] || 'control').toLowerCase()}` } : {};
  const s = addStep(newStepOfTool(tool, center.fx, center.fy, extra));
  if (s.type === 'type') focusStepText(s.id);
}
function onDragMove(e) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
  drag.moved = true;
  const p = stagePoint(e);
  const tgt = drag.kind === 'cond' ? drag.s.cond : drag.s;
  tgt.fx = p.fx; tgt.fy = p.fy;
  const el = drag.el;
  if (el) { el.style.left = p.fx * 100 + '%'; el.style.top = p.fy * 100 + '%'; }
  const lab = $('overlay').querySelector(`.pin-label[data-for="${drag.kind}"]`);
  if (lab && drag.s.id === selStep) { lab.style.left = p.fx * 100 + '%'; lab.style.top = p.fy * 100 + '%'; }
}
function onDragUp() {
  if (!drag) return;
  const { s, moved, kind } = drag; drag = null;
  if (moved && kind === 'cond') { const col = sampleColor(s.cond.fx, s.cond.fy); if (col) s.cond.color = col; }
  if (moved) { selStep = s.id; stepChanged(s, { structure: true }); }
  else { selStep = selStep === s.id ? null : s.id; tab = 'steps'; renderEditor(); scrollStepIntoView(s.id); }
}
// Average colour of a 3x3 patch of the live preview, as #rrggbb.
let sampleCanvas = null;
function sampleColor(fx, fy) {
  const v = $('video');
  if (!v.videoWidth) return null;
  try {
    sampleCanvas = sampleCanvas || Object.assign(document.createElement('canvas'), { width: 3, height: 3 });
    const g = sampleCanvas.getContext('2d', { willReadFrequently: true });
    const x = Math.round(fx * (v.videoWidth - 1)), y = Math.round(fy * (v.videoHeight - 1));
    g.clearRect(0, 0, 3, 3);
    g.drawImage(v, x - 1, y - 1, 3, 3, 0, 0, 3, 3);
    const d = g.getImageData(0, 0, 3, 3).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < 36; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
    return T.rgbHex(sum.map(c => c / 9));
  } catch { return null; }
}
function scrollStepIntoView(id) { setTimeout(() => $('steps').querySelector(`[data-step="${id}"]`)?.scrollIntoView({ block: 'nearest' }), 20); }

function showFoundPopover(item, boxEl) {
  const pop = $('popover');
  const typable = item.type === 'textbox' || item.type === 'textarea';
  const desc = `the "${item.label || TYPE_NAMES[item.type]}" ${(TYPE_NAMES[item.type] || 'control').toLowerCase()}`;
  pop.innerHTML = `<div class="ptitle">${esc(item.label || '(no label)')}</div>
    <div class="psub">${esc(TYPE_NAMES[item.type] || item.type)} · found by ${item.source === 'uia' ? 'Windows accessibility' : 'AI'}</div>
    <div class="pacts">
      ${typable ? `<button class="btn sm" data-pa="type">${icon('type')}Type into it…</button>` : ''}
      <button class="btn sm" data-pa="click">${icon('click')}Click it</button>
      <button class="btn sm" data-pa="double">${icon('double')}Double-click it</button>
      ${!typable ? `<button class="btn sm" data-pa="type">${icon('type')}Click, then type…</button>` : ''}
    </div>
    <label class="pfind"><input type="checkbox" id="popAi"> Find it with AI on every run</label>`;
  const wrap = $('stageWrap').getBoundingClientRect();
  const b = boxEl.getBoundingClientRect();
  let left = b.left - wrap.left, top = b.bottom - wrap.top + 6;
  if (left + 270 > wrap.width) left = wrap.width - 270;
  if (top + 190 > wrap.height) top = b.top - wrap.top - 196;
  pop.style.left = Math.max(6, left) + 'px'; pop.style.top = Math.max(6, top) + 'px';
  pop.hidden = false;
  pop.onclick = ev => {
    const a = ev.target.closest('[data-pa]')?.dataset.pa; if (!a) return;
    const c = { fx: (item.fx1 + item.fx2) / 2, fy: (item.fy1 + item.fy2) / 2 };
    const ai = $('popAi').checked;
    const s = addStep(newStepOfTool(a, c.fx, c.fy, { name: item.label, foundType: item.type, findText: desc, find: ai ? desc : '' }));
    closePopover();
    if (s.type === 'type') focusStepText(s.id);
  };
}
function closePopover() { $('popover').hidden = true; }

// ---------- tools ----------
function setTool(t, keepRepick = false) {
  tool = t;
  if (!keepRepick) repickStep = null;
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('on', b.dataset.tool === t);
  renderOverlay();
}

// ---------- viewport picker ----------
async function openPicker(forNew = false) {
  const dlg = $('pickerDlg');
  $('screenGrid').innerHTML = $('windowGrid').innerHTML = '<span class="muted">Looking…</span>';
  $('pickerFilter').value = '';
  if (!dlg.open) dlg.showModal();
  const sources = await tryIt(() => ap.listSources());
  if (!sources) { dlg.close(); return; }
  const card = s => `<button type="button" class="source" data-src="${esc(s.id)}">
      <div class="thumb" style="background-image:url('${s.thumb || ''}')"></div>
      <div class="label">${s.appIcon ? `<img src="${s.appIcon}" alt="">` : icon(s.viewport.kind === 'window' ? 'window' : 'screen')}<span>${esc(s.viewport.kind === 'screen' ? s.viewport.label : s.name)}</span></div>
      <div class="sub">${esc(s.viewport.process || '')}${s.size ? ` · ${s.size[0]}×${s.size[1]}` : ''}${s.minimized ? ' · minimized' : ''}</div></button>`;
  const screens = sources.filter(s => s.viewport.kind === 'screen');
  const wins = sources.filter(s => s.viewport.kind === 'window');
  $('screenGrid').innerHTML = screens.map(card).join('') || '<span class="muted">No screens found.</span>';
  $('windowGrid').innerHTML = wins.map(card).join('') || '<span class="muted">No windows found.</span>';
  const pick = ev => {
    const id = ev.target.closest('[data-src]')?.dataset.src; if (!id) return;
    const src = sources.find(s => s.id === id);
    dlg.close();
    chooseViewport(src, forNew);
  };
  $('screenGrid').onclick = $('windowGrid').onclick = pick;
}

function chooseViewport(src, forNew) {
  const vp = src.viewport;
  if (forNew || !draft) {
    const base = vp.kind === 'screen' ? vp.label : (vp.process || vp.title).replace(/\.exe$/i, '');
    const n = S.tasks.filter(t => t.name.startsWith(base)).length;
    const t = { id: uid(), name: `${base} task${n ? ' ' + (n + 1) : ''}`, viewport: vp, steps: [], triggers: [], repeat: 1, focus: true, enabled: true };
    S.tasks.push(t); unsaved.add(t.id);
    selId = t.id; draft = clone(t); selStep = null;
    renderTaskList(); renderEditor(); saveSoon(0);
    setTimeout(() => { $('taskName').focus(); $('taskName').select(); }, 50);
  } else {
    const before = draft.viewport;
    draft.viewport = vp;
    if (before && (before.kind !== vp.kind || before.hwnd !== vp.hwnd || before.displayId !== vp.displayId) && T.spots(stepsOf()).length) {
      toast('Viewport changed. Steps keep their relative spots; check them on the new preview.');
    }
    found.delete(draft.id);
    renderEditor(); saveSoon(0);
  }
  const target = draft.viewport;
  if (target.kind === 'window' && !target.launch) {
    ap.launchInfo(target).then(L => { if (L && draft && draft.viewport === target && !target.launch) { target.launch = L; saveSoon(); } }).catch(() => {});
  }
  startPreview();
}

// ---------- opening a closed window again ----------
const isClosedError = msg => /is not open|was closed/i.test(msg || '');
const canOpenVp = vp => !!(vp && vp.kind === 'window' && vp.launch && (vp.launch.path || vp.launch.aumid));
const progName = vp => vp?.process || (vp?.launch?.path || '').split(/[\\/]/).pop().replace(/\.exe$/i, '') || 'the program';
let opening = false;

async function openAgain() {
  if (!draft?.viewport) return;
  if (!canOpenVp(draft.viewport)) { openLaunchDlg(); return; }
  if (opening) return;
  opening = true;
  const id = draft.id;
  try {
    const vp = await tryIt(() => ap.openWindow(clone(draft.viewport), id));
    if (!vp || draft?.id !== id) return;
    draft.viewport = vp;
    saveSoon(0);
    toast(`Opened ${progName(vp)}.`);
    renderEditor();
    startPreview();
  } finally { opening = false; }
}

function openLaunchDlg() {
  if (draft?.viewport?.kind !== 'window') return;
  const L = draft.viewport.launch || {};
  $('lPath').value = L.path || '';
  $('lArgs').value = L.args || '';
  $('lAumid').value = L.aumid || '';
  $('lSettle').value = L.settle ?? 2;
  $('launchDlg').showModal();
  if (!L.path && !L.aumid) setTimeout(() => $('lPath').focus(), 30);
}

function saveLaunchDlg() {
  if (draft?.viewport?.kind !== 'window') return;
  const path = $('lPath').value.trim().replace(/^"(.*)"$/, '$1');
  const aumid = $('lAumid').value.trim();
  const settle = Math.max(0, Math.min(120, Number($('lSettle').value) || 0));
  if (path || aumid) draft.viewport.launch = { path, args: $('lArgs').value.trim(), aumid, settle };
  else delete draft.viewport.launch;
  saveSoon(0);
  renderStage();
}

function newTask() { flushSave(); openPicker(true); }

// ---------- find inputs ----------
async function findInputs() {
  if (!draft?.viewport) { openPicker(); return; }
  const method = $('findMethod').value;
  const id = draft.id;
  const r = await tryIt(() => ap.detect(draft.viewport, method));
  if (!r) return;
  found.set(id, r);
  $('showFound').checked = true;
  if (draft?.id === id) renderOverlay();
  const typable = r.items.filter(i => i.type === 'textbox' || i.type === 'textarea').length;
  toast(r.items.length ? `Found ${r.items.length} input${r.items.length === 1 ? '' : 's'} (${typable} text box${typable === 1 ? '' : 'es'}) in ${(r.ms / 1000).toFixed(1)} s. Click one to add a step.` : `No inputs found (${(r.ms / 1000).toFixed(1)} s).${method === 'uia' ? ' Try the AI instead.' : ''}`, !r.items.length, 6000);
}

// ---------- running ----------
let countdownTimer = null;
function cancelCountdown() { clearInterval(countdownTimer); countdownTimer = null; $('countdown').hidden = true; }
async function runNow() {
  if (!draft) return;
  await flushSave();
  if (!T.active(stepsOf()).length) { toast('Add a step first.', true); return; }
  const p = T.firstProblem(stepsOf(), keyError);
  if (p) { toast(`Step ${p.label}: ${p.message}`, true); selStep = p.id; renderSteps(); scrollStepIntoView(p.id); return; }
  let n = 3;
  const cd = $('countdown');
  const paint = () => (cd.innerHTML = `<div class="n">${n}</div><div class="msg">Let go of the mouse. Press ${esc(S.hotkey)} to stop at any time.</div><button class="btn" id="cdCancel">Cancel</button>`);
  paint(); cd.hidden = false;
  $('cdCancel').onclick = cancelCountdown;
  countdownTimer = setInterval(async () => {
    n--;
    if (n > 0) { paint(); $('cdCancel').onclick = cancelCountdown; return; }
    cancelCountdown();
    await tryIt(() => ap.runTask(draft.id, {}));
  }, 1000);
}
async function rehearse() {
  if (!draft) return;
  await flushSave();
  await tryIt(() => ap.runTask(draft.id, { rehearse: true }));
}

// ---------- settings ----------
async function openSettings() {
  const st = S.settings;
  $('setHost').value = st.ollamaHost; $('setTypeDelay').value = st.typeDelay; $('setTheme').value = st.theme;
  $('setFailsafe').checked = st.failsafe; $('setNotify').checked = st.notifyRuns; $('setTray').checked = st.closeToTray;
  const sel = $('setModel');
  sel.innerHTML = `<option>${esc(st.model)}</option>`; sel.value = st.model;
  $('modelNote').textContent = '';
  $('settingsDlg').showModal();
  try {
    const models = await ap.models();
    const vision = models.filter(m => m.vision && !/llama3\.2-vision/.test(m.name));
    const names = [...new Set([st.model, ...vision.map(m => m.name)])];
    sel.innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('');
    sel.value = st.model;
    $('modelNote').textContent = models.some(m => m.name === st.model) ? '' : 'not installed';
  } catch { $('modelNote').textContent = 'Ollama not reachable'; }
}
function bindSettings() {
  const set = (k, v) => tryIt(() => ap.setSetting(k, v));
  $('setHost').onchange = e => set('ollamaHost', e.target.value.trim().replace(/\/$/, ''));
  $('setModel').onchange = e => set('model', e.target.value);
  $('setTypeDelay').onchange = e => set('typeDelay', Math.max(0, Math.min(500, Number(e.target.value) || 0)));
  $('setTheme').onchange = e => set('theme', e.target.value);
  $('setFailsafe').onchange = e => set('failsafe', e.target.checked);
  $('setNotify').onchange = e => set('notifyRuns', e.target.checked);
  $('setTray').onchange = e => set('closeToTray', e.target.checked);
}

// ---------- wiring ----------
function bind() {
  applyIcons();
  $('newTaskBtn').onclick = newTask;
  $('settingsBtn').onclick = openSettings;
  $('pauseBtn').onclick = () => tryIt(() => ap.pauseTimers(!S.paused));
  $('themeBtn').onclick = () => { const v = darkQuery.matches ? 'light' : 'dark'; S.settings.theme = v; tryIt(() => ap.setSetting('theme', v)); };
  $('viewportChip').onclick = () => draft && openPicker();
  $('findBtn').onclick = findInputs;
  $('showFound').onchange = renderOverlay;
  $('freezeBtn').onclick = () => { frozen = !frozen; const v = $('video'); frozen ? v.pause() : v.play().catch(() => {}); $('freezeBtn').classList.toggle('on', frozen); };
  $('busyCancel').onclick = () => ap.cancelDetect();
  $('runBtn').onclick = runNow;
  $('rehearseBtn').onclick = rehearse;
  $('deleteTaskBtn').onclick = async () => {
    if (!draft || !confirm(`Delete the task "${draft.name}"? This cannot be undone.`)) return;
    const id = draft.id; savePending = false;
    await tryIt(() => ap.deleteTask(id));
    S.tasks = S.tasks.filter(t => t.id !== id);
    draft = null; selId = null; found.delete(id);
    stopStream(); renderTaskList(); renderEditor();
  };
  $('clearHistory').onclick = () => tryIt(() => ap.clearHistory());
  $('taskName').oninput = e => { draft.name = e.target.value || 'Untitled task'; saveSoon(); const li = $('taskList').querySelector(`[data-id="${draft.id}"] .name`); if (li) li.textContent = draft.name; };
  $('taskRepeat').onchange = e => { draft.repeat = Math.max(1, Math.min(10000, Math.round(Number(e.target.value) || 1))); e.target.value = draft.repeat; saveSoon(); };
  $('taskFocus').onchange = e => { draft.focus = e.target.checked; saveSoon(); };
  $('taskReopen').onchange = e => { draft.reopen = e.target.checked; saveSoon(); if (draft.reopen && !canOpenVp(draft.viewport)) openLaunchDlg(); };
  $('launchBtn').onclick = openLaunchDlg;
  $('lSave').onclick = () => saveLaunchDlg();
  $('lOpenNow').onclick = () => { saveLaunchDlg(); $('launchDlg').close(); openAgain(); };
  $('lBrowse').onclick = async () => { const p = await tryIt(() => ap.browseExe($('lPath').value.trim())); if (p) $('lPath').value = p; };
  $('taskEnabled').onchange = e => { draft.enabled = e.target.checked; for (const tr of draft.triggers || []) tr.next = null; renderTimerNext(); saveSoon(100); };
  for (const b of document.querySelectorAll('.tool')) b.onclick = () => setTool(b.dataset.tool);
  for (const b of document.querySelectorAll('.tab')) b.onclick = () => { tab = b.dataset.tab; renderEditor(); };
  for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => {
    const t = b.dataset.add;
    const s = addStep(t === 'key' ? { type: 'key', keys: 'Enter' } : t === 'wait' ? { type: 'wait', ms: 1000, after: 0 } : { type: 'type', text: '', enter: false });
    if (t === 'type') focusStepText(s.id);
  };
  for (const b of document.querySelectorAll('[data-addlogic]')) b.onclick = () => addStep(NEW_LOGIC[b.dataset.addlogic]());
  for (const b of document.querySelectorAll('[data-addtimer]')) b.onclick = () => addTimer(b.dataset.addtimer);
  $('taskList').onclick = e => {
    if (e.target.closest('.toggle')) return;
    const li = e.target.closest('[data-id]'); if (li) selectTask(li.dataset.id);
  };
  $('taskList').onchange = async e => {
    const id = e.target.dataset.en; if (!id) return;
    const t = S.tasks.find(x => x.id === id); if (!t) return;
    if (draft?.id === id) { draft.enabled = e.target.checked; $('taskEnabled').checked = e.target.checked; for (const tr of draft.triggers || []) tr.next = null; saveSoon(0); }
    else { const c = clone(t); c.enabled = e.target.checked; await tryIt(() => ap.saveTask(c)); }
  };
  $('steps').addEventListener('input', onStepInput);
  $('steps').addEventListener('change', e => { if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') onStepInput(e); });
  $('steps').addEventListener('click', onStepClick);
  $('steps').addEventListener('mousedown', onGripDown);
  window.addEventListener('mousemove', onDndMove);
  window.addEventListener('mouseup', onDndUp);
  $('timers').addEventListener('change', onTimerInput);
  $('timers').addEventListener('click', onTimerClick);
  $('overlay').addEventListener('mousedown', onOverlayDown);
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);
  $('pickerFilter').oninput = e => {
    const q = e.target.value.toLowerCase();
    for (const c of $('windowGrid').querySelectorAll('.source')) c.hidden = q && !c.textContent.toLowerCase().includes(q);
  };
  new ResizeObserver(() => layoutStage()).observe($('stageWrap'));
  $('video').addEventListener('resize', () => { const v = $('video'); if (v.videoWidth && (v.videoWidth !== view.w || v.videoHeight !== view.h)) { view.w = v.videoWidth; view.h = v.videoHeight; layoutStage(); } });
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    if (e.key === 'Escape') { if (countdownTimer) { cancelCountdown(); return; } if (dnd) { if (dnd.started) dnd.target = null; onDndUp(); return; } closePopover(); repickWhat = 'step'; if (repickStep || tool !== 'select') setTool('select'); return; }
    if (typing || e.ctrlKey || e.altKey || e.metaKey || document.body.classList.contains('mode-timers')) return;
    const t = TOOL_KEYS[e.key.toLowerCase()];
    if (t && draft) { setTool(t); e.preventDefault(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selStep && draft) { deleteStep(selStep); e.preventDefault(); }
  });
  bindSettings();
  ap.onState(applyState);
  ap.onBusy(b => {
    $('busy').hidden = !b;
    if (b) { $('busyLabel').textContent = b.label; $('busyBar').style.width = (b.pct || 5) + '%'; $('busyCancel').hidden = b.kind !== 'detect'; }
  });
  ap.onRunStep(r => {
    if (draft?.id !== r.taskId) return;
    runningStep = r.id;
    for (const li of $('steps').querySelectorAll('.step.running')) li.classList.remove('running');
    const li = $('steps').querySelector(`[data-step="${r.id}"]`);
    if (li) {
      li.classList.add('running');
      const row = li.querySelector(':scope > .step-row');
      if (r.result !== undefined && r.result !== null) { row.dataset.result = r.result ? 'yes → Then' : 'no → Otherwise'; row.title = r.detail || ''; }
      if (r.round) row.dataset.result = 'round ' + r.round;
    }
    ripple(r.fx, r.fy);
  });
  ap.onRunEnd(r => {
    runningStep = null;
    for (const li of $('steps').querySelectorAll('.step.running')) li.classList.remove('running');
    setTimeout(() => { for (const row of $('steps').querySelectorAll('.step-row[data-result]')) delete row.dataset.result; }, 4000);
    toast(`${r.by === 'rehearsal' ? 'Rehearsal' : `"${r.name}"`}: ${r.msg}`, !r.ok, 6000);
  });
  setInterval(() => { renderTimerNext(); if (S.tasks.some(t => nextOf(t))) renderTaskList(); }, 1000);
}

(async function init() {
  bind();
  MyTimers.bind();
  setTool('select');
  applyState(await ap.getState());
  if (S.tasks.length) selectTask(S.tasks[0].id);
  else renderEditor();
})();

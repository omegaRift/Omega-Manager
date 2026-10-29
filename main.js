// Omega Manager: Electron main process.
import { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, globalShortcut, Tray, Menu, Notification, nativeImage, nativeTheme, shell, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Native, uiaInputs } from './lib/native.js';
import { Store } from './lib/store.js';
import { Scheduler } from './lib/scheduler.js';
import { runTask, sleep, Stopped, describeStep, evalCond } from './lib/runner.js';
import { parseSourceId, matchWindow, rectToFraction, boxCenter, fitLongEdge } from './lib/geometry.js';
import { LIST_PROMPT, findPrompt, parseItems, parseFind, ollamaVision, ollamaModels } from './lib/detect.js';
import { validateTrigger } from './lib/schedule.js';
import { iconBitmap } from './lib/icon.js';
import { launchFromProcess, openWindow, adoptWindow, canOpen, programName, startProgram } from './lib/launch.js';
import * as Rem from './lib/reminders.js';
import { PhoneLink } from './lib/phone-link.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const HIDDEN = process.env.AP_HIDDEN === '1';        // tests: never show a window
const DRY = process.env.AP_DRY_INPUT === '1';        // tests: the helper never moves the mouse or types
const SMOKE = process.env.AP_SMOKE === '1';
export const HOTKEY = 'Ctrl+Alt+X';
// Saved tasks and timers stay in the folder the app used before it was renamed (%APPDATA%\screen-autopilot).
app.setPath('userData', process.env.AP_DATA_DIR || join(app.getPath('appData'), 'screen-autopilot'));
app.setName('Omega Manager');
if (!HIDDEN && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('LAB.OmegaManager');

let win = null, tray = null, store, native, scheduler;
let previewSource = null;
let current = null;          // { taskId, controller, rehearse }
let detecting = null;        // AbortController
let quitting = false;
let hotkeyOk = false;
// Starts a program. Tests (dry input) never start real programs; the smoke test swaps in a fake.
let launcher = DRY ? async () => { throw new Error('Opening programs is switched off in test mode.'); } : startProgram;
const launchCache = new Map();   // hwnd -> launch settings (or null when they can't be read)

// The icon from Omega.png at 1x, 1.5x and 2x so the tray stays sharp on scaled screens.
const icon = (state, size) => {
  const img = nativeImage.createEmpty();
  for (const sf of [1, 1.5, 2]) { const px = Math.round(size * sf); img.addRepresentation({ scaleFactor: sf, width: px, height: px, buffer: iconBitmap(px, state) }); }
  return img;
};
// Windows picks the right size for the title bar and taskbar from the .ico (node assets/make-icon.mjs rebuilds it).
const ICO = join(HERE, 'assets', 'icon.ico');
const appIcon = () => { const i = nativeImage.createFromPath(ICO); return i.isEmpty() ? icon('idle', 32) : i; };
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

// ---------- state for the window ----------
let stateTimer = null;
// ---------- my timers and their red notifications ----------
const alerts = new Map();          // alert id -> { win, alert }
let alertSeq = 0;
const ALERT_W = 452, ALERT_GAP = 10, ALERT_MARGIN = 14;
const myTimers = () => store.data.reminders || (store.data.reminders = []);
const myTimer = id => { const t = myTimers().find(x => x.id === id); if (!t) throw new Error('That timer no longer exists.'); return t; };

function alertView(id, a) {
  const t = a.timerId ? myTimers().find(x => x.id === a.timerId) : null;
  return { id, ...a, title: a.label || (t ? Rem.timerTitle(t) : a.preview ? 'Preview' : 'Timer'), canSnooze: !!t, snooze: Rem.SNOOZE_CHOICES };
}

// Dismiss / snooze / open, from the red window or from a phone.
function alertAction(id, action, minutes) {
  const entry = alerts.get(String(id));
  if (!entry) return false;
  if (action === 'snooze' && entry.alert.timerId) { Rem.snoozeTimer(myTimer(entry.alert.timerId), minutes, Date.now()); store.save(); }
  if (action === 'open') { showWindow(); send('show-mode', 'timers'); }
  if (!entry.win.isDestroyed()) entry.win.close();
  pushState();
  return true;
}

// ---------- phone link (Android app over Tailscale) ----------
const PHONE_SERVE_PORT = 8444;
const TAILSCALE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
let phone = null, phoneUrl = '', phoneServe = { ok: false, note: 'Checking Tailscale…' }, lastPhoneTimers = '';
const phoneTimers = () => myTimers().filter(t => t.state !== 'done').map(t => ({
  id: t.id, title: Rem.timerTitle(t), message: t.message, kind: t.kind, state: t.state, dueAt: t.dueAt, leftMs: t.state === 'paused' ? t.leftMs : null,
  durationMs: t.durationMs, daily: t.daily, time: t.time, snoozed: !!t.snoozed,
}));
const phoneSnapshot = () => ({ timers: phoneTimers(), alerts: [...alerts.entries()].map(([id, e]) => alertView(id, e.alert)) });
function phoneSync() {
  if (!phone) return;
  const j = JSON.stringify(phoneTimers());
  if (j !== lastPhoneTimers) { lastPhoneTimers = j; phone.broadcast('timers', { now: Date.now(), timers: JSON.parse(j) }); }
}
const tsJson = args => new Promise(resolve => execFile(TAILSCALE, args, { windowsHide: true, timeout: 8000 }, (e, out) => { try { resolve(e ? null : JSON.parse(out)); } catch { resolve(null); } }));
// The address phones use, and whether Tailscale serve forwards it to us.
async function checkTailscale() {
  const st = await tsJson(['status', '--json']);
  const dns = st?.Self?.DNSName?.replace(/\.$/, '');
  if (!dns) { phoneServe = { ok: false, note: 'Tailscale is not running on this PC.' }; pushState(); return; }
  phoneUrl = `https://${dns}:${PHONE_SERVE_PORT}`;
  const sv = await tsJson(['serve', 'status', '--json']);
  const proxy = sv?.Web?.[`${dns}:${PHONE_SERVE_PORT}`]?.Handlers?.['/']?.Proxy || '';
  phoneServe = proxy.endsWith(`:${phone?.port}`)
    ? { ok: true, note: 'Tailscale serve is forwarding this address to Omega Manager.' }
    : { ok: false, note: `Tailscale serve is not set up for port ${PHONE_SERVE_PORT}. Run: tailscale serve --bg --https=${PHONE_SERVE_PORT} http://127.0.0.1:${phone?.port || 5191}` };
  pushState();
}

function checkMyTimers() {
  const now = Date.now();
  const due = Rem.dueTimers(myTimers(), now);
  if (!due.length) return;
  for (const t of due) showAlert(Rem.fireTimer(t, now));
  store.save();
  pushState();
}

// A red always-on-top card in the bottom-right corner. It never takes the keyboard focus and stays until dismissed.
function showAlert(a) {
  const id = String(++alertSeq);
  const w = new BrowserWindow({
    width: ALERT_W, height: 200, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: true, title: 'Omega Manager alert',
    backgroundColor: '#d32f2f', icon: appIcon(),
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.removeMenu();
  alerts.set(id, { win: w, alert: a });
  w.on('closed', () => { alerts.delete(id); layoutAlerts(); pushState(); phone?.broadcast('alert-closed', { id }); });
  phone?.broadcast('alert', alertView(id, a));
  w.loadFile(join(HERE, 'ui', 'alert.html'), { query: { id } });
  if (!HIDDEN) w.once('ready-to-show', () => { layoutAlerts(); w.showInactive(); });
  layoutAlerts();
  pushState();
  return id;
}

function layoutAlerts() {
  const wa = screen.getPrimaryDisplay().workArea;
  let bottom = wa.y + wa.height - ALERT_MARGIN;
  for (const { win: w } of [...alerts.values()].reverse()) {     // newest at the bottom, older ones stack above
    if (w.isDestroyed()) continue;
    const h = w.getBounds().height;
    w.setBounds({ x: wa.x + wa.width - ALERT_W - ALERT_MARGIN, y: Math.max(wa.y, bottom - h), width: ALERT_W, height: h });
    bottom -= h + ALERT_GAP;
  }
  updateTray();
}

function closeAlertsFor(timerId) {
  for (const { win: w, alert } of alerts.values()) if (alert.timerId === timerId && !w.isDestroyed()) w.close();
}

function pushState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { send('state', publicState()); updateTray(); phoneSync(); }, 50);
}
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.save(), 1000); }

function publicState() {
  return {
    tasks: store.tasks, settings: store.settings, history: store.data.history.slice(0, 60),
    running: current ? { taskId: current.taskId, rehearse: current.rehearse } : null,
    paused: scheduler?.paused || false, queue: (scheduler?.queue || []).map(q => q.task.id),
    hotkey: HOTKEY, hotkeyOk, dry: DRY, now: Date.now(),
    reminders: myTimers(), alerts: alerts.size,
    phone: phone ? { ...phone.status(), url: phoneUrl, serve: phoneServe } : null,
  };
}

// ---------- viewports ----------
function displayFor(vp) {
  const all = screen.getAllDisplays();
  return all.find(d => String(d.id) === String(vp.displayId)) || null;
}

// Where a viewport is on the desktop right now, in physical pixels.
async function resolveViewport(vp) {
  if (!vp) throw new Error('Choose a viewport (a screen or a window) for this task first.');
  if (vp.kind === 'screen') {
    const d = displayFor(vp);
    if (!d) throw new Error(`The screen "${vp.label || vp.displayId}" is not connected.`);
    const r = screen.dipToScreenRect(null, d.bounds);
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, sourceId: vp.sourceId };
  }
  const wins = await native.windows();
  const w = matchWindow(vp, wins);
  if (!w) throw new Error(`The window "${vp.title}" (${vp.process || 'unknown program'}) is not open.`);
  if (w.hwnd !== vp.hwnd) { vp.hwnd = w.hwnd; vp.sourceId = `window:${w.hwnd}:0`; saveSoon(); }
  if (!canOpen(vp)) { const L = await launchFor(w); if (L) { vp.launch = L; saveSoon(); } }
  const [x, y, ww, hh] = w.rect || [0, 0, 0, 0];
  return { rect: { x, y, w: ww, h: hh }, hwnd: w.hwnd, minimized: w.minimized, sourceId: vp.sourceId, title: w.title };
}

// How the program behind a window was started (exe path, arguments, Store app id).
async function launchFor(w) {
  if (!w?.pid) return null;
  if (launchCache.has(w.hwnd)) return launchCache.get(w.hwnd);
  const L = launchFromProcess(await native.procinfo(w.pid).catch(() => ({})));
  launchCache.set(w.hwnd, L);
  return L;
}

// Open a closed window's program again and point the viewport at its new window (changes vp in place).
async function reopenWindow(vp, signal) {
  const name = programName(vp);
  const t0 = Date.now();
  send('busy', { kind: 'open', label: `Opening ${name}…`, pct: 3 });
  try {
    const w = await openWindow(vp, {
      windows: () => native.windows(),
      start: L => launcher(L),
      sleep: ms => sleep(ms, signal),
      now: () => Date.now(),
      onProgress: p => send('busy', { kind: 'open', label: `Opening ${name}… waiting for its window (${Math.round((Date.now() - t0) / 1000)} s)`, pct: 5 + p * 90 }),
    }, { timeoutMs: SMOKE ? 8000 : 30e3 });
    Object.assign(vp, adoptWindow(vp, w));
    for (const t of store.data.tasks) if (t.viewport && t.viewport !== vp && t.viewport.kind === 'window' && matchWindow(t.viewport, [w])) Object.assign(t.viewport, adoptWindow(t.viewport, w));
    saveSoon();
    return vp;
  } finally { send('busy', null); }
}

async function listSources() {
  const own = win && !win.isDestroyed() ? win.getMediaSourceId() : '';
  const [sources, wins] = await Promise.all([
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true }),
    native.windows().catch(() => []),
  ]);
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay().id;
  const out = [];
  for (const s of sources) {
    if (s.id === own) continue;
    const p = parseSourceId(s.id);
    if (!p) continue;
    const base = { id: s.id, name: s.name, thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(), appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null };
    if (p.kind === 'screen') {
      const d = displays.find(x => String(x.id) === String(s.display_id)) || displays[p.index] || displays[0];
      const i = displays.indexOf(d);
      const r = screen.dipToScreenRect(null, d.bounds);
      const label = displays.length > 1 ? `Screen ${i + 1}${d.id === primary ? ' (main)' : ''}` : 'Entire screen';
      out.push({ ...base, viewport: { kind: 'screen', displayId: String(d.id), sourceId: s.id, label }, size: [r.width, r.height] });
    } else {
      const w = wins.find(x => x.hwnd === p.hwnd);
      if (w && w.process && /^(screen-autopilot|electron|omega manager)$/i.test(w.process) && /^Omega Manager/.test(w.title)) continue;
      out.push({ ...base, viewport: { kind: 'window', hwnd: p.hwnd, sourceId: s.id, title: w?.title || s.name, process: w?.process || '', pid: w?.pid, label: s.name }, size: w ? [w.rect[2], w.rect[3]] : null, minimized: !!w?.minimized });
    }
  }
  return out;
}

// A still picture of the viewport, long edge at most `maxEdge` (for the vision model).
async function capture(vp, maxEdge = 1280) {
  const view = await resolveViewport(vp);
  if (view.minimized) throw new Error('The window is minimized. Restore it so it can be seen.');
  const size = fitLongEdge(view.rect.w || 1280, view.rect.h || 720, maxEdge);
  const sources = await desktopCapturer.getSources({ types: [vp.kind], thumbnailSize: { width: size.w, height: size.h } });
  let src = vp.kind === 'screen' ? sources.find(s => String(s.display_id) === String(vp.displayId)) : sources.find(s => s.id === `window:${view.hwnd}:0`);
  if (!src && vp.kind === 'screen' && sources.length === 1) src = sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Could not capture the viewport. Is the window on screen?');
  const img = src.thumbnail;
  const s = img.getSize();
  return { img, w: s.width, h: s.height, view };
}

// ---------- finding inputs ----------
async function detect(vp, method = 'ai') {
  if (detecting) detecting.abort();
  const ctrl = new AbortController();
  detecting = ctrl;
  const t0 = Date.now();
  const progress = (label, pct) => send('busy', { kind: 'detect', label, pct });
  try {
    if (method === 'uia') {
      if (vp.kind !== 'window') throw new Error('Windows accessibility works on a window viewport. Choose a window, or use the AI.');
      progress('Reading the window\'s controls…', 30);
      const view = await resolveViewport(vp);
      const raw = await uiaInputs(view.hwnd);
      const r = view.rect;
      const items = raw
        .filter(e => e.rect[0] + e.rect[2] > r.x && e.rect[1] + e.rect[3] > r.y && e.rect[0] < r.x + r.w && e.rect[1] < r.y + r.h)
        .map(e => ({ type: e.type || 'other', label: e.label, ...rectToFraction(r, { x: e.rect[0], y: e.rect[1], w: e.rect[2], h: e.rect[3] }), source: 'uia' }));
      return { items, ms: Date.now() - t0, method };
    }
    progress('Capturing the viewport…', 10);
    const shot = await capture(vp);
    progress(`Asking ${store.settings.model} to find inputs…`, 35);
    const tick = setInterval(() => progress(`Asking ${store.settings.model} to find inputs… ${Math.round((Date.now() - t0) / 1000)} s`, Math.min(92, 35 + (Date.now() - t0) / 400)), 1000);
    try {
      const r = await aiListImage(shot.img, ctrl.signal);
      return { ...r, ms: Date.now() - t0, method };
    } finally { clearInterval(tick); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Cancelled.');
    throw e;
  } finally {
    if (detecting === ctrl) detecting = null;
    send('busy', null);
  }
}

// Ask the vision model for every input on a picture. Boxes come back as fractions of the picture.
async function aiListImage(img, signal) {
  const { width, height } = img.getSize();
  const ans = await ollamaVision({ host: store.settings.ollamaHost, model: store.settings.model, prompt: LIST_PROMPT, pngBase64: img.toPNG().toString('base64'), signal });
  return { items: parseItems(ans.content, width, height), truncated: ans.doneReason === 'length' };
}

async function aiFind(vp, describe, signal) {
  const shot = await capture(vp);
  const ans = await ollamaVision({ host: store.settings.ollamaHost, model: store.settings.model, prompt: findPrompt(describe), pngBase64: shot.img.toPNG().toString('base64'), numPredict: 400, signal });
  const box = parseFind(ans.content, shot.w, shot.h);
  return box ? { ...boxCenter(box), box } : null;
}

// Colour of a spot (3x3 average), from a full-size capture.
async function pixelAt(vp, fx, fy) {
  const view = await resolveViewport(vp);
  const shot = await capture(vp, Math.max(view.rect.w, view.rect.h, 64));
  const bmp = shot.img.toBitmap();          // BGRA
  const cx = Math.round(fx * (shot.w - 1)), cy = Math.round(fy * (shot.h - 1));
  const sum = [0, 0, 0]; let n = 0;
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
    if (x < 0 || y < 0 || x >= shot.w || y >= shot.h) continue;
    const o = (y * shot.w + x) * 4;
    sum[0] += bmp[o + 2]; sum[1] += bmp[o + 1]; sum[2] += bmp[o]; n++;
  }
  return sum.map(v => v / n);
}

const conditionChecks = signal => ({
  windows: () => native.windows(),
  pixel: (vp, fx, fy) => pixelAt(vp, fx, fy),
  aiSees: async (vp, d) => !!(await aiFind(vp, d, signal)),
});

// ---------- running ----------
async function run(taskId, { rehearse = false, trigger = null } = {}) {
  const task = store.task(taskId);
  if (!task) throw new Error('That task no longer exists.');
  if (current) throw new Error('Another task is running. Stop it first (' + HOTKEY + ').');
  const controller = new AbortController();
  current = { taskId, controller, rehearse };
  const t0 = Date.now();
  task.runCount = (task.runCount || 0) + (rehearse ? 0 : 1);
  pushState();
  if (trigger && store.settings.notifyRuns && Notification.isSupported() && !HIDDEN) {
    new Notification({ title: `Running "${task.name}"`, body: `Started by its timer. Press ${HOTKEY} to stop.`, silent: true }).show();
  }
  // Keep this window out of the way so clicks land on the viewport, not on us.
  const hideSelf = !rehearse && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (hideSelf) { win.minimize(); await sleep(250); }
  let ok = true, msg = '', opened = '';
  try {
    if (!rehearse && task.viewport?.kind === 'window') {
      try { await resolveViewport(task.viewport); }
      catch (e) {
        if (!/is not open/.test(e.message)) throw e;
        if (!task.reopen) throw new Error(e.message + ' Tick "Open the window if it is closed" to have it opened for you.');
        await reopenWindow(task.viewport, controller.signal);
        opened = `opened ${programName(task.viewport)} first; `;
        pushState();
      }
    }
    const r = await runTask(task, {
      resolve: resolveViewport,
      input: native,
      aiFind: (vp, d) => aiFind(vp, d, controller.signal),
      check: conditionChecks(controller.signal),
      sleep,
      onStep: (s, p) => send('run-step', { taskId, id: s.id, label: describeStep(s), fx: p.fx, fy: p.fy, round: p.round, result: p.result, detail: p.detail, rehearse }),
    }, { rehearse, failsafe: store.settings.failsafe, signal: controller.signal, run: task.runCount, typeDelay: store.settings.typeDelay });
    msg = `${opened}${r.steps} step${r.steps === 1 ? '' : 's'} done${r.rounds > 1 ? ` (${r.rounds} rounds)` : ''}${r.ended ? ', ended by a Stop step' : ''}${r.notes.length ? '; ' + r.notes.join('; ') : ''}`;
  } catch (e) {
    ok = false;
    msg = e.message;
    if (!(e instanceof Stopped) && trigger && Notification.isSupported() && !HIDDEN) new Notification({ title: `"${task.name}" failed`, body: msg }).show();
  } finally {
    current = null;
    if (hideSelf && win && !win.isDestroyed()) win.restore();
  }
  const entry = { at: t0, taskId, name: task.name, by: rehearse ? 'rehearsal' : trigger ? 'timer' : 'you', ok, ms: Date.now() - t0, msg };
  if (!rehearse) store.addHistory(entry); else store.save();
  send('run-end', entry);
  pushState();
  return entry;
}

function stopAll(reason = 'Stopped.') {
  if (current) current.controller.abort(new Error(reason));
  scheduler?.clearQueue();
  pushState();
}

// ---------- tasks ----------
const triggerKey = t => JSON.stringify([t.kind, t.every, t.unit, t.maxRuns, t.time, t.days, t.at, t.enabled !== false]);
function saveTask(incoming) {
  const old = incoming.id ? store.task(incoming.id) : null;
  for (const tr of incoming.triggers || []) {
    const err = validateTrigger(tr);
    if (err) tr.problem = err; else delete tr.problem;
    const prev = old?.triggers?.find(x => x.id === tr.id);
    if (prev && triggerKey(prev) === triggerKey(tr) && (old.enabled !== false) === (incoming.enabled !== false)) {
      tr.next = prev.next; tr.runs = prev.runs; tr.lastRun = prev.lastRun;   // unchanged: keep its countdown
    } else {
      tr.next = null;
      if (prev && prev.kind === tr.kind && tr.kind === 'interval') tr.runs = 0;
      if (tr.kind === 'once' && (!prev || prev.at !== tr.at)) tr.runs = 0;
    }
  }
  if (old) incoming.runCount = old.runCount;
  const ov = old?.viewport, nv = incoming.viewport;
  if (ov?.launch && nv?.kind === 'window' && !nv.launch && ov.kind === 'window' && (ov.process || '') === (nv.process || '')) nv.launch = ov.launch;
  const t = store.upsertTask(incoming);
  scheduler.plan();
  pushState();
  return t;
}

// ---------- window, tray, hotkey ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 860, minWidth: 980, minHeight: 620, show: false, title: 'Omega Manager',
    icon: appIcon(), backgroundColor: nativeTheme.shouldUseDarkColors ? '#12161b' : '#f3f5f7', autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(join(HERE, 'ui', 'index.html'));
  if (!HIDDEN) win.once('ready-to-show', () => win.show());
  win.on('close', e => {
    if (!quitting && store.settings.closeToTray && !HIDDEN) {
      e.preventDefault(); win.hide();
      if (!store.data.trayHintShown && Notification.isSupported()) {
        store.data.trayHintShown = true; store.save();
        new Notification({ title: 'Omega Manager is still running', body: 'Timers keep working from the tray icon. Right-click it to quit.', silent: true }).show();
      }
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Live preview: getDisplayMedia() in the window gets whichever source was picked last.
  win.webContents.session.setDisplayMediaRequestHandler(async (_req, callback) => {
    // Answer exactly once: an empty answer (the window is gone) can throw after it has been delivered.
    let s = null;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      s = sources.find(x => x.id === previewSource) || null;
    } catch { /* no source: refuse below */ }
    try { callback(s ? { video: s } : {}); } catch { /* the page sees the refusal and falls back */ }
  });
}

function updateTray() {
  if (!tray) return;
  const state = alerts.size ? 'alert' : current ? 'running' : scheduler?.paused ? 'paused' : 'idle';
  tray.setImage(icon(state, 16));
  const t = current && store.task(current.taskId);
  const next = myTimers().filter(x => x.state === 'running' && x.dueAt).sort((a, b) => a.dueAt - b.dueAt)[0];
  tray.setToolTip(`Omega Manager — ${t ? `running "${t.name}"` : scheduler?.paused ? 'timers paused' : 'timers on'}${next ? `\nNext: ${Rem.timerTitle(next)} at ${new Date(next.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Omega Manager', click: showWindow },
    { label: 'My timers', click: () => { showWindow(); send('show-mode', 'timers'); } },
    { label: 'Dismiss all alerts', enabled: alerts.size > 0, click: () => { for (const { win: w } of alerts.values()) if (!w.isDestroyed()) w.close(); } },
    { type: 'separator' },
    { label: `Stop running task (${HOTKEY})`, enabled: !!current, click: () => stopAll(`Stopped from the tray.`) },
    { label: scheduler?.paused ? 'Resume timers' : 'Pause all timers', click: () => { scheduler.setPaused(!scheduler.paused); pushState(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function showWindow() { if (!win || win.isDestroyed()) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

// ---------- IPC ----------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}
handle('get-state', () => publicState());
handle('list-sources', () => listSources());
handle('set-preview', id => { previewSource = id; return true; });
handle('resolve-viewport', async vp => { const v = await resolveViewport(vp); return { rect: v.rect, sourceId: v.sourceId, minimized: !!v.minimized, title: v.title, launch: vp.launch || null }; });
handle('save-task', t => saveTask(t));
handle('timer-create', input => { const t = Rem.createTimer(input || {}, Date.now(), randomUUID()); myTimers().push(t); store.save(); pushState(); return t; });
handle('timer-edit', (id, fields) => { const t = Rem.editTimer(myTimer(id), fields || {}); store.save(); pushState(); return t; });
handle('timer-action', (id, action) => {
  const now = Date.now();
  if (action === 'clear-done') { store.data.reminders = myTimers().filter(t => t.state !== 'done'); }
  else {
    const t = myTimer(id);
    if (action === 'pause') Rem.pauseTimer(t, now);
    else if (action === 'resume') Rem.resumeTimer(t, now);
    else if (action === 'restart') { closeAlertsFor(id); Rem.restartTimer(t, now); }
    else if (action === 'delete') { closeAlertsFor(id); store.data.reminders = myTimers().filter(x => x.id !== id); }
    else throw new Error('Unknown timer action ' + action);
  }
  store.save(); pushState();
  return true;
});
handle('timer-preview', input => showAlert({ timerId: null, preview: true, label: String(input?.label || '').trim(), message: String(input?.message || '').trim(), sound: input?.sound !== false, dueAt: Date.now(), late: false, firedAt: Date.now() }));
handle('alert-info', id => {
  const a = alerts.get(String(id))?.alert;
  if (!a) throw new Error('This alert is gone.');
  return alertView(String(id), a);
});
handle('alert-size', (id, h) => {
  const w = alerts.get(String(id))?.win;
  if (w && !w.isDestroyed()) { w.setBounds({ ...w.getBounds(), height: Math.max(120, Math.min(560, Math.round(h))) }); layoutAlerts(); }
  return true;
});
handle('alert-action', (id, action, minutes) => alertAction(id, action, minutes));
handle('phone-pair', () => { if (!phone) throw new Error('The phone link is switched off.'); return phone.newPairCode(); });
handle('phone-cancel-pair', () => { phone?.cancelPairing(); return true; });
handle('phone-remove', id => { phone?.removeDevice(id); return true; });
handle('phone-check', async () => { await checkTailscale(); return { url: phoneUrl, serve: phoneServe }; });
handle('launch-info', async vp => {
  if (vp?.kind !== 'window') return null;
  return launchFor(matchWindow(vp, await native.windows()));
});
handle('open-window', async (vp, taskId) => {
  if (current) throw new Error('A task is running. Stop it first (' + HOTKEY + ').');
  const target = (taskId && store.task(taskId)?.viewport) || vp;
  if (target !== vp && vp.launch) target.launch = vp.launch;   // the editor may have just changed how to open it
  await reopenWindow(target);
  pushState();
  return target;
});
handle('browse-exe', async current => {
  const r = await dialog.showOpenDialog(win, { title: 'Which program opens this window?', defaultPath: current || undefined, properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] }, { name: 'Any file', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
handle('delete-task', id => { if (current?.taskId === id) stopAll('Task deleted.'); store.deleteTask(id); pushState(); return true; });
handle('run-task', (id, opts) => run(id, opts || {}));
handle('stop-all', () => { stopAll('Stopped.'); return true; });
handle('detect', (vp, method) => detect(vp, method));
handle('cancel-detect', () => { detecting?.abort(); return true; });
handle('ai-find', async (vp, d) => {
  send('busy', { kind: 'find', label: `Looking for "${d}"…`, pct: 50 });
  try { return await aiFind(vp, d); } finally { send('busy', null); }
});
handle('check-cond', async (vp, cond) => {
  if (cond?.kind === 'ai') send('busy', { kind: 'find', label: `Looking for "${cond.describe}"…`, pct: 50 });
  try { return await evalCond(cond, vp, { check: conditionChecks() }); } finally { if (cond?.kind === 'ai') send('busy', null); }
});
handle('set-setting', (k, v) => { store.setSetting(k, v); if (k === 'theme') nativeTheme.themeSource = v; pushState(); return true; });
handle('pause-timers', p => { scheduler.setPaused(p); pushState(); return true; });
handle('models', () => ollamaModels({ host: store.settings.ollamaHost }));
handle('clear-history', () => { store.data.history = []; store.save(); pushState(); return true; });

// ---------- start ----------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (HIDDEN || !store?.settings.closeToTray) app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); scheduler?.stop(); native?.stop(); phone?.stop(); try { store?.save(); } catch { } });

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  nativeTheme.themeSource = store.settings.theme || 'system';
  native = new Native({ dry: DRY, log: m => console.log(m) });
  native.start().catch(e => console.error(e.message));
  scheduler = new Scheduler({
    tasks: () => store.tasks,
    runTask: (task, trigger) => run(task.id, { trigger }),
    onChange: () => { saveSoon(); pushState(); },
  });
  scheduler.start();
  createWindow();
  // Phone link: phones on the tailnet connect through Tailscale serve (port 8444 -> 127.0.0.1:5191).
  const phonePort = process.env.AP_PHONE_PORT ?? (SMOKE ? '0' : '5191');
  if (phonePort !== 'off') {
    phone = new PhoneLink({
      store, port: Number(phonePort), apkPath: join(HERE, 'android', 'dist', 'omega-manager.apk'),
      snapshot: phoneSnapshot, onAction: (id, a, m) => alertAction(id, a, m), onChange: pushState,
    });
    phone.start().then(() => { if (!SMOKE) checkTailscale(); }).catch(e => { console.error('phone link:', e.message); phone = null; phoneServe = { ok: false, note: `The phone link could not start: ${e.message}` }; pushState(); });
  }
  // My timers: anything that went off while the app was closed shows right away (marked late).
  setInterval(checkMyTimers, 500);
  win.webContents.once('did-finish-load', checkMyTimers);
  hotkeyOk = globalShortcut.register(HOTKEY, () => stopAll(`Stopped by ${HOTKEY}.`));
  if (!HIDDEN) { tray = new Tray(icon('idle', 16)); tray.on('click', showWindow); updateTray(); }
  if (SMOKE) {
    const { smoke } = await import('./test/smoke-driver.js');
    smoke({ win, store, native, scheduler, internals: { run, detect, capture, aiListImage, resolveViewport, listSources, saveTask, stopAll, reopenWindow, setLauncher: fn => { launcher = fn; }, alerts, checkMyTimers, phone: () => phone } })
      .then(code => { quitting = true; app.exit(code); })
      .catch(e => { console.error('SMOKE ERROR', e); quitting = true; app.exit(1); });
  }
});

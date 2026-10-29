// Runs inside the real app (AP_SMOKE=1, hidden window, dry input helper). Started by test/smoke.js.
import { nativeImage, nativeTheme, screen } from 'electron';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiaInputs } from '../lib/native.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.AP_SMOKE_OUT;
const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

async function until(fn, ms = 10e3, step = 100) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await wait(step); }
}

export async function smoke({ win, store, native, scheduler, internals }) {
  mkdirSync(OUT, { recursive: true });
  const wc = win.webContents;
  watchConsole(wc);
  const js = code => wc.executeJavaScript(code, true);
  await until(() => !wc.isLoading() && js('typeof selectTask === "function" && !!window.ap').catch(() => false), 15e3);
  await js('window.confirm = () => true; window.alert = () => {}; true');

  // Record every helper call (the helper is dry: it reports instead of acting).
  const calls = [];
  const origCall = native.call.bind(native);
  native.call = (cmd, args, t) => { if (cmd !== 'windows') calls.push({ cmd, ...args }); return origCall(cmd, args, t); };

  const info = await native.start();
  ok(info.dry === true, 'input helper is in dry mode');

  // 1. Sources: screens and windows, with HWNDs the helper knows.
  const sources = await internals.listSources();
  const screens = sources.filter(s => s.viewport.kind === 'screen');
  const windows = sources.filter(s => s.viewport.kind === 'window');
  ok(screens.length >= 1, `found ${screens.length} screen(s) and ${windows.length} window(s)`);
  ok(windows.every(w => w.viewport.hwnd > 0), 'window sources carry their HWND');
  ok(windows.length === 0 || windows.some(w => w.viewport.process), 'window sources are matched to a program name');
  ok(!sources.some(s => s.id === win.getMediaSourceId()), 'our own window is not offered as a viewport');
  if (windows[0]) {
    const v = await internals.resolveViewport(windows[0].viewport);
    ok(v.rect.w > 0 && v.rect.h > 0 && v.hwnd === windows[0].viewport.hwnd, `window viewport resolves to its rect (${v.rect.w}x${v.rect.h})`);
    try {
      const t0 = Date.now();
      const u = await uiaInputs(v.hwnd, 20e3);
      ok(Array.isArray(u), `Windows accessibility read "${windows[0].viewport.process}": ${u.length} controls in ${Date.now() - t0} ms`);
    } catch (e) { ok(/took too long/.test(e.message), 'Windows accessibility: ' + e.message); }
  }

  // 2. New task through the UI: pick the first screen.
  await js(`openPicker(true)`);
  await until(() => js(`!!document.querySelector('#screenGrid [data-src]')`), 10e3);
  await js(`document.querySelector('#screenGrid [data-src]').click()`);
  const task = await until(() => store.tasks[0], 5e3);
  ok(task && task.viewport?.kind === 'screen', `task created on "${task?.viewport?.label}"`);
  const preview = await until(() => js(`view.ok && view.w > 0 ? [view.w, view.h] : null`), 15e3, 200);
  ok(!!preview, `live preview stream runs in a hidden window (${preview})`);
  if (!preview) console.log('  preview error:', await js('view.error'));

  // Swap the live picture for the fixture form so screenshots never show this PC's screen.
  const fixture = nativeImage.createFromPath(join(HERE, 'fixtures', 'form-1280.png'));
  ok(!fixture.isEmpty(), 'fixture picture loads');
  await js(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(fixture.toDataURL())}; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    setInterval(() => g.drawImage(img, 0, 0), 200);
    stopStream(); stream = c.captureStream(5); const v = document.getElementById('video'); v.srcObject = stream; await v.play();
    view.w = img.width; view.h = img.height; view.ok = true; renderStage(); return true; })()`);

  // 3. AI finds the inputs on the fixture (real Ollama call).
  let items = [];
  if (process.env.AP_SMOKE_NO_AI !== '1') {
    try {
      const t0 = Date.now();
      const r = await internals.aiListImage(fixture);
      items = r.items;
      const truth = JSON.parse(readFileSync(join(HERE, 'fixtures', 'form-1280.json'), 'utf8'));
      const W = truth.size.width, H = truth.size.height;
      let hits = 0;
      for (const t of truth.rects.filter(r => r.id !== 'gift')) {
        const cx = (t.x + t.w / 2) / W, cy = (t.y + t.h / 2) / H;
        if (items.some(i => cx >= i.fx1 && cx <= i.fx2 && cy >= i.fy1 && cy <= i.fy2)) hits++;
      }
      ok(hits >= 6, `AI found ${items.length} inputs in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${hits}/7 true inputs have their centre inside a found box`);
      ok(items.filter(i => i.type === 'textbox').length >= 3, 'AI marks the text boxes as text boxes');
    } catch (e) { ok(false, 'AI detection: ' + e.message); }
  } else console.log('skip AI detection (AP_SMOKE_NO_AI=1)');
  if (!items.length) items = [{ type: 'textbox', label: 'Customer name', fx1: 0.031, fy1: 0.136, fx2: 0.267, fy2: 0.184, source: 'ai' }];
  await js(`found.set(draft.id, { items: ${JSON.stringify(items)}, method: 'ai' }); renderOverlay(); true`);

  // 4. Place steps by clicking the preview (real mouse events inside the hidden window, not the OS cursor).
  const stage = await js(`(() => { const r = document.getElementById('overlay').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const clickAt = async (fx, fy) => {
    const x = Math.round(stage.x + fx * stage.w), y = Math.round(stage.y + fy * stage.h);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await wait(150);
  };
  await js(`setTool('click')`);
  await clickAt(0.8, 0.8);
  // Type into the first found text box (snaps to its centre).
  const tb = items.find(i => i.type === 'textbox') || items[0];
  await js(`setTool('type')`);
  await clickAt((tb.fx1 + tb.fx2) / 2 + 0.01, (tb.fy1 + tb.fy2) / 2);
  await js(`(() => { const t = document.querySelector('#steps .step.sel [data-f=text]'); t.value = 'Order {run}'; t.dispatchEvent(new Event('input', { bubbles: true }));
    const e = document.querySelector('#steps .step.sel [data-f=enter]'); e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await js(`setTool('scroll')`);
  await clickAt(0.5, 0.6);
  await js(`document.querySelector('[data-add=key]').click(); true`);
  await js(`(() => { const k = document.querySelector('#steps .step.sel [data-f=keys]'); k.value = 'ctrl+s'; k.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await js(`setTool('select'); flushSave()`);
  const saved = await until(() => store.task(task.id)?.steps?.length === 4 && store.task(task.id), 5e3);
  ok(!!saved, `4 steps saved (${store.task(task.id)?.steps?.map(s => s.type).join(', ')})`);
  const st = saved ? saved.steps : [];
  ok(st[0] && Math.abs(st[0].fx - 0.8) < 0.01 && Math.abs(st[0].fy - 0.8) < 0.01, `click step at 80%/80% (${st[0]?.fx?.toFixed(3)}, ${st[0]?.fy?.toFixed(3)})`);
  const tbc = { fx: (tb.fx1 + tb.fx2) / 2, fy: (tb.fy1 + tb.fy2) / 2 };
  ok(st[1] && Math.abs(st[1].fx - tbc.fx) < 1e-6 && st[1].text === 'Order {run}' && st[1].enter && st[1].name === tb.label, `type step snapped to "${tb.label}" with its text`);
  ok(st[3]?.keys === 'ctrl+s', 'key step keeps Ctrl+S');

  // Drag the click pin somewhere else.
  const pinXY = { x: Math.round(stage.x + 0.8 * stage.w), y: Math.round(stage.y + 0.8 * stage.h) };
  wc.sendInputEvent({ type: 'mouseDown', ...pinXY, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) wc.sendInputEvent({ type: 'mouseMove', x: pinXY.x - i * 0.02 * stage.w, y: pinXY.y, button: 'left' });
  wc.sendInputEvent({ type: 'mouseUp', x: Math.round(pinXY.x - 0.1 * stage.w), y: pinXY.y, button: 'left', clickCount: 1 });
  await wait(100); await js('flushSave()'); await wait(300);
  ok(Math.abs(store.task(task.id).steps[0].fx - 0.7) < 0.01, `dragging a pin moves its step (now ${store.task(task.id).steps[0].fx.toFixed(3)})`);

  await shot(win, 'main.png');

  // 5. Run for real through the dry helper: right screen pixels, right order.
  const view = await internals.resolveViewport(task.viewport);
  calls.length = 0;
  const r1 = await internals.run(task.id, {});
  ok(r1.ok, `run finished: ${r1.msg}`);
  const acts = calls.filter(c => c.cmd !== 'cursor');
  const R = view.rect, px = (fx, fy) => [Math.round(R.x + fx * (R.w - 1)), Math.round(R.y + fy * (R.h - 1))];
  const s0 = store.task(task.id).steps;
  const want = [
    ['click', ...px(s0[0].fx, s0[0].fy)],
    ['click', ...px(s0[1].fx, s0[1].fy)], ['type'], ['keys'],
    ['scroll', ...px(s0[2].fx, s0[2].fy)],
    ['keys'],
  ];
  const got = acts.map(c => [c.cmd, ...(c.x != null ? [c.x, c.y] : [])]);
  ok(JSON.stringify(got) === JSON.stringify(want), `helper got ${JSON.stringify(got)}`);
  ok(Buffer.from(acts[2]?.text64 || '', 'base64').toString() === 'Order 1', 'typed text has {run} filled in');
  ok(JSON.stringify(acts[3]?.vks) === '[13]' && JSON.stringify(acts[5]?.vks) === '[17,83]', 'Enter and Ctrl+S key codes');
  ok(acts[4]?.clicks === -3 && acts[4]?.horizontal === false, 'scroll down 3 notches');
  ok(calls.some(c => c.cmd === 'cursor'), 'safety stop checks the cursor between steps');

  // 6. Safety stop: the pointer "moves" between steps -> the run stops.
  const origCursor = native.cursor.bind(native);
  let n = 0;
  native.cursor = async () => { const c = await origCursor(); return ++n >= 2 ? { x: c.x + 300, y: c.y } : c; };
  const r2 = await internals.run(task.id, {});
  native.cursor = origCursor;
  ok(!r2.ok && /moved the mouse/.test(r2.msg), `safety stop: ${r2.msg}`);

  // 7. Emergency stop mid-run.
  const longTask = internals.saveTask({ name: 'Long wait', viewport: task.viewport, steps: [{ type: 'wait', ms: 30000 }], triggers: [] });
  const p = internals.run(longTask.id, {});
  await wait(300);
  internals.stopAll('Stopped by Ctrl+Alt+X.');
  const r3 = await p;
  ok(!r3.ok && /Ctrl\+Alt\+X/.test(r3.msg) && r3.ms < 5000, `emergency stop ends a run at once (${r3.ms} ms)`);

  // 8. Timer through the UI: every 2 s, at most 2 runs.
  await js(`selectTask(${JSON.stringify(task.id)}); tab = 'timers'; renderEditor(); document.querySelector('[data-addtimer=interval]').click(); true`);
  await js(`(() => { const li = document.querySelector('#timers [data-tr]');
    const e = li.querySelector('[data-t=every]'); e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true }));
    const u = li.querySelector('[data-t=unit]'); u.value = 's'; u.dispatchEvent(new Event('change', { bubbles: true }));
    const m = li.querySelector('[data-t=maxRuns]'); m.value = '2'; m.dispatchEvent(new Event('change', { bubbles: true })); return flushSave(); })()`);
  const t0 = Date.now();
  const timed = await until(() => store.data.history.filter(h => h.taskId === task.id && h.by === 'timer').length >= 2, 15e3, 200);
  ok(timed, `interval timer ran the task twice by itself (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  await wait(2500);
  ok(store.data.history.filter(h => h.taskId === task.id && h.by === 'timer').length === 2, 'and stopped after 2 runs');
  await wait(300);
  const nextText = await js(`document.querySelector('#timers .timer-next')?.textContent`);
  ok(/^Finished: ran 2 times/.test(nextText || ''), `timer card says: "${nextText}"`);
  await shot(win, 'timers.png');

  // 9. Daily + once timers validate; pause stops timers firing.
  await js(`document.querySelector('[data-addtimer=daily]').click(); document.querySelector('[data-addtimer=once]').click(); flushSave()`);
  await wait(400);
  const trs = store.task(task.id).triggers;
  ok(trs.length === 3 && trs[1].next > Date.now() && trs[2].next > Date.now(), 'daily and once timers get a next run');
  scheduler.setPaused(true);
  ok(scheduler.paused, 'timers can be paused');
  scheduler.setPaused(false);

  // 10. Rehearsal from the UI: no input reaches the helper.
  calls.length = 0;
  await js(`tab = 'steps'; renderEditor(); document.getElementById('rehearseBtn').click(); true`);
  await wait(300);
  await until(() => js(`!S.running`), 10e3, 200);
  await wait(300);
  ok(!calls.some(c => ['click', 'type', 'keys', 'scroll', 'focus'].includes(c.cmd)), 'rehearsal sends no clicks or keys');
  await js(`selStep = draft.steps[1].id; renderSteps(); renderOverlay(); true`);
  await shot(win, 'steps.png');

  // 11. Clicking a found input in Select mode offers to add a step for it.
  const other = items.find(i => i !== tb) || items[0];
  await js(`setTool('select'); selStep = null; renderSteps(); renderOverlay(); true`);
  const before = store.task(task.id).steps.length;
  await clickAt((other.fx1 + other.fx2) / 2 + 0.02, (other.fy1 + other.fy2) / 2);
  ok(await js(`!document.getElementById('popover').hidden`), `popover opens for "${other.label}"`);
  await shot(win, 'popover.png');
  await js(`document.getElementById('popAi').checked = true; document.querySelector('#popover [data-pa=click]').click(); flushSave()`);
  await wait(300);
  const added = store.task(task.id).steps;
  ok(added.length === before + 1 && added.at(-1).find && added.at(-1).name === other.label, `popover adds a click on "${other.label}" that the AI re-finds each run ("${added.at(-1).find}")`);
  nativeTheme.themeSource = 'dark';
  await wait(400);
  await shot(win, 'dark.png');
  nativeTheme.themeSource = 'system';

  // 12. Logic: add a Loop and an If from the buttons, drag cards into them by their grips, run it.
  await js(`(() => { const s = draft.steps.at(-1); s.find = ''; selStep = null; insertHere = null; tab = 'steps'; renderEditor(); saveSoon(0); return true; })()`);
  const set = (sel, v, ev = 'input') => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('${ev}', { bubbles: true })); return true; })()`);
  await js(`document.querySelector('[data-addlogic=loop]').click(); true`);
  await set('#steps .step.sel [data-f=times]', '2');
  await js(`document.querySelector('[data-add=wait]').click(); true`);       // goes inside the selected loop
  await set('#steps .step.sel [data-f=waitS]', '0.1');
  await js(`selStep = null; renderSteps(); document.querySelector('[data-addlogic=if]').click(); true`);
  await set('#steps .step.sel select[data-c=kind]', 'time', 'change');
  await set('#steps .step.sel [data-c=from]', '00:00');
  await set('#steps .step.sel [data-c=to]', '23:59');
  const ids = await js(`(() => { const r = draft.steps; const loop = r.find(s => s.type === 'loop'), iff = r.find(s => s.type === 'if');
    return { click: r[0].id, scroll: r.find(s => s.type === 'scroll').id, loop: loop.id, wait: loop.children[0]?.id, iff: iff.id }; })()`);
  ok(!!ids.wait, 'a step added while a loop is selected goes inside the loop');

  const rectOf = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: r.top, h: r.height }; })()`);
  async function drag(fromSel, toSel, frac = 0.5, shotName = null) {
    await js(`selStep = null; renderSteps(); renderOverlay(); document.querySelector('.tab-body[data-body=steps]').scrollTop = 0; true`);
    const a = await rectOf(`${fromSel} > .step-row .grip`);
    const b = await rectOf(toSel);
    if (!a || !b) { ok(false, `drag: missing ${!a ? fromSel : toSel}`); return; }
    const to = { x: b.x, y: Math.round(b.top + b.h * frac) };
    wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x + (to.x - a.x) * i / 8), y: Math.round(a.y + (to.y - a.y) * i / 8), button: 'left' }); await wait(20); }
    if (shotName) await shot(win, shotName);
    wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await wait(200);
  }
  // The first click goes into the If's empty "Then" list; the scroll goes inside the loop, before the wait.
  await drag(`[data-step="${ids.click}"]`, `[data-step="${ids.iff}"] > .branch.b-children .drop-empty`);
  await drag(`[data-step="${ids.scroll}"]`, `[data-step="${ids.wait}"]`, 0.2, 'dragging.png');
  await js('flushSave()'); await wait(300);
  const tree = store.task(task.id).steps;
  const L = tree.find(s => s.id === ids.loop), I = tree.find(s => s.id === ids.iff);
  ok(L && JSON.stringify(L.children.map(s => s.id)) === JSON.stringify([ids.scroll, ids.wait]), `dragged the scroll into the loop before the wait (${L?.children.map(s => s.type)})`);
  ok(I && I.children.length === 1 && I.children[0].id === ids.click && I.else.length === 0, 'dragged the click into the If\'s Then list');
  ok(!tree.some(s => s.id === ids.click || s.id === ids.scroll), 'and they left the top level');
  // Dropping a container into itself is refused.
  await drag(`[data-step="${ids.loop}"]`, `[data-step="${ids.wait}"]`, 0.8);
  ok(store.task(task.id).steps.some(s => s.id === ids.loop), 'a loop cannot be dropped inside itself');

  // Test the condition from the editor.
  await js(`selStep = ${JSON.stringify(ids.iff)}; renderSteps(); document.querySelector('#steps .step.sel [data-act=testcond]').click(); true`);
  const condText = await until(() => js(`document.querySelector('#steps .step.sel .cond-result')?.textContent || ''`).then(t => (/True|False/.test(t) ? t : '')), 5e3);
  if (!condText) console.log('  toast:', await js(`document.getElementById('toast').textContent`));
  ok(/^True/.test(condText), `If "Test now" says: ${condText}`);
  await shot(win, 'logic.png');

  // Run it: the loop scrolls twice, the If (always true) clicks once.
  calls.length = 0;
  const r4 = await internals.run(task.id, {});
  const acts4 = calls.filter(c => c.cmd !== 'cursor');
  ok(r4.ok, `logic run finished: ${r4.msg}`);
  ok(acts4.filter(c => c.cmd === 'scroll').length === 2, 'loop ran its scroll twice');
  const R4 = (await internals.resolveViewport(task.viewport)).rect;
  const cs = store.task(task.id).steps.find(s => s.id === ids.iff).children[0];
  ok(JSON.stringify(acts4.at(-1)) === JSON.stringify({ cmd: 'click', x: Math.round(R4.x + cs.fx * (R4.w - 1)), y: Math.round(R4.y + cs.fy * (R4.h - 1)), button: 'left', count: 1 }), 'the If ran its Then click last');

  // 13. A closed window is opened again. A fake program "fixturepad" whose window shows up once it is "started"
  //     (no real program is ever started: the launcher is a stub). Its pid is the helper's, so reading
  //     how it was started is real.
  const FAKE = { hwnd: 0x7a0011, title: 'notes.txt - Fixturepad', pid: native.child.pid, process: 'fixturepad', rect: [200, 150, 1280, 800], minimized: false };
  let fakeOpen = true, launched = [];
  const origWindows = native.windows.bind(native);
  native.windows = async () => [...await origWindows(), ...(fakeOpen ? [FAKE] : [])];
  internals.setLauncher(async L => { launched.push(L); setTimeout(() => { fakeOpen = true; }, 900); });
  const fakeSrc = { id: 'window:' + FAKE.hwnd + ':0', name: FAKE.title, viewport: { kind: 'window', hwnd: FAKE.hwnd, sourceId: 'window:' + FAKE.hwnd + ':0', title: FAKE.title, process: FAKE.process, pid: FAKE.pid, label: FAKE.title } };
  await js(`chooseViewport(${JSON.stringify(fakeSrc)}, true); true`);
  const fakeTask = await until(() => store.tasks.find(t => t.viewport?.hwnd === FAKE.hwnd && t.viewport.launch), 15e3, 200);
  const L0 = fakeTask?.viewport.launch;
  ok(!!L0 && /powershell\.exe$/i.test(L0.path) && /native\.ps1/i.test(L0.args), `choosing a window reads how its program was started (${L0 ? L0.path.split(/[\\/]/).pop() + ' ' + L0.args.slice(-40) : 'nothing'})`);
  await js(`draft.focus = false; draft.steps.push(newStepOfTool('click', 0.25, 0.5)); renderEditor(); saveSoon(0); true`);
  await wait(500);
  ok(await js(`!$('reopenOpt').hidden && $('taskReopen').checked === false`), 'window tasks show "Open the window if it is closed" (off by default)');

  // The window closes: the preview offers to open it again.
  fakeOpen = false;
  await js('startPreview(); true');
  const closedHtml = await until(() => js(`$('stageEmpty').hidden ? '' : $('stageEmpty').innerHTML`).then(h => (/emptyOpen/.test(h) ? h : '')), 8e3, 200);
  ok(/The window is closed/.test(closedHtml) && /Open fixturepad again/.test(closedHtml), 'a closed window shows an "Open fixturepad again" button');
  await shot(win, 'closed.png');
  const busySeen = [];
  const busyWatch = setInterval(async () => { const b = await js(`$('busy').hidden ? '' : $('busyLabel').textContent`).catch(() => ''); if (b) busySeen.push(b); }, 150);
  await js(`$('emptyOpen').click(); true`);
  const reopenedHwnd = await until(() => js(`draft.viewport.hwnd === ${FAKE.hwnd} && !opening ? draft.viewport.hwnd : 0`), 15e3, 200);
  clearInterval(busyWatch);
  ok(launched.length === 1 && launched[0].path === L0.path && launched[0].args === L0.args, 'the button starts the program with its saved path and arguments');
  ok(!!reopenedHwnd && store.task(fakeTask.id).viewport.hwnd === FAKE.hwnd, 'the task follows the window that opened');
  ok(busySeen.some(b => /Opening fixturepad/.test(b)), `a progress bar shows while it waits ("${busySeen.at(-1) || ''}")`);

  // The How to open it… dialog edits the settings.
  await js(`openLaunchDlg(); true`);
  await shot(win, 'launch-dialog.png');
  ok(await js(`$('launchDlg').open && $('lPath').value === ${JSON.stringify(L0.path)}`), 'How to open it… shows the saved program');
  await js(`$('lArgs').value = '--fixture'; $('lSettle').value = '0'; $('lSave').click(); true`);
  await wait(500);
  const L1 = store.task(fakeTask.id).viewport.launch;
  ok(L1.args === '--fixture' && L1.settle === 0 && !(await js(`$('launchDlg').open`)), 'saving the dialog stores the new arguments and wait');

  // A run with the window closed: off -> a clear message; on -> it opens the window first, then clicks in it.
  fakeOpen = false; launched = []; calls.length = 0;
  const r5 = await internals.run(fakeTask.id, {});
  ok(!r5.ok && /is not open\. Tick "Open the window if it is closed"/.test(r5.msg) && launched.length === 0, `option off: the run says what to do ("${r5.msg}")`);
  await js(`$('taskReopen').click(); true`);
  await js('flushSave()'); await wait(400);
  ok(store.task(fakeTask.id).reopen === true, 'ticking the option saves it');
  fakeOpen = false; calls.length = 0;
  const r6 = await internals.run(fakeTask.id, {});
  const clicks6 = calls.filter(c => c.cmd === 'click');
  const [fx0, fy0, fw, fh] = FAKE.rect;
  ok(r6.ok && /^opened fixturepad first/.test(r6.msg) && launched.length === 1 && launched[0].args === '--fixture', `option on: the run opens it first ("${r6.msg}")`);
  ok(clicks6.length === 1 && clicks6[0].x === Math.round(fx0 + 0.25 * (fw - 1)) && clicks6[0].y === Math.round(fy0 + 0.5 * (fh - 1)), 'and then clicks inside the opened window');
  internals.setLauncher(async () => { throw new Error('no launcher'); });
  fakeOpen = false;
  const r7 = await internals.run(fakeTask.id, {});
  ok(!r7.ok && /no launcher/.test(r7.msg), `a program that fails to start ends the run with its reason ("${r7.msg}")`);
  native.windows = origWindows;

  // 14. My timers: make them in the UI, the red notification shows the message, snooze, preview, edit, pause, delete.
  const alerts = internals.alerts;
  const mine = () => store.data.reminders;
  await js(`document.querySelector('.mode[data-mode=timers]').click(); true`);
  ok(await js(`!$('timersPage').hidden && getComputedStyle(document.querySelector('.layout')).display === 'none'`), 'the My timers button opens the timers page');
  const val = (id, v) => js(`(() => { const i = $(${JSON.stringify(id)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  // A 25 minute one from a quick button, and a daily alarm.
  await js(`document.querySelector('#tmQuick [data-quick="1800"]').click(); true`);
  await val('tmM', '25');
  await val('tmLabel', 'Laundry'); await val('tmMessage', 'Move the clothes to the dryer.');
  await js(`$('tmStart').click(); true`);
  await js(`document.querySelector('#tmKind [data-kind=alarm]').click(); true`);
  await val('tmTime', '07:15'); await js(`$('tmDaily').click(); true`);
  await val('tmLabel', 'Vitamins'); await val('tmMessage', 'Take your vitamins with breakfast.');
  await js(`$('tmStart').click(); true`);
  await until(() => mine().length >= 2, 4e3);
  const laundry = mine().find(t => t.label === 'Laundry'), vit = mine().find(t => t.label === 'Vitamins');
  ok(laundry && laundry.kind === 'countdown' && laundry.durationMs === 25 * 60e3 && laundry.message === 'Move the clothes to the dryer.', 'a 25 min countdown is saved with its message');
  ok(vit && vit.kind === 'alarm' && vit.daily && vit.time === '07:15' && new Date(vit.dueAt).getHours() === 7, 'a daily 07:15 alarm is saved');
  // A 2 second one with the message the notification must show.
  await js(`document.querySelector('#tmKind [data-kind=countdown]').click(); true`);
  await val('tmH', '0'); await val('tmM', '0'); await val('tmS', '2');
  await val('tmLabel', 'Tea'); await val('tmMessage', 'Take the tea bag out!');
  const alertsBefore = alerts.size;
  await js(`$('tmStart').click(); true`);
  await until(() => js(`document.querySelectorAll('#tmRunning .tm-card').length === 3`), 3e3);
  await shot(win, 'timers.png');
  const tea = await until(() => [...alerts.values()].find(a => a.alert.label === 'Tea'), 8e3, 100);
  ok(!!tea && alerts.size === alertsBefore + 1, 'when the countdown is done, a notification opens');
  const teaTimer = mine().find(t => t.label === 'Tea');
  ok(teaTimer?.state === 'done', 'and the timer moves to Finished');
  if (tea) {
    const aw = tea.win, ajs = code => aw.webContents.executeJavaScript(code, true);
    const shown = await until(() => ajs(`document.getElementById('title').textContent && document.getElementById('dismiss') ? [document.getElementById('title').textContent, document.getElementById('msg').textContent, getComputedStyle(document.body).backgroundColor] : null`).catch(() => null), 6e3);
    ok(shown && shown[0] === 'Tea' && shown[1] === 'Take the tea bag out!', `the notification says your message ("${shown?.[1]}")`);
    ok(shown && shown[2] === 'rgb(211, 47, 47)', `the notification is red (${shown?.[2]})`);
    const wa = screen.getPrimaryDisplay().workArea, b = aw.getBounds();
    ok(aw.isAlwaysOnTop() && b.x + b.width <= wa.x + wa.width && b.x > wa.x + wa.width / 2 && b.y + b.height <= wa.y + wa.height && b.y > wa.y + wa.height / 2, `it sits on top, in the bottom-right corner (${b.width}x${b.height})`);
    ok(!aw.isVisible(), 'the test keeps it hidden');
    await shot(aw, 'alert.png');
    await ajs(`document.querySelector('[data-snooze="5"]').click(); true`);
    await until(() => aw.isDestroyed(), 4e3);
    ok(aw.isDestroyed() && teaTimer.state === 'running' && Math.abs(teaTimer.dueAt - (Date.now() + 5 * 60e3)) < 5e3, 'Snooze 5 min closes it and rings again in 5 minutes');
  }
  // Preview from the form, then dismiss.
  await val('tmLabel', 'Preview check'); await val('tmMessage', 'This is what it will say.');
  await js(`$('tmPreview').click(); true`);
  const prev = await until(() => [...alerts.values()].find(a => a.alert.preview), 4e3);
  ok(!!prev && prev.alert.message === 'This is what it will say.', 'Preview notification shows the typed message without starting a timer');
  if (prev) {
    await until(() => prev.win.webContents.executeJavaScript(`!!document.getElementById('dismiss')`).catch(() => false), 5e3);
    ok(await prev.win.webContents.executeJavaScript(`document.getElementById('kind').textContent + '|' + !document.querySelector('[data-snooze]')`) === 'Preview|true', 'a preview is labelled Preview and has no snooze');
    await prev.win.webContents.executeJavaScript(`document.getElementById('dismiss').click(); true`);
    await until(() => prev.win.isDestroyed(), 4e3);
    ok(prev.win.isDestroyed(), 'Dismiss closes it');
  }
  // Edit a card's message, pause it, delete another.
  await js(`(() => { const i = document.querySelector('[data-timer="${laundry.id}"] [data-tedit=message]'); i.value = 'Dryer: 40 minutes, low heat.'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(() => laundry.message === 'Dryer: 40 minutes, low heat.', 3e3);
  ok(laundry.message === 'Dryer: 40 minutes, low heat.', 'a running timer\'s message can be changed on its card');
  await js(`document.querySelector('[data-timer="${laundry.id}"] [data-tact=pause]').click(); true`);
  await until(() => laundry.state === 'paused', 3e3);
  ok(laundry.state === 'paused' && laundry.leftMs > 24 * 60e3, 'Pause keeps the time left');
  await js(`document.querySelector('[data-timer="${vit.id}"] [data-tact=delete]').click(); true`);
  await until(() => !mine().some(t => t.id === vit.id), 3e3);
  ok(!mine().some(t => t.id === vit.id), 'Delete removes a timer');
  // A timer that was due while the app was closed rings at once and says so.
  mine().push({ id: 'missed', label: 'Missed call back', message: 'Call the shop back.', kind: 'countdown', durationMs: 60e3, sound: false, state: 'running', dueAt: Date.now() - 30 * 60e3, createdAt: Date.now() - 31 * 60e3, firedAt: null });
  internals.checkMyTimers();
  const late = [...alerts.values()].find(a => a.alert.timerId === 'missed');
  const lateText = late && await until(() => late.win.webContents.executeJavaScript(`document.getElementById('late').hidden ? '' : document.getElementById('late').textContent`).catch(() => ''), 5e3);
  ok(/while Omega Manager was closed/.test(lateText || ''), `a missed timer rings at once ("${lateText}")`);
  await wait(300);
  await shot(win, 'timers-after.png');
  // Night mode button.
  const wasDark = await js('darkQuery.matches');
  await js(`$('themeBtn').click(); true`);
  await until(() => js(`darkQuery.matches !== ${wasDark}`), 3e3);
  ok(store.settings.theme === (wasDark ? 'light' : 'dark') && await js(`darkQuery.matches !== ${wasDark}`), `the moon/sun button switches to ${wasDark ? 'day' : 'night'} mode`);
  if (!wasDark) await shot(win, 'timers-night.png');
  else { await js(`$('themeBtn').click(); true`); await wait(500); await shot(win, 'timers-night.png'); }
  const accent = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  ok(/^#(22d3ee|0891b2)$/i.test(accent), `the theme is cyan (${accent})`);
  ok(await js(`document.title`) === 'Omega Manager', 'the window is called Omega Manager');
  // 14b. Phone alerts: pair a "phone" with the code from the dialog, it gets the alert live, and Dismiss on the phone
  // closes the red window on the PC. (The Android app's own Java code is checked against the same server in npm test.)
  const phone = internals.phone();
  ok(!!phone && phone.port > 0, `the phone link listens on 127.0.0.1:${phone?.port}`);
  if (phone) {
    const base = `http://127.0.0.1:${phone.port}`;
    await js(`$('tmPhoneBtn').click(); true`);
    ok(await js(`$('phoneDlg').open`), 'the Phone alerts button opens its dialog');
    await js(`$('phNew').click(); true`);
    const code = (await until(() => js(`$('phCode')?.textContent || ''`), 4e3) || '').replace(/\s/g, '');
    ok(/^\d{6}$/.test(code), `New code shows a 6-digit pair code (${code})`);
    const page = await (await fetch(base + '/')).text();
    ok(/Download the app \(\d+ KB\)/.test(page), 'the install page offers the app download');
    const apk = await fetch(base + '/omega-manager.apk');
    const apkBytes = Buffer.from(await apk.arrayBuffer());
    ok(apk.status === 200 && apkBytes.subarray(0, 2).toString() === 'PK', `the APK downloads (${apkBytes.length} bytes)`);
    const paired = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Smoke phone' }) })).json();
    ok(paired.ok && paired.token, 'a phone pairs with that code');
    const events = [], ctl = new AbortController();
    const offered = phone.appInfo();
    ok(!!offered && offered.versionCode > 0 && offered.size === apkBytes.length, `the PC offers app build ${offered?.versionCode} to phones for updates`);
    fetch(base + '/api/events', { headers: { Authorization: `Bearer ${paired.token}`, 'X-Omega-App-Version': String(offered?.versionCode || 1) }, signal: ctl.signal }).then(async r => {
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ ev, data: JSON.parse(data) });
        }
      }
    }).catch(() => {});
    ok(!!await until(() => events.find(e => e.ev === 'hello'), 4e3), 'the phone connects and gets the timer list');
    await until(() => js(`$('phList').textContent.includes('Smoke phone') && $('phList').textContent.includes('Connected now')`), 4e3);
    ok(await js(`$('phList').textContent.includes('Connected now') && !$('tmPhoneDot').hidden`), 'the dialog lists the phone as connected');
    ok((await until(() => js(`document.querySelector('#phList .ph-ver')?.textContent || ''`), 3e3)) === 'App up to date', 'and shows its app is up to date');
    ok(events.find(e => e.ev === 'hello')?.data.app?.versionCode === offered?.versionCode, 'the phone is told which app version the PC has');
    await shot(win, 'phone-dialog.png');
    await js(`$('phoneDlg').close(); true`);
    await js(`document.querySelector('#tmKind [data-kind=countdown]').click(); true`);
    await val('tmH', '0'); await val('tmM', '0'); await val('tmS', '1');
    await val('tmLabel', 'Phone check'); await val('tmMessage', 'Sent to the phone too.');
    await js(`$('tmStart').click(); true`);
    const got = await until(() => events.find(e => e.ev === 'alert' && e.data.title === 'Phone check'), 8e3);
    ok(got && got.data.message === 'Sent to the phone too.' && got.data.canSnooze, 'the phone gets the alert with its message the moment it rings');
    const pcAlert = got && alerts.get(got.data.id);
    ok(!!pcAlert, 'and the red window is open on the PC too');
    if (got) {
      const r = await (await fetch(`${base}/api/alerts/${got.data.id}/dismiss`, { method: 'POST', headers: { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' }, body: '{}' })).json();
      await until(() => !pcAlert || pcAlert.win.isDestroyed(), 4e3);
      ok(r.ok && (!pcAlert || pcAlert.win.isDestroyed()) && mine().find(t => t.label === 'Phone check')?.state === 'done', 'Dismiss on the phone closes the PC alert');
      ok(!!await until(() => events.find(e => e.ev === 'alert-closed' && e.data.id === got.data.id), 3e3), 'and tells every phone it is closed');
    }
    ctl.abort();
  }

  for (const { win: w } of alerts.values()) if (!w.isDestroyed()) w.close();
  await js(`MyTimers.setMode('auto'); true`);

  // 15. Console errors.
  ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);
  scheduler.setPaused(true);
  return failures ? 1 : 0;
}

const consoleErrors = [];
export function watchConsole(wc) { wc.on('console-message', e => { if (e.level === 'error') consoleErrors.push(e.message); }); }

async function shot(win, name) {
  const wc = win.webContents;
  let prev = null, img = null;
  for (let i = 0; i < 8; i++) {
    wc.invalidate(); await wait(300);
    try { img = await wc.capturePage(undefined, { stayHidden: true }); } catch { continue; }
    const png = img.toPNG();
    if (prev && png.equals(prev)) break;
    prev = png;
  }
  if (img) writeFileSync(join(OUT, name), img.toPNG());
}

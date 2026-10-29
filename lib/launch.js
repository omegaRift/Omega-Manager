// Opening a task's window again when it has been closed.
// A window viewport remembers how its program was started: viewport.launch = { path, args, aumid, settle }.
//   aumid: Windows Store / packaged app id (e.g. Win 11 Notepad); opened through shell:AppsFolder.
//   path + args: an ordinary program, started with its arguments (e.g. the file it had open).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { matchWindow } from './geometry.js';

// '"C:\Program Files\x.exe" --a "b c"' -> { exe: 'C:\Program Files\x.exe', args: '--a "b c"' }
export function splitCommandLine(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return { exe: '', args: '' };
  if (s[0] === '"') {
    const end = s.indexOf('"', 1);
    if (end < 0) return { exe: s.slice(1), args: '' };
    return { exe: s.slice(1, end), args: s.slice(end + 1).trim() };
  }
  const sp = s.search(/\s/);
  return sp < 0 ? { exe: s, args: '' } : { exe: s.slice(0, sp), args: s.slice(sp + 1).trim() };
}

// What the helper read from a running window's process -> launch settings (or null if nothing usable).
export function launchFromProcess({ path = '', commandLine = '', aumid = '' } = {}) {
  if (!path && !aumid) return null;
  return { path, args: splitCommandLine(commandLine).args, aumid: aumid || '', settle: 2 };
}

export const programName = vp => vp.process || (vp.launch?.path ? basename(vp.launch.path).replace(/\.exe$/i, '') : '') || 'the program';
export const canOpen = vp => !!(vp && vp.kind === 'window' && vp.launch && (vp.launch.path || vp.launch.aumid));

// Starts the program without waiting for it. Uses "start" so GUI programs detach the normal way.
export function startProgram(L) {
  return new Promise((resolve, reject) => {
    let target;
    if (L.aumid) target = `"shell:AppsFolder\\${L.aumid}"`;
    else {
      if (isAbsolute(L.path) && !existsSync(L.path)) return reject(new Error(`Can't find ${L.path}. Set the program again under "How to open it…".`));
      target = `"${L.path}"${L.args ? ' ' + L.args : ''}`;
    }
    const opts = { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true };
    if (!L.aumid && isAbsolute(L.path)) opts.cwd = dirname(L.path);
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "" ${target}"`], opts);
    child.once('error', e => reject(new Error('Could not start the program: ' + e.message)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * Starts the program and waits for its window. Returns the window ({hwnd, title, process, rect}).
 * deps: { windows(), start(launch), sleep(ms), now(), onProgress?(0..1) }
 */
export async function openWindow(vp, deps, { timeoutMs = 30e3 } = {}) {
  if (!canOpen(vp)) throw new Error(`Omega Manager doesn't know how to open "${vp?.title || 'this window'}". Set the program under "How to open it…".`);
  const L = vp.launch;
  const before = new Set((await deps.windows()).map(w => w.hwnd));
  await deps.start(L);
  const t0 = deps.now();
  const names = new Set([vp.process, L.path ? basename(L.path).replace(/\.exe$/i, '') : ''].filter(Boolean).map(s => s.toLowerCase()));
  while (deps.now() - t0 < timeoutMs) {
    await deps.sleep(400);
    deps.onProgress?.(Math.min(0.95, (deps.now() - t0) / timeoutMs));
    const wins = await deps.windows();
    const fresh = wins.filter(w => !before.has(w.hwnd));
    const w = matchWindow(vp, wins) || fresh.find(x => names.has(String(x.process).toLowerCase()));
    if (w && !w.minimized && w.rect && w.rect[2] > 0) {
      await deps.sleep(Math.max(0, Number(L.settle ?? 2)) * 1000);   // let it finish drawing
      return w;
    }
  }
  throw new Error(`Opened ${programName(vp)}, but its window did not show up within ${Math.round(timeoutMs / 1000)} s.`);
}

// The viewport, pointed at the window that was just opened.
export function adoptWindow(vp, w) {
  return { ...vp, hwnd: w.hwnd, sourceId: `window:${w.hwnd}:0`, title: w.title, process: w.process || vp.process };
}

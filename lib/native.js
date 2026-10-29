// Talks to helper/native.ps1 (one hidden PowerShell that lives as long as the app) and runs uia.ps1 on demand.
import { spawn, execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, '..', 'helper', 'native.ps1');
const UIA = join(HERE, '..', 'helper', 'uia.ps1');
export const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

const enc = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const dec = line => JSON.parse(Buffer.from(line.trim(), 'base64').toString('utf8'));

export class Native {
  constructor({ dry = false, log = () => {} } = {}) {
    this.dry = dry;
    this.log = log;
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.info = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const env = { ...process.env, AP_DRY_INPUT: this.dry ? '1' : '0' };
      const child = spawn(POWERSHELL, [...PS_ARGS, HELPER], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let buf = '', err = '';
      const timer = setTimeout(() => reject(new Error('The input helper did not start within 30 s. ' + err)), 30e3);
      child.stdout.setEncoding('ascii');
      child.stdout.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = dec(line); } catch { this.log('helper: unreadable reply ' + line.slice(0, 80)); continue; }
          if (msg.id === 0) { clearTimeout(timer); this.info = msg.result; resolve(msg.result); continue; }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve({ result: msg.result, dry: msg.dry || [] });
          else p.reject(new Error(msg.error));
        }
      });
      child.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
      child.on('exit', code => {
        clearTimeout(timer);
        const e = new Error(`The input helper stopped (code ${code}). ${err.trim().slice(-400)}`);
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        this.child = null;
        this.ready = null;      // the next call starts a fresh helper
        reject(e);
      });
    });
    return this.ready;
  }

  async call(cmd, args = {}, timeoutMs = 20e3) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`The input helper did not answer "${cmd}" in time.`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.child.stdin.write(enc({ id, cmd, ...args }) + '\n');
    });
  }

  async windows() { return (await this.call('windows')).result || []; }
  async rect(hwnd) { const r = (await this.call('rect', { hwnd })).result; return Array.isArray(r) ? { x: r[0], y: r[1], w: r[2], h: r[3] } : null; }
  async cursor() { const r = (await this.call('cursor')).result; return { x: r[0], y: r[1] }; }
  // A running program's exe path, command line and Windows app id (AUMID, for Store apps).
  async procinfo(pid) { return (await this.call('procinfo', { pid }, 15000)).result || {}; }
  focus(hwnd) { return this.call('focus', { hwnd }); }
  move(x, y) { return this.call('move', { x: Math.round(x), y: Math.round(y) }); }
  click(x, y, button = 'left', count = 1) { return this.call('click', { x: Math.round(x), y: Math.round(y), button, count }); }
  scroll(x, y, clicks, horizontal = false) { return this.call('scroll', { x: Math.round(x), y: Math.round(y), clicks, horizontal }); }
  type(text, delay = 15) { return this.call('type', { text64: Buffer.from(text, 'utf8').toString('base64'), delay }, 20e3 + text.length * (delay + 10)); }
  keys(vks) { return this.call('keys', { vks }); }

  stop() { if (this.child) { try { this.child.stdin.end(); this.child.kill(); } catch { } } }
}

// Windows UI Automation: input controls of one window, rects in physical pixels.
export function uiaInputs(hwnd, timeoutMs = 20e3) {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, [...PS_ARGS, UIA, '-Hwnd', String(hwnd)], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 << 20 }, (e, out, errOut) => {
      if (e) return reject(new Error(e.killed ? 'Windows accessibility took too long for this window.' : (String(errOut).trim().split('\n').pop() || e.message)));
      try { resolve(out.trim() ? dec(out) : []); } catch (x) { reject(new Error('Could not read the accessibility answer: ' + x.message)); }
    });
  });
}

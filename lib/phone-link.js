// Phone link: a small HTTP server the Omega Manager Android app connects to over Tailscale.
// Tailscale serve publishes it privately (https://<this-pc>.ts.net:8444 -> http://127.0.0.1:5191).
//
//   GET  /                      install page (download the app)
//   GET  /omega-manager.apk     the Android app
//   GET  /api/ping              { ok, name, protocol, app }
//   POST /api/pair              { code, name } -> { token, deviceId }   (code shown in Omega Manager, 5 minutes)
//   GET  /api/events            Server-Sent Events, Authorization: Bearer <token>
//        event: hello          { protocol, server, bootId, now, timers, alerts, app }
//        event: app            { versionCode, versionName, size, sha256 }   (the APK was rebuilt)
//        event: alert          { id, title, message, late, firedAt, dueAt, canSnooze, snooze, preview, sound }
//        event: alert-closed   { id }
//        event: timers         { now, timers }
//   POST /api/alerts/<id>/dismiss | /api/alerts/<id>/snooze { minutes }
//   POST /api/test              a test alert to this phone only
//   POST /api/unpair            forget this phone
// The phone sends its own app version in the X-Omega-App-Version header; "app" is the APK this PC offers
// (android/dist/omega-manager.json, written by android/build.mjs), so phones can update themselves.
import http from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';

export const PROTOCOL = 1;
export const PAIR_MS = 5 * 60e3;
const hash = t => createHash('sha256').update(String(t)).digest('hex');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class PhoneLink {
  /**
   * store:     the app Store (keeps store.data.phone = { devices: [{ id, name, tokenHash, pairedAt, lastSeen }] })
   * snapshot:  () => ({ timers, alerts })
   * onAction:  (alertId, 'dismiss' | 'snooze', minutes) => void
   * onChange:  () => void   (devices or connections changed)
   */
  constructor({ store, snapshot, onAction, onChange = () => {}, apkPath = null, port = 5191, host = '127.0.0.1', now = Date.now, heartbeatMs = 20e3, serverName = hostname() }) {
    Object.assign(this, { store, snapshot, onAction, onChange, apkPath, port, host, now, heartbeatMs, serverName });
    this.bootId = randomUUID();
    this.streams = new Set();         // { deviceId, res }
    this.pair = null;                 // { code, expiresAt, tries }
    this.server = null;
    this.testSeq = 0;
    this.appCache = { key: '', info: null };
  }

  /** The app this PC offers: { versionCode, versionName, size, sha256 }, or null if none is built. */
  appInfo() {
    try {
      if (!this.apkPath) return null;
      const meta = this.apkPath.replace(/\.apk$/i, '.json');
      const a = statSync(this.apkPath), m = statSync(meta);
      const key = `${a.size}:${a.mtimeMs}:${m.mtimeMs}`;
      if (key !== this.appCache.key) {
        const j = JSON.parse(readFileSync(meta, 'utf8'));
        // Only offer it when the description matches the file (a build half-way through is not offered).
        const ok = Number.isInteger(j.versionCode) && j.size === a.size && /^[0-9a-f]{64}$/.test(j.sha256 || '');
        this.appCache = { key, info: ok ? { versionCode: j.versionCode, versionName: String(j.versionName || ''), size: j.size, sha256: j.sha256 } : null };
      }
      return this.appCache.info;
    } catch { return null; }
  }

  /** Tells connected phones when a new build of the app appears. Runs with the heartbeat. */
  checkApp() {
    const info = this.appInfo();
    const k = JSON.stringify(info);
    if (k === this.lastApp) return false;
    this.lastApp = k;
    if (info) this.broadcast('app', info);
    this.onChange();
    return !!info;
  }

  get devices() {
    const p = this.store.data.phone || (this.store.data.phone = { devices: [] });
    return p.devices || (p.devices = []);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res).catch(e => this.fail(res, 500, e.message)));
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        this.lastApp = JSON.stringify(this.appInfo());
        this.beat = setInterval(() => { for (const s of this.streams) s.res.write(': ping\n\n'); this.checkApp(); }, this.heartbeatMs);
        resolve(this.port);
      });
    });
  }

  stop() {
    clearInterval(this.beat);
    for (const s of this.streams) s.res.end();
    this.streams.clear();
    this.server?.close();
  }

  // ---------- pairing ----------
  newPairCode() {
    this.pair = { code: String(randomInt(0, 1e6)).padStart(6, '0'), expiresAt: this.now() + PAIR_MS, tries: 0 };
    this.onChange();
    return { code: this.pair.code, expiresAt: this.pair.expiresAt };
  }
  cancelPairing() { this.pair = null; this.onChange(); }

  removeDevice(id) {
    const p = this.store.data.phone;
    if (p) p.devices = this.devices.filter(d => d.id !== id);
    this.store.save();
    for (const s of [...this.streams]) if (s.deviceId === id) { s.res.end(); this.streams.delete(s); }
    this.onChange();
  }

  status() {
    const online = new Set([...this.streams].map(s => s.deviceId));
    const pairing = this.pair && this.pair.expiresAt > this.now() ? { code: this.pair.code, expiresAt: this.pair.expiresAt } : null;
    return {
      port: this.port,
      devices: this.devices.map(d => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: online.has(d.id) ? this.now() : d.lastSeen, online: online.has(d.id), appVersion: d.appVersion || 0 })),
      pairing,
      app: this.appInfo(),
    };
  }

  // ---------- events ----------
  send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  broadcast(event, data, deviceId = null) {
    let n = 0;
    for (const s of this.streams) if (!deviceId || s.deviceId === deviceId) { this.send(s.res, event, data); n++; }
    return n;
  }

  // ---------- http ----------
  fail(res, code, error) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error }));
  }
  json(res, value) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  body(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > 8192) { reject(new Error('Too much data.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Bad JSON.')); } });
      req.on('error', reject);
    });
  }
  device(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const h = hash(m[1]);
    return this.devices.find(d => d.tokenHash === h) || null;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/') return this.page(res);
    if (req.method === 'GET' && path === '/omega-manager.apk') return this.apk(res);
    if (req.method === 'GET' && path === '/api/ping') return this.json(res, { ok: true, name: 'Omega Manager', protocol: PROTOCOL, server: this.serverName, app: this.appInfo() });
    if (req.method === 'POST' && path === '/api/pair') return this.pairDevice(req, res);
    const dev = this.device(req);
    if (path.startsWith('/api/') && !dev) return this.fail(res, 401, 'This phone is not paired. Pair it again with a code from Omega Manager.');
    if (req.method === 'GET' && path === '/api/events') return this.events(req, res, dev);
    let m;
    if (req.method === 'POST' && (m = /^\/api\/alerts\/([\w-]{1,64})\/(dismiss|snooze)$/.exec(path))) {
      const b = await this.body(req);
      this.onAction(m[1], m[2], Number(b.minutes) || 5);
      return this.json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/test') {
      const id = `test-${++this.testSeq}`;
      const n = this.broadcast('alert', { id, title: 'Test alert', message: 'Omega Manager can reach this phone. Timer alerts will look like this.', late: false, firedAt: this.now(), dueAt: this.now(), canSnooze: false, snooze: [], preview: true, sound: true }, dev.id);
      return this.json(res, { ok: true, delivered: n });
    }
    if (req.method === 'POST' && path === '/api/unpair') { this.removeDevice(dev.id); return this.json(res, { ok: true }); }
    return this.fail(res, 404, 'Not found.');
  }

  async pairDevice(req, res) {
    const b = await this.body(req);
    const p = this.pair;
    if (!p || p.expiresAt <= this.now()) return this.fail(res, 403, 'No pairing code is active. In Omega Manager open My timers > Phone alerts and press "New code".');
    if (String(b.code || '').replace(/\D/g, '') !== p.code) {
      if (++p.tries >= 5) this.pair = null;
      this.onChange();
      return this.fail(res, 403, this.pair ? 'That code is not right.' : 'Too many wrong codes. Make a new code in Omega Manager.');
    }
    const token = randomBytes(32).toString('base64url');
    const d = { id: randomUUID(), name: String(b.name || 'Android phone').slice(0, 60), tokenHash: hash(token), pairedAt: this.now(), lastSeen: this.now() };
    this.devices.push(d);
    this.pair = null;
    this.store.save();
    this.onChange();
    return this.json(res, { ok: true, token, deviceId: d.id, server: this.serverName });
  }

  events(req, res, dev) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    const s = { deviceId: dev.id, res };
    this.streams.add(s);
    dev.lastSeen = this.now();
    const v = Number(req.headers['x-omega-app-version']);
    if (Number.isSafeInteger(v) && v > 0 && v !== dev.appVersion) { dev.appVersion = v; this.store.save(); }
    this.send(res, 'hello', { protocol: PROTOCOL, server: this.serverName, bootId: this.bootId, now: this.now(), ...this.snapshot(), app: this.appInfo() });
    this.onChange();
    const bye = () => { if (this.streams.delete(s)) { dev.lastSeen = this.now(); this.store.save(); this.onChange(); } };
    req.on('close', bye);
    res.on('error', bye);
  }

  page(res) {
    const has = this.apkPath && existsSync(this.apkPath);
    const bytes = has ? statSync(this.apkPath).size : 0;
    const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Omega Manager for Android</title>
<style>:root{color-scheme:light dark}body{margin:0;font-family:system-ui,sans-serif;background:#f1f7f9;color:#13232a;padding:24px 16px;line-height:1.5}
@media(prefers-color-scheme:dark){body{background:#0a1215;color:#e2f2f5}.card{background:#101b1f!important;border-color:#1f3239!important}}
.card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8e6ea;border-radius:14px;padding:20px}h1{font-size:22px;margin:0 0 6px}
a.btn{display:block;text-align:center;background:#0891b2;color:#fff;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;margin:18px 0}
ol{padding-left:20px}small{opacity:.7}</style></head><body><div class="card">
<h1>Omega Manager for Android</h1><p>Get your timer alerts from <b>${esc(this.serverName)}</b> on this phone, as red notifications.</p>
${has ? `<a class="btn" href="/omega-manager.apk" download>Download the app (${size})</a>${this.appInfo() ? `<small>Version ${esc(this.appInfo().versionName)}, build ${this.appInfo().versionCode}. Once installed, the app can update itself from this PC.</small>` : ''}` : '<p><b>The app has not been built yet.</b> On the PC run <code>npm run android</code> in the Omega Manager folder.</p>'}
<ol><li>Open the downloaded file and allow installing apps from this browser if Android asks.</li>
<li>Open <b>Omega Manager</b>. In Omega Manager on the PC, go to <b>My timers &gt; Phone alerts</b> and press <b>New code</b>.</li>
<li>Type the 6-digit code in the app and press <b>Pair</b>.</li></ol>
<small>Only devices on your Tailscale network can open this page.</small></div></body></html>`);
  }

  apk(res) {
    if (!this.apkPath || !existsSync(this.apkPath)) return this.fail(res, 404, 'The Android app has not been built yet (npm run android).');
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': statSync(this.apkPath).size, 'Content-Disposition': 'attachment; filename="omega-manager.apk"', 'Cache-Control': 'no-store' });
    createReadStream(this.apkPath).pipe(res);
  }
}

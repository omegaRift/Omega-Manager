import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PhoneLink } from '../lib/phone-link.js';

function fakeStore() { return { data: {}, saved: 0, save() { this.saved++; } }; }

// Reads Server-Sent Events into a queue; next(name) waits for the next event with that name.
function sse(port, token) {
  const queue = [], waiters = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ port, path: '/api/events', headers: { Authorization: `Bearer ${token}` } }, res => {
      resolve(res.statusCode);
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev) continue;
          queue.push({ ev, data: JSON.parse(data) });
          for (const w of waiters.splice(0)) w();
        }
      });
    });
    req.on('error', reject);
  });
  async function next(name, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = queue.findIndex(q => q.ev === name);
      if (i >= 0) return queue.splice(i, 1)[0].data;
      if (Date.now() > end) throw new Error('no ' + name + ' event');
      await new Promise(r => { waiters.push(r); setTimeout(r, 100); });
    }
  }
  return { ready, next, close: () => req.destroy() };
}

const post = (port, path, body, token) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}),
}).then(async r => ({ status: r.status, ...(await r.json()) }));

test('pair with the code, get alerts live, act on them from the phone', async () => {
  const store = fakeStore(), actions = [];
  const link = new PhoneLink({
    store, port: 0, serverName: 'TEST-PC',
    snapshot: () => ({ timers: [{ id: 't1', title: 'Tea' }], alerts: [] }),
    onAction: (id, a, m) => actions.push([id, a, m]),
  });
  const port = await link.start();
  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/ping`)).json(), { ok: true, name: 'Omega Manager', protocol: 1, server: 'TEST-PC', app: null });
    // No code yet, then wrong codes, then the right one.
    assert.equal((await post(port, '/api/pair', { code: '000000' })).status, 403);
    const { code } = link.newPairCode();
    const wrong = code === '111111' ? '222222' : '111111';
    const bad = await post(port, '/api/pair', { code: wrong });
    assert.match(bad.error, /not right/);
    const ok = await post(port, '/api/pair', { code: code.slice(0, 3) + ' ' + code.slice(3), name: 'Galaxy S25' });
    assert.equal(ok.ok, true);
    assert.ok(ok.token.length >= 40);
    assert.equal(store.data.phone.devices[0].name, 'Galaxy S25');
    assert.ok(!JSON.stringify(store.data).includes(ok.token), 'only a hash of the token is saved');
    assert.equal((await post(port, '/api/pair', { code })).status, 403, 'a code works once');

    // Without the token nothing is readable.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/events`)).status, 401);
    const s = sse(port, ok.token);
    assert.equal(await s.ready, 200);
    const hello = await s.next('hello');
    assert.equal(hello.timers[0].title, 'Tea');
    assert.equal(link.status().devices[0].online, true);

    assert.equal(link.broadcast('alert', { id: '7', title: 'Tea', message: 'Take the tea bag out!' }), 1);
    assert.equal((await s.next('alert')).message, 'Take the tea bag out!');
    assert.deepEqual(await post(port, '/api/alerts/7/snooze', { minutes: 10 }, ok.token), { status: 200, ok: true });
    assert.deepEqual(actions, [['7', 'snooze', 10]]);
    await post(port, '/api/alerts/7/dismiss', {}, ok.token);
    assert.deepEqual(actions[1], ['7', 'dismiss', 5]);

    const t = await post(port, '/api/test', {}, ok.token);
    assert.equal(t.delivered, 1);
    assert.equal((await s.next('alert')).preview, true);

    // Removing the phone closes its stream and its token stops working.
    link.removeDevice(ok.token && store.data.phone.devices[0].id);
    assert.equal((await post(port, '/api/test', {}, ok.token)).status, 401);
    s.close();
  } finally { link.stop(); }
});

test('five wrong codes cancel pairing; the install page works without the app built', async () => {
  const link = new PhoneLink({ store: fakeStore(), port: 0, snapshot: () => ({}), onAction() {}, apkPath: 'Z:/nope.apk' });
  const port = await link.start();
  try {
    const { code } = link.newPairCode();
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 4; i++) await post(port, '/api/pair', { code: wrong });
    assert.match((await post(port, '/api/pair', { code: wrong })).error, /Too many wrong codes/);
    assert.equal((await post(port, '/api/pair', { code })).status, 403, 'even the right code is refused now');
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /has not been built yet/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/omega-manager.apk`)).status, 404);
  } finally { link.stop(); }
});

test('phones learn which app version the PC offers, and hear when it is rebuilt', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'omega-app-'));
  const apkPath = join(dir, 'omega-manager.apk'), meta = join(dir, 'omega-manager.json');
  const put = (bytes, versionCode, size = bytes.length) => {
    writeFileSync(apkPath, bytes);
    writeFileSync(meta, JSON.stringify({ versionCode, versionName: '0.2.0', size, sha256: createHash('sha256').update(bytes).digest('hex') }));
  };
  put(Buffer.from('PK first build'), 100);
  const store = fakeStore(), changes = [];
  const link = new PhoneLink({ store, port: 0, apkPath, heartbeatMs: 60, snapshot: () => ({ timers: [], alerts: [] }), onAction() {}, onChange: () => changes.push(1) });
  const port = await link.start();
  try {
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/ping`)).json()).app.versionCode, 100);
    const { code } = link.newPairCode();
    const { token } = await post(port, '/api/pair', { code, name: 'P' });
    // The phone says which version it runs; the PC remembers it for the Phone alerts window.
    const events = [];
    const req = http.get({ port, path: '/api/events', headers: { Authorization: `Bearer ${token}`, 'X-Omega-App-Version': '99' } }, res => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ ev, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
        }
      });
    });
    const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } return fn(); };
    const hello = await waitFor(() => events.find(e => e.ev === 'hello'));
    assert.deepEqual({ ...hello.data.app, sha256: undefined }, { versionCode: 100, versionName: '0.2.0', size: 14, sha256: undefined });
    assert.equal(link.status().devices[0].appVersion, 99);
    assert.equal(link.status().app.versionCode, 100);

    // A half-written build (size doesn't match its description) is not offered.
    put(Buffer.from('PK second build, longer'), 101, 5);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(link.appInfo(), null);
    assert.ok(!events.some(e => e.ev === 'app'), 'nothing is announced for a broken build');
    // The finished build is announced to connected phones.
    put(Buffer.from('PK second build, longer'), 101);
    const ev = await waitFor(() => events.find(e => e.ev === 'app'));
    assert.equal(ev.data.versionCode, 101);
    assert.equal(ev.data.sha256, createHash('sha256').update('PK second build, longer').digest('hex'));
    req.destroy();
  } finally { link.stop(); rmSync(dir, { recursive: true, force: true }); }
});

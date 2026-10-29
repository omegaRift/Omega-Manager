// The Android app's network code (android/src/.../LinkClient.java + SseReader.java, plain Java) runs here on the PC
// against the real phone link, so the phone and the PC are checked to speak the same protocol.
// Skipped when no JDK is found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhoneLink } from '../lib/phone-link.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bin = name => {
  const p = process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  return p && existsSync(p) ? p : name;
};
const hasJdk = spawnSync(bin('javac'), ['-version'], { windowsHide: true }).status === 0;

test('the Android app pairs, downloads its update, gets an alert and dismisses it', { skip: !hasJdk && 'no JDK (javac) found' }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'omega-java-'));
  const actions = [];
  // A stand-in APK the "phone" downloads as its update.
  const apkBytes = Buffer.alloc(200000, 7);
  const apkPath = join(out, 'omega-manager.apk');
  writeFileSync(apkPath, apkBytes);
  const sha = createHash('sha256').update(apkBytes).digest('hex');
  writeFileSync(join(out, 'omega-manager.json'), JSON.stringify({ versionCode: 9, versionName: '0.3.0', size: apkBytes.length, sha256: sha }));
  const link = new PhoneLink({
    store: { data: {}, save() {} }, port: 0, serverName: 'TEST-PC', apkPath,
    snapshot: () => ({ timers: [{ id: 't1', title: 'Tea' }], alerts: [] }),
    onAction: (id, a, m) => actions.push([id, a, m]),
  });
  try {
    const src = join(ROOT, 'android', 'src', 'lab', 'omega', 'manager');
    const c = spawnSync(bin('javac'), ['--release', '8', '-encoding', 'UTF-8', '-d', out,
      join(src, 'LinkClient.java'), join(src, 'SseReader.java'), join(ROOT, 'test', 'java', 'ProtocolCheck.java')], { encoding: 'utf8', windowsHide: true });
    assert.equal(c.status, 0, c.stderr);

    const port = await link.start();
    const { code } = link.newPairCode();
    const java = spawn(bin('java'), ['-Dfile.encoding=UTF-8', '-cp', out, 'lab.omega.manager.ProtocolCheck', `http://127.0.0.1:${port}/`, code], { windowsHide: true });
    const lines = [];
    let err = '';
    java.stderr.on('data', d => { err += d; });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { java.kill(); reject(new Error('Java check timed out:\n' + lines.join('\n') + err)); }, 20000);
      let buf = '';
      java.stdout.setEncoding('utf8');
      java.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          lines.push(line);
          if (line.startsWith('EVENT hello')) link.broadcast('alert', { id: '42', title: 'Tea', message: 'Take the "tea bag" out — café ☕\nnow' });
        }
      });
      java.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Java exited ${code}:\n${lines.join('\n')}\n${err}`)); });
    });
    await done;

    assert.equal(lines[0], 'PAIRED true');
    assert.equal(lines[1], 'REUSED-CODE 403', 'a pair code works once');
    assert.equal(lines[2], `DOWNLOAD ${apkBytes.length} ${sha} 100`, 'the update downloads whole, with the right checksum and progress to 100');
    assert.equal(lines[3], 'SIZE-CHECK The download is bigger than the PC said.');
    assert.match(lines[4], /^EVENT hello \{.*"Tea".*"app":\{"versionCode":9/);
    assert.equal(link.status().devices[0].appVersion, 7, 'the phone told the PC its version');
    assert.equal(lines.find(l => l.startsWith('MESSAGE ')), 'MESSAGE Take the "tea bag" out — café ☕');
    assert.ok(lines.includes('now'), 'the newline in the message survives');
    assert.ok(lines.includes('DISMISSED'));
    assert.deepEqual(actions.map(a => a.slice(0, 2)), [['42', 'dismiss']]);
    assert.equal(link.status().devices[0].name, 'Java "check" phone');
  } finally {
    link.stop();
    rmSync(out, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../lib/reminders.js';

const at = (h, m, s = 0, day = 15) => new Date(2026, 9, day, h, m, s).getTime();

test('countdowns: start, pause, resume, restart, fire', () => {
  const now = at(10, 0);
  const t = R.createTimer({ kind: 'countdown', durationMs: R.durationMs(0, 5, 0), label: ' Tea ', message: 'Take the tea bag out!' }, now, 'a');
  assert.equal(t.label, 'Tea');
  assert.equal(t.dueAt, now + 300e3);
  assert.equal(R.formatLeft(R.leftMs(t, now + 61e3)), '3:59');
  R.pauseTimer(t, now + 60e3);
  assert.deepEqual([t.state, t.leftMs, t.dueAt], ['paused', 240e3, null]);
  assert.equal(R.dueTimers([t], now + 999e3).length, 0, 'a paused timer never goes off');
  R.resumeTimer(t, now + 500e3);
  assert.equal(t.dueAt, now + 740e3);
  assert.equal(R.dueTimers([t], now + 739e3).length, 0);
  assert.equal(R.dueTimers([t], now + 740e3).length, 1);
  const alert = R.fireTimer(t, now + 740e3);
  assert.deepEqual(alert, { timerId: 'a', label: 'Tea', message: 'Take the tea bag out!', sound: true, dueAt: now + 740e3, late: false, firedAt: now + 740e3 });
  assert.equal(t.state, 'done');
  R.restartTimer(t, now + 800e3);
  assert.equal(t.dueAt, now + 1100e3);
});

test('alarms: next time of day, daily repeats, missed while closed', () => {
  assert.equal(R.nextAlarm('14:30', at(10, 0)), at(14, 30));
  assert.equal(R.nextAlarm('09:00', at(10, 0)), at(9, 0, 0, 16), 'already past today: tomorrow');
  assert.equal(R.nextAlarm('10:00', at(10, 0)), at(10, 0, 0, 16), 'exactly now: tomorrow');
  assert.equal(R.nextAlarm('25:00', 0), null);
  const t = R.createTimer({ kind: 'alarm', time: '07:15', daily: true, message: 'Meds' }, at(7, 0), 'b');
  assert.equal(t.dueAt, at(7, 15));
  const a = R.fireTimer(t, at(9, 0));                 // the app was closed at 07:15
  assert.equal(a.late, true);
  assert.equal(t.state, 'running');
  assert.equal(t.dueAt, at(7, 15, 0, 16), 'a daily alarm sets itself for tomorrow');
  const once = R.createTimer({ kind: 'alarm', time: '07:15', daily: true }, at(7, 0), 'c');
  once.daily = false;
  R.fireTimer(once, at(7, 15));
  assert.equal(once.state, 'done');
  assert.equal(R.timerTitle(once), 'Alarm 07:15');
});

test('snooze, edits, and plain-word problems', () => {
  const now = at(12, 0);
  const t = R.createTimer({ kind: 'countdown', durationMs: 90e3 }, now, 'd');
  assert.equal(R.timerTitle(t), '1 min 30 s timer');
  R.fireTimer(t, now + 90e3);
  R.snoozeTimer(t, 10, now + 95e3);
  assert.deepEqual([t.state, t.dueAt], ['running', now + 95e3 + 600e3]);
  R.editTimer(t, { message: '  Stretch  ', label: 'Break' });
  assert.equal(t.message, 'Stretch');
  assert.equal(t.dueAt, now + 695e3, 'editing the words keeps the countdown');
  assert.throws(() => R.editTimer(t, { message: 'x'.repeat(501) }), /at most 500/);
  assert.throws(() => R.createTimer({ kind: 'countdown', durationMs: 0 }, now), /at least 1 second/);
  assert.throws(() => R.createTimer({ kind: 'alarm', time: '' }, now), /time of day/);
  assert.throws(() => R.createTimer({ kind: 'countdown', durationMs: R.durationMs(100, 0, 0) }, now), /99 hours/);
  assert.equal(R.formatLeft(3725000), '1:02:05');
  assert.equal(R.formatLeft(400), '0:01', 'rounds up so it never shows 0:00 early');
  assert.equal(R.describeDuration(R.durationMs(1, 30, 0)), '1 h 30 min');
});

// "My timers": personal countdowns and alarms. When one is done, main shows a red notification with its message.
// A timer: { id, label, message, kind: 'countdown' | 'alarm', durationMs, time: 'HH:MM', daily,
//            sound, state: 'running' | 'paused' | 'done', dueAt, leftMs (while paused), createdAt, firedAt }
// Pure functions; `now` is passed in so tests control the clock.

export const MAX_DURATION = 100 * 3600e3 - 1000;   // 99:59:59
export const SNOOZE_CHOICES = [5, 10];             // minutes

export function durationMs(h, m, s) {
  const n = v => Math.max(0, Math.floor(Number(v) || 0));
  return (n(h) * 3600 + n(m) * 60 + n(s)) * 1000;
}

// The next time the clock shows HH:MM, strictly after `now` (local time).
export function nextAlarm(time, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  const d = new Date(now);
  d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function timerProblem(t) {
  if (!t || (t.kind !== 'countdown' && t.kind !== 'alarm')) return 'Choose a countdown or a time of day.';
  if (t.kind === 'countdown') {
    if (!(t.durationMs >= 1000)) return 'Set how long: at least 1 second.';
    if (t.durationMs > MAX_DURATION) return 'A countdown can be at most 99 hours 59 minutes.';
  }
  if (t.kind === 'alarm' && nextAlarm(t.time, 0) === null) return 'Set the time of day, for example 14:30.';
  if (String(t.message || '').length > 500) return 'The message can be at most 500 characters.';
  if (String(t.label || '').length > 80) return 'The name can be at most 80 characters.';
  return null;
}

const clean = input => ({
  label: String(input.label || '').trim(),
  message: String(input.message || '').trim(),
  kind: input.kind === 'alarm' ? 'alarm' : 'countdown',
  durationMs: Math.round(Number(input.durationMs) || 0),
  time: String(input.time || ''),
  daily: input.kind === 'alarm' && !!input.daily,
  sound: input.sound !== false,
});

// A new running timer. Throws with a plain message when the input can't make one.
export function createTimer(input, now, id) {
  const t = clean(input);
  const p = timerProblem(t);
  if (p) throw new Error(p);
  return { id, ...t, state: 'running', dueAt: t.kind === 'alarm' ? nextAlarm(t.time, now) : now + t.durationMs, createdAt: now, firedAt: null };
}

// Name, message and sound can change at any time without touching the countdown.
export function editTimer(t, input) {
  const next = { ...t };
  if ('label' in input) next.label = String(input.label || '').trim();
  if ('message' in input) next.message = String(input.message || '').trim();
  if ('sound' in input) next.sound = input.sound !== false;
  const p = timerProblem(next);
  if (p) throw new Error(p);
  return Object.assign(t, next);
}

export function pauseTimer(t, now) {
  if (t.state !== 'running' || t.kind !== 'countdown') return t;
  t.leftMs = Math.max(0, t.dueAt - now);
  t.state = 'paused';
  t.dueAt = null;
  return t;
}
export function resumeTimer(t, now) {
  if (t.state !== 'paused') return t;
  t.dueAt = now + Math.max(1000, t.leftMs || 0);
  delete t.leftMs;
  t.state = 'running';
  return t;
}
export function restartTimer(t, now) {
  delete t.leftMs;
  t.state = 'running';
  t.dueAt = t.kind === 'alarm' ? nextAlarm(t.time, now) : now + t.durationMs;
  return t;
}
export function snoozeTimer(t, minutes, now) {
  delete t.leftMs;
  t.state = 'running';
  t.snoozed = true;
  t.dueAt = now + Math.max(1, Number(minutes) || 5) * 60e3;
  return t;
}

export const dueTimers = (list, now) => list.filter(t => t.state === 'running' && t.dueAt != null && t.dueAt <= now);

// The timer went off. A daily alarm sets itself for tomorrow; anything else is done.
// Returns what the notification shows.
export function fireTimer(t, now) {
  const late = now - t.dueAt > 60e3;
  const alert = { timerId: t.id, label: t.label, message: t.message, sound: t.sound, dueAt: t.dueAt, late, firedAt: now };
  t.firedAt = now;
  delete t.snoozed;
  if (t.kind === 'alarm' && t.daily) t.dueAt = nextAlarm(t.time, Math.max(now, t.dueAt));
  else { t.state = 'done'; t.dueAt = null; }
  return alert;
}

export function leftMs(t, now) {
  if (t.state === 'paused') return t.leftMs || 0;
  if (t.state !== 'running' || t.dueAt == null) return 0;
  return Math.max(0, t.dueAt - now);
}

// 3725000 -> "1:02:05", 65000 -> "1:05", 0 -> "0:00"
export function formatLeft(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = n => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

// "5 min", "1 h 30 min", "45 s"
export function describeDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h && `${h} h`, m && `${m} min`, sec && `${sec} s`].filter(Boolean).join(' ') || '0 s';
}

export function timerTitle(t) {
  if (t.label) return t.label;
  return t.kind === 'alarm' ? `Alarm ${t.time}` : `${describeDuration(t.durationMs)} timer`;
}

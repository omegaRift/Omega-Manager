// Timers. Pure: every function takes "now" so tests can move time freely.
// Trigger kinds:
//   { kind: 'interval', every: 5, unit: 's'|'min'|'h', maxRuns?: n }   repeats while the app is open
//   { kind: 'daily', time: 'HH:MM', days: [0..6] }                     0 = Sunday; empty/missing = every day
//   { kind: 'once', at: ISO string }                                   one time, then switches itself off
// Runtime fields kept on the trigger: next (ms epoch), runs (count), enabled.

const UNIT_MS = { s: 1000, min: 60e3, h: 3600e3 };
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function intervalMs(t) {
  const ms = Number(t.every) * (UNIT_MS[t.unit] || 1000);
  return Number.isFinite(ms) && ms >= 1000 ? ms : null;
}

export function validateTrigger(t) {
  if (!t || typeof t !== 'object') return 'Missing timer.';
  if (t.kind === 'interval') {
    const ms = intervalMs(t);
    if (!ms) return 'Repeat every at least 1 second.';
    if (t.maxRuns != null && t.maxRuns !== '' && !(Number(t.maxRuns) >= 1)) return 'Stop after must be 1 or more runs (or empty).';
    return null;
  }
  if (t.kind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time || '')) return 'Pick a time of day like 08:30.';
    if (t.days && !t.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return 'Days must be Sun–Sat.';
    return null;
  }
  if (t.kind === 'once') return Number.isFinite(Date.parse(t.at)) ? null : 'Pick a date and time.';
  return `Unknown timer kind "${t.kind}".`;
}

// Next time this trigger should fire, strictly after `now` unless it is overdue (then `now`).
// `lastRun` is when it last fired (ms), or null.
export function nextFire(t, now, lastRun = null) {
  if (!t || t.enabled === false || validateTrigger(t)) return null;
  if (t.kind === 'interval') {
    if (t.maxRuns && (t.runs || 0) >= Number(t.maxRuns)) return null;
    const ms = intervalMs(t);
    if (lastRun == null) return now + ms;
    const due = lastRun + ms;
    return due > now ? due : now;            // missed while busy: run once now, never a burst
  }
  if (t.kind === 'once') {
    if ((t.runs || 0) > 0) return null;
    const at = Date.parse(t.at);
    return at;                               // in the past -> due right away (caller decides)
  }
  if (t.kind === 'daily') {
    const [hh, mm] = t.time.split(':').map(Number);
    const days = t.days && t.days.length ? t.days : [0, 1, 2, 3, 4, 5, 6];
    const d = new Date(now);
    for (let i = 0; i < 8; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
      if (c.getTime() > now && days.includes(c.getDay())) return c.getTime();
    }
  }
  return null;
}

// "Once" timers in the past when the app starts: skip them instead of firing late.
export function staleOnce(t, now, graceMs = 60e3) {
  return t.kind === 'once' && !(t.runs > 0) && Date.parse(t.at) < now - graceMs;
}

export function describeTrigger(t) {
  if (t.kind === 'interval') {
    const unit = { s: 'second', min: 'minute', h: 'hour' }[t.unit] || 'second';
    const n = Number(t.every);
    const base = `Every ${n === 1 ? '' : n + ' '}${unit}${n === 1 ? '' : 's'}`;
    return t.maxRuns ? `${base}, ${t.maxRuns} time${t.maxRuns == 1 ? '' : 's'}` : base;
  }
  if (t.kind === 'daily') {
    const days = t.days && t.days.length && t.days.length < 7 ? t.days : null;
    const label = !days ? 'Every day' : sameSet(days, [1, 2, 3, 4, 5]) ? 'Weekdays' : sameSet(days, [0, 6]) ? 'Weekends' : days.slice().sort().map(d => DAY_NAMES[d]).join(', ');
    return `${label} at ${t.time}`;
  }
  if (t.kind === 'once') {
    const d = new Date(t.at);
    return `Once, ${d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  return 'Timer';
}

const sameSet = (a, b) => a.length === b.length && b.every(x => a.includes(x));

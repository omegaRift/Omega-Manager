// Fires task timers while the app runs. One task runs at a time (they share one mouse and keyboard);
// a task that comes due while another runs waits in line. Time comes from `now()` so tests can fake it.
import { nextFire, staleOnce } from './schedule.js';

export class Scheduler {
  constructor({ tasks, runTask, onChange = () => {}, now = () => Date.now(), tickMs = 500 }) {
    this.tasks = tasks;          // () => array of tasks (live objects; next/runs are written onto triggers)
    this.runTask = runTask;      // async (task, trigger) => void
    this.onChange = onChange;
    this.now = now;
    this.tickMs = tickMs;
    this.queue = [];
    this.busy = false;
    this.paused = false;
    this.timer = null;
  }

  start() {
    const now = this.now();
    for (const t of this.tasks()) for (const tr of t.triggers || []) {
      if (staleOnce(tr, now)) { tr.enabled = false; tr.missed = true; }
      tr.next = null;            // recomputed fresh: intervals count from app start
    }
    this.plan();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // Fill in `next` for every trigger that has none.
  plan() {
    const now = this.now();
    let changed = false;
    for (const t of this.tasks()) for (const tr of t.triggers || []) {
      const want = t.enabled === false ? null : (tr.next ?? nextFire(tr, now, null));
      if (want !== tr.next) { tr.next = want; changed = true; }
    }
    if (changed) this.onChange();
  }

  // A task or trigger was edited: forget its plan so it is worked out again.
  replan(task) { for (const tr of task.triggers || []) tr.next = null; this.plan(); }

  tick() {
    if (this.paused) return;
    const now = this.now();
    for (const t of this.tasks()) {
      if (t.enabled === false) continue;
      for (const tr of t.triggers || []) {
        if (tr.next == null || tr.next > now) continue;
        tr.runs = (tr.runs || 0) + 1;
        tr.lastRun = now;
        tr.next = nextFire(tr, now, now);
        if (tr.kind === 'once') { tr.enabled = false; tr.next = null; }
        if (!this.queue.some(q => q.task.id === t.id)) this.queue.push({ task: t, trigger: tr });
        this.onChange();
      }
    }
    this.drain();
  }

  async drain() {
    if (this.busy || this.paused) return;
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    try { await this.runTask(item.task, item.trigger); }
    catch { /* runTask reports its own errors */ }
    finally {
      this.busy = false;
      // Intervals count from when the run finished, so a slow task never stacks up runs.
      if (item.trigger.kind === 'interval' && item.trigger.next != null) item.trigger.next = nextFire(item.trigger, this.now(), this.now());
      this.onChange();
      if (this.queue.length) setTimeout(() => this.drain(), 0);
    }
  }

  setPaused(p) { this.paused = !!p; if (p) this.queue = []; this.onChange(); }
  clearQueue() { this.queue = []; }
}

// Saves tasks and settings as JSON in the app's data folder (atomic write: temp file, then rename).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_SETTINGS = {
  ollamaHost: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b',
  failsafe: true,          // moving the mouse during a run stops it
  notifyRuns: true,        // a notification when a timer starts a task
  typeDelay: 15,           // ms between typed characters
  theme: 'system',
  closeToTray: true,
};

export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'autopilot.json');
    this.data = { version: 1, tasks: [], settings: { ...DEFAULT_SETTINGS }, history: [], reminders: [] };
    if (existsSync(this.file)) {
      try {
        const d = JSON.parse(readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } };
      } catch (e) {
        // Keep the unreadable file for the user instead of overwriting it.
        copyFileSync(this.file, this.file + `.unreadable-${Date.now()}`);
      }
    }
  }
  save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }
  get settings() { return this.data.settings; }
  setSetting(k, v) { if (!(k in DEFAULT_SETTINGS)) throw new Error('Unknown setting ' + k); this.data.settings[k] = v; this.save(); }
  get tasks() { return this.data.tasks; }
  task(id) { return this.data.tasks.find(t => t.id === id); }
  upsertTask(t) {
    if (!t.id) t.id = randomUUID();
    const ids = list => { for (const s of list || []) { if (!s.id) s.id = randomUUID(); ids(s.children); ids(s.else); } };
    ids(t.steps);
    for (const tr of t.triggers || []) if (!tr.id) tr.id = randomUUID();
    const i = this.data.tasks.findIndex(x => x.id === t.id);
    if (i >= 0) this.data.tasks[i] = t; else this.data.tasks.push(t);
    this.save();
    return t;
  }
  deleteTask(id) { this.data.tasks = this.data.tasks.filter(t => t.id !== id); this.save(); }
  addHistory(entry) {
    this.data.history.unshift(entry);
    this.data.history.length = Math.min(this.data.history.length, 200);
    this.save();
  }
}

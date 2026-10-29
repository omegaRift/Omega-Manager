// The only bridge between the window and the rest of the app. Every call resolves to its value or throws.
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args).then(r => { if (!r.ok) throw new Error(r.error); return r.value; });
const on = channel => cb => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('ap', {
  getState: () => call('get-state'),
  listSources: () => call('list-sources'),
  setPreview: id => call('set-preview', id),
  resolveViewport: vp => call('resolve-viewport', vp),
  saveTask: t => call('save-task', t),
  createTimer: input => call('timer-create', input),
  editTimer: (id, fields) => call('timer-edit', id, fields),
  timerAction: (id, action) => call('timer-action', id, action),
  previewAlert: input => call('timer-preview', input),
  alertInfo: id => call('alert-info', id),
  alertSize: (id, h) => call('alert-size', id, h),
  alertAction: (id, action, minutes) => call('alert-action', id, action, minutes),
  onShowMode: on('show-mode'),
  phonePair: () => call('phone-pair'),
  phoneCancelPair: () => call('phone-cancel-pair'),
  phoneRemove: id => call('phone-remove', id),
  phoneCheck: () => call('phone-check'),
  launchInfo: vp => call('launch-info', vp),
  openWindow: (vp, taskId) => call('open-window', vp, taskId),
  browseExe: current => call('browse-exe', current),
  deleteTask: id => call('delete-task', id),
  runTask: (id, opts) => call('run-task', id, opts),
  stopAll: () => call('stop-all'),
  detect: (vp, method) => call('detect', vp, method),
  cancelDetect: () => call('cancel-detect'),
  aiFind: (vp, d) => call('ai-find', vp, d),
  checkCond: (vp, cond) => call('check-cond', vp, cond),
  setSetting: (k, v) => call('set-setting', k, v),
  pauseTimers: p => call('pause-timers', p),
  models: () => call('models'),
  clearHistory: () => call('clear-history'),
  onState: on('state'),
  onRunStep: on('run-step'),
  onRunEnd: on('run-end'),
  onBusy: on('busy'),
});

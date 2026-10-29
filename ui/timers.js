/* "My timers": personal countdowns and alarms. When one is done, main shows a red notification with its message.
   Uses the helpers app.js defines ($, esc, icon, toast, tryIt, S); main owns the timers so they ring with the window closed. */
'use strict';
const MyTimers = (() => {
  let kind = 'countdown';
  let mode = 'auto';
  const two = n => String(n).padStart(2, '0');
  const hm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Same rules as lib/reminders.js formatLeft / describeDuration / timerTitle.
  function formatLeft(ms) {
    const s = Math.ceil(Math.max(0, ms) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
  }
  function describeDuration(ms) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return [h && `${h} h`, m && `${m} min`, sec && `${sec} s`].filter(Boolean).join(' ') || '0 s';
  }
  const title = t => t.label || (t.kind === 'alarm' ? `Alarm ${t.time}` : `${describeDuration(t.durationMs)} timer`);
  const left = t => t.state === 'paused' ? (t.leftMs || 0) : t.state === 'running' && t.dueAt ? Math.max(0, t.dueAt - Date.now()) : 0;
  const list = () => S.reminders || [];

  // ---------- the form ----------
  function formInput() {
    const n = id => Math.max(0, Math.floor(Number($(id).value) || 0));
    return {
      kind,
      durationMs: (n('tmH') * 3600 + n('tmM') * 60 + n('tmS')) * 1000,
      time: $('tmTime').value,
      daily: $('tmDaily').checked,
      label: $('tmLabel').value,
      message: $('tmMessage').value,
      sound: $('tmSound').checked,
    };
  }
  function setKind(k) {
    kind = k;
    for (const b of document.querySelectorAll('#tmKind [data-kind]')) b.classList.toggle('on', b.dataset.kind === k);
    $('tmCountdownBox').hidden = k !== 'countdown';
    $('tmAlarmBox').hidden = k !== 'alarm';
    if (k === 'alarm' && !$('tmTime').value) {
      const d = new Date(Date.now() + 60 * 60e3);
      $('tmTime').value = `${two(d.getHours())}:00`;
    }
    renderFormNote();
  }
  function renderFormNote() {
    const i = formInput();
    let note = '';
    if (kind === 'countdown') note = i.durationMs >= 1000 ? `Rings at ${hm(Date.now() + i.durationMs)}.` : 'Set how long.';
    else if (/^\d{1,2}:\d{2}$/.test(i.time)) {
      const [h, m] = i.time.split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1);
      note = `Rings ${d.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow'} at ${hm(d)}${i.daily ? ', then every day' : ''}.`;
    } else note = 'Set the time of day.';
    $('tmNote').textContent = note;
  }
  async function start() {
    const t = await tryIt(() => ap.createTimer(formInput()));
    if (!t) return;
    toast(`Started "${title(t)}". It rings at ${hm(t.dueAt)}.`);
    $('tmLabel').value = ''; $('tmMessage').value = '';
    renderFormNote();
  }

  // ---------- phone alerts ----------
  const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(ms).toLocaleDateString(); };
  function renderPhone() {
    const p = S.phone;
    $('tmPhoneDot').hidden = !(p && p.devices.some(d => d.online));
    if (!$('phoneDlg').open) return;
    if (!p) { $('phServe').className = 'phone-serve bad'; $('phServe').textContent = 'The phone link is switched off.'; return; }
    $('phUrl').textContent = p.url || '(waiting for Tailscale)';
    const sv = p.serve || {};
    $('phServe').className = 'phone-serve ' + (sv.ok ? 'ok' : 'bad');
    $('phServe').innerHTML = icon(sv.ok ? 'check' : 'alert') + '<span>' + esc(sv.note || '').replace(/Run: (.+)$/, 'Run: <code>$1</code>') + '</span>';
    const pr = p.pairing;
    if (pr && pr.expiresAt > Date.now()) {
      if (!$('phPair').querySelector('.pair-code') || $('phPair').dataset.code !== pr.code) {
        $('phPair').dataset.code = pr.code;
        $('phPair').innerHTML = `<span class="pair-code" id="phCode">${pr.code.slice(0, 3)} ${pr.code.slice(3)}</span><span class="pair-left" id="phLeft"></span><button type="button" class="btn sm" id="phNew" data-icon="repeat">New code</button>`;
        applyIcons($('phPair'));
      }
      $('phLeft').textContent = `Works once, for ${formatLeft(pr.expiresAt - Date.now())}`;
    } else if ($('phPair').dataset.code !== '') {
      $('phPair').dataset.code = '';
      $('phPair').innerHTML = `<button type="button" class="btn primary" id="phNew" data-icon="phone">New code</button><span class="pair-left">Each code works for one phone, for 5 minutes.</span>`;
      applyIcons($('phPair'));
    }
    // Which app each phone runs, against the one this PC offers (phones update themselves from it).
    const ver = d => {
      if (!p.app) return '';
      if (!d.appVersion) return '<span class="ph-ver old" title="This phone has the first version of the app, from before updates. Install the new one on the phone once from the address above; after that it updates itself.">Update by hand once</span>';
      return d.appVersion >= p.app.versionCode
        ? '<span class="ph-ver ok" title="This phone has the newest app this PC offers.">App up to date</span>'
        : '<span class="ph-ver" title="A newer app is on this PC. The phone installs it when it connects (or offers it, if its Auto updates switch is off).">Update waiting</span>';
    };
    const list = p.devices.map(d => `<li data-phone="${esc(d.id)}">${icon('phone')}<span class="ph-name">${esc(d.name)}</span>${ver(d)}
      <span class="ph-state ${d.online ? 'on' : ''}">${d.online ? 'Connected now' : 'Last seen ' + ago(d.lastSeen)}</span>
      <button type="button" class="btn sm ghost danger" data-phone-remove title="Stop sending alerts to this phone">Remove</button></li>`).join('');
    const html = list || '<li class="none">No phones yet.</li>';
    if ($('phList').dataset.html !== html) { $('phList').dataset.html = html; $('phList').innerHTML = html; }
  }
  function openPhone() {
    $('phPair').dataset.code = 'x';
    $('phoneDlg').showModal();
    renderPhone();
    ap.phoneCheck().then(renderPhone).catch(() => {});
  }

  // ---------- the cards ----------
  function card(t) {
    const done = t.state === 'done';
    const sub = t.kind === 'alarm'
      ? `${t.daily ? 'Every day' : 'Once'} at ${t.time}`
      : `${describeDuration(t.durationMs)} countdown`;
    const when = done ? `Done at ${hm(t.firedAt)}` : t.state === 'paused' ? 'Paused' : `Rings at ${hm(t.dueAt)}`;
    const tags = [t.snoozed && '<span class="tag red">Snoozed</span>', t.state === 'paused' && '<span class="tag">Paused</span>'].filter(Boolean).join('');
    const buttons = done
      ? `<button class="btn sm" data-tact="restart">${icon('repeat')}Start again</button>`
      : `${t.kind === 'countdown' ? (t.state === 'paused'
          ? `<button class="btn sm primary" data-tact="resume">${icon('play')}Resume</button>`
          : `<button class="btn sm" data-tact="pause">${icon('pause')}Pause</button>`) : ''}
         <button class="btn sm" data-tact="restart">${icon('repeat')}Restart</button>`;
    return `<article class="tm-card ${t.state}" data-timer="${esc(t.id)}">
      <div class="tm-top"><span class="tm-name" title="${esc(title(t))}">${esc(title(t))}</span>${tags}
        <button class="btn icon-only sm ghost danger" data-tact="delete" title="Delete this timer" aria-label="Delete this timer">${icon('trash')}</button></div>
      <div class="tm-sub">${esc(sub)} · <span class="tm-when">${esc(when)}</span></div>
      ${done ? '' : `<div class="tm-left">${formatLeft(left(t))}</div>${t.kind === 'countdown' ? '<div class="tm-bar"><i></i></div>' : ''}`}
      <label class="tm-msg" title="What the red notification will say"><span class="flag"></span>
        <input data-tedit="message" maxlength="500" value="${esc(t.message)}" placeholder="Notification message (optional)" aria-label="Notification message"></label>
      <div class="tm-actions">${buttons}</div>
    </article>`;
  }

  function render() {
    if (!$('tmRunning')) return;
    const all = list();
    const running = all.filter(t => t.state !== 'done').sort((a, b) => (a.state === 'paused') - (b.state === 'paused') || left(a) - left(b));
    const done = all.filter(t => t.state === 'done').sort((a, b) => b.firedAt - a.firedAt);
    $('modeTimersCount').textContent = running.length || '';
    $('tmRunCount').textContent = running.length || '';
    // Don't rebuild a list while its message box is being typed in.
    const editing = document.activeElement?.dataset?.tedit;
    if (!editing || !$('tmRunning').contains(document.activeElement)) {
      $('tmRunning').innerHTML = running.length ? running.map(card).join('')
        : `<div class="tm-empty">${icon('hourglass')}<b>No timers running</b>Set a countdown or a time on the left. When it is done, a red notification pops up with your message, even if this window is closed to the tray.</div>`;
    }
    if (!editing || !$('tmDone').contains(document.activeElement)) $('tmDone').innerHTML = done.map(card).join('');
    $('tmDoneHead').hidden = !done.length;
    renderPhone();
    tick();
  }

  // Every quarter second: the numbers and bars only.
  function tick() {
    if ($('phoneDlg').open && S.phone?.pairing) renderPhone();
    for (const el of document.querySelectorAll('#tmRunning .tm-card')) {
      const t = list().find(x => x.id === el.dataset.timer);
      if (!t) continue;
      const ms = left(t);
      const big = el.querySelector('.tm-left');
      if (big) big.textContent = formatLeft(ms);
      const bar = el.querySelector('.tm-bar i');
      if (bar && t.durationMs) bar.style.width = `${Math.min(100, 100 * (1 - ms / t.durationMs))}%`;
      el.classList.toggle('soon', t.state === 'running' && ms <= 60e3);
    }
  }

  function setMode(m) {
    mode = m === 'timers' ? 'timers' : 'auto';
    try { localStorage.setItem('omega.mode', mode); } catch { }
    document.body.classList.toggle('mode-timers', mode === 'timers');
    $('timersPage').hidden = mode !== 'timers';
    for (const b of document.querySelectorAll('.mode[data-mode]')) { b.classList.toggle('on', b.dataset.mode === mode); b.setAttribute('aria-selected', b.dataset.mode === mode); }
    // The live viewport preview only runs while it can be seen.
    if (mode === 'timers') stopStream(); else if (draft) startPreview();
    if (mode === 'timers') { render(); renderFormNote(); }
  }

  function bind() {
    for (const b of document.querySelectorAll('.mode[data-mode]')) b.onclick = () => setMode(b.dataset.mode);
    for (const b of document.querySelectorAll('#tmKind [data-kind]')) b.onclick = () => setKind(b.dataset.kind);
    for (const b of document.querySelectorAll('#tmQuick [data-quick]')) b.onclick = () => {
      const s = Number(b.dataset.quick);
      $('tmH').value = Math.floor(s / 3600); $('tmM').value = Math.floor((s % 3600) / 60); $('tmS').value = s % 60;
      renderFormNote();
    };
    for (const id of ['tmH', 'tmM', 'tmS', 'tmTime', 'tmDaily']) $(id).addEventListener('input', renderFormNote);
    $('tmStart').onclick = start;
    $('tmPreview').onclick = () => { const i = formInput(); tryIt(() => ap.previewAlert({ label: i.label, message: i.message, sound: i.sound })); };
    $('tmMessage').addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) start(); });
    $('tmClearDone').onclick = () => tryIt(() => ap.timerAction(null, 'clear-done'));
    const lists = $('timersPage');
    lists.addEventListener('click', e => {
      const b = e.target.closest('[data-tact]');
      const c = e.target.closest('[data-timer]');
      if (!b || !c) return;
      tryIt(() => ap.timerAction(c.dataset.timer, b.dataset.tact));
    });
    lists.addEventListener('change', e => {
      const f = e.target.dataset?.tedit;
      const c = e.target.closest('[data-timer]');
      if (f && c) tryIt(() => ap.editTimer(c.dataset.timer, { [f]: e.target.value })).then(t => { if (t) toast('Message saved.'); });
    });
    lists.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset?.tedit) e.target.blur(); });
    ap.onShowMode(setMode);
    $('tmPhoneBtn').onclick = openPhone;
    $('phoneDlg').addEventListener('click', e => {
      if (e.target.closest('#phNew')) tryIt(() => ap.phonePair()).then(r => { if (r) { S.phone = { ...S.phone, pairing: r }; renderPhone(); } });
      if (e.target.closest('#phCopy')) navigator.clipboard.writeText($('phUrl').textContent).then(() => toast('Address copied.'), () => {});
      const rm = e.target.closest('[data-phone-remove]');
      if (rm) { const li = rm.closest('[data-phone]'); if (confirm(`Stop sending alerts to "${li.querySelector('.ph-name').textContent}"? It can pair again with a new code.`)) tryIt(() => ap.phoneRemove(li.dataset.phone)); }
    });
    $('phoneDlg').addEventListener('close', () => { if (S.phone?.pairing) ap.phoneCancelPair(); });
    setInterval(tick, 250);
    setInterval(renderFormNote, 15e3);
    let saved = 'auto';
    try { saved = localStorage.getItem('omega.mode') || 'auto'; } catch { }
    setKind('countdown');
    if (saved === 'timers') setMode('timers');
  }

  return { bind, render, setMode, formatLeft, openPhone };
})();

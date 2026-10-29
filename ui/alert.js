/* The red notification shown when one of "My timers" is done. One window per alert; main places them. */
'use strict';
const id = new URLSearchParams(location.search).get('id');
const $ = x => document.getElementById(x);
const hm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// A short three-note chime, played three times unless the alert is dismissed first.
let audio = null, chimes = [];
function chime() {
  try {
    audio = audio || new AudioContext();
    const t0 = audio.currentTime + 0.05;
    [880, 1175, 1568].forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * 0.18);
      g.gain.linearRampToValueAtTime(0.25, t0 + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.18 + 0.5);
      o.connect(g).connect(audio.destination);
      o.start(t0 + i * 0.18); o.stop(t0 + i * 0.18 + 0.55);
    });
  } catch { /* no sound device: the card is still there */ }
}
function stopSound() { chimes.forEach(clearTimeout); chimes = []; if (audio) audio.close().catch(() => {}); audio = null; }

function act(action, minutes) { stopSound(); window.ap.alertAction(id, action, minutes); }

(async function init() {
  let a;
  try { a = await window.ap.alertInfo(id); } catch { window.close(); return; }
  document.title = `${a.title} - Omega Manager alert`;
  $('kind').textContent = a.preview ? 'Preview' : 'Timer done';
  $('when').textContent = hm(a.firedAt);
  $('title').textContent = a.title;
  $('msg').textContent = a.message;
  if (a.late) { $('late').hidden = false; $('late').textContent = `It was due at ${hm(a.dueAt)}, while Omega Manager was closed.`; }
  const acts = $('actions');
  if (a.canSnooze) for (const m of a.snooze) {
    const b = document.createElement('button');
    b.className = 'b'; b.textContent = `Snooze ${m} min`; b.dataset.snooze = m;
    b.onclick = () => act('snooze', m);
    acts.append(b);
  }
  const open = document.createElement('button');
  open.className = 'b'; open.textContent = 'Open timers'; open.onclick = () => act('open');
  const ok = document.createElement('button');
  ok.className = 'b main'; ok.id = 'dismiss'; ok.textContent = 'Dismiss'; ok.onclick = () => act('dismiss');
  acts.append(open, ok);
  $('x').onclick = () => act('dismiss');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') act('dismiss'); });
  await window.ap.alertSize(id, $('card').scrollHeight);
  if (a.sound) { chime(); chimes = [setTimeout(chime, 3000), setTimeout(chime, 6000)]; }
})();

// Turns "ctrl+shift+s" style shortcuts into Windows virtual-key codes.
const NAMED = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B, windows: 0x5B, meta: 0x5B, cmd: 0x5B,
  enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B, space: 0x20, backspace: 0x08,
  delete: 0x2E, del: 0x2E, insert: 0x2D, ins: 0x2D, home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21,
  pagedown: 0x22, pgdn: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, capslock: 0x14,
  printscreen: 0x2C, menu: 0x5D, apps: 0x5D, pause: 0x13,
  plus: 0xBB, '=': 0xBB, minus: 0xBD, '-': 0xBD, ',': 0xBC, comma: 0xBC, '.': 0xBE, period: 0xBE,
  '/': 0xBF, ';': 0xBA, "'": 0xDE, '[': 0xDB, ']': 0xDD, '\\': 0xDC, '`': 0xC0,
  volumeup: 0xAF, volumedown: 0xAE, mute: 0xAD, playpause: 0xB3, nexttrack: 0xB0, prevtrack: 0xB1,
};
const MODIFIERS = new Set([0x11, 0x10, 0x12, 0x5B]);

export function keyCode(name) {
  const k = String(name).trim().toLowerCase();
  if (k in NAMED) return NAMED[k];
  if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(k);
  if (f) return 0x6F + Number(f[1]);
  const n = /^num([0-9])$/.exec(k);
  if (n) return 0x60 + Number(n[1]);
  return null;
}

// "Ctrl+Shift+S" -> { vks: [0x11, 0x10, 0x53] }, or { error } in plain words.
export function parseCombo(text) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'Enter a key, for example Enter or Ctrl+S.' };
  // "+" alone (or a trailing "++") means the plus key.
  const parts = raw.replace(/\+\+$/, '+plus').split('+').map(s => s.trim()).filter(Boolean);
  const vks = [];
  for (const p of parts) {
    const vk = keyCode(p);
    if (vk == null) return { error: `"${p}" is not a key name this app knows.` };
    vks.push(vk);
  }
  const mainKeys = vks.filter(v => !MODIFIERS.has(v));
  if (mainKeys.length > 1) return { error: 'Use one main key with any modifiers, e.g. Ctrl+Shift+S.' };
  // Modifiers first so the shortcut works however it was typed.
  vks.sort((a, b) => (MODIFIERS.has(b) ? 1 : 0) - (MODIFIERS.has(a) ? 1 : 0));
  return { vks };
}

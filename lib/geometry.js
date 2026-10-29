// Pure helpers for viewports and coordinates. A step remembers its spot as a fraction (0..1) of the
// viewport, so it still lands right if the window moves or the screen resolution changes.

// desktopCapturer ids look like "screen:0:0" or "window:132456:0" (on Windows the number is the HWND).
export function parseSourceId(id) {
  const m = /^(screen|window):(-?\d+):/.exec(String(id || ''));
  if (!m) return null;
  return m[1] === 'window' ? { kind: 'window', hwnd: Number(m[2]) } : { kind: 'screen', index: Number(m[2]) };
}

export const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));

export function toScreen(rect, fx, fy) {
  return { x: Math.round(rect.x + clamp01(fx) * (rect.w - 1)), y: Math.round(rect.y + clamp01(fy) * (rect.h - 1)) };
}

export function rectToFraction(rect, r) {
  return {
    fx1: clamp01((r.x - rect.x) / rect.w), fy1: clamp01((r.y - rect.y) / rect.h),
    fx2: clamp01((r.x + r.w - rect.x) / rect.w), fy2: clamp01((r.y + r.h - rect.y) / rect.h),
  };
}

export const boxCenter = b => ({ fx: (b.fx1 + b.fx2) / 2, fy: (b.fy1 + b.fy2) / 2 });

// Where a saved window viewport lives now: same HWND if it still exists, otherwise the same program
// with the same title, otherwise the same program if it has exactly one window.
export function matchWindow(saved, windows) {
  if (!saved || !Array.isArray(windows)) return null;
  const same = windows.find(w => w.hwnd === saved.hwnd);
  if (same && (!saved.process || same.process === saved.process)) return same;
  const proc = saved.process ? windows.filter(w => w.process === saved.process) : [];
  const byTitle = proc.find(w => w.title === saved.title);
  if (byTitle) return byTitle;
  if (saved.titleMatch) {
    const needle = saved.titleMatch.toLowerCase();
    const hit = proc.find(w => w.title.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return proc.length === 1 ? proc[0] : null;
}

// Element-local point -> fraction of a picture shown with object-fit: contain inside a box.
export function containFraction(boxW, boxH, picW, picH, px, py) {
  const s = Math.min(boxW / picW, boxH / picH);
  const w = picW * s, h = picH * s;
  const ox = (boxW - w) / 2, oy = (boxH - h) / 2;
  const fx = (px - ox) / w, fy = (py - oy) / h;
  return { fx, fy, inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
}

// Size to send to the vision model: long edge at most `max`, never upscaled.
export function fitLongEdge(w, h, max = 1280) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

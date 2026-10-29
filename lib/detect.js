// Finding inputs with the local vision model (Ollama). qwen3.5 answers boxes on a 0..1000 grid for both
// axes, whatever the picture size (measured on this machine, 2026-10-29).
import { clamp01 } from './geometry.js';

export const DEFAULT_MODEL = 'qwen3.5:9b';
export const DEFAULT_HOST = 'http://127.0.0.1:11434';

export const LIST_PROMPT = `This is a screenshot of a user interface. List every control a user can type into or operate: text boxes, search fields, text areas, dropdowns, checkboxes, radio buttons and buttons.
For each give its type, the visible label or placeholder text, and its bounding box.
Answer as JSON only: {"items":[{"type":"textbox|textarea|dropdown|checkbox|radio|button|link","label":"...","box":[x1,y1,x2,y2]}]}`;

export const findPrompt = describe => `This is a screenshot of a user interface. Find this element: ${describe}
If it is visible, give its bounding box. Answer as JSON only: {"found":true,"label":"...","box":[x1,y1,x2,y2]}
If it is not visible, answer {"found":false}.`;

const TYPES = {
  textbox: 'textbox', text: 'textbox', textfield: 'textbox', input: 'textbox', searchfield: 'textbox', search: 'textbox',
  searchbox: 'textbox', edit: 'textbox', field: 'textbox', password: 'textbox', email: 'textbox', number: 'textbox',
  textarea: 'textarea', multiline: 'textarea', document: 'textarea',
  dropdown: 'dropdown', select: 'dropdown', combobox: 'dropdown', combo: 'dropdown', list: 'dropdown',
  checkbox: 'checkbox', check: 'checkbox', toggle: 'checkbox', switch: 'checkbox',
  radio: 'radio', radiobutton: 'radio', button: 'button', link: 'link', hyperlink: 'link', slider: 'slider',
};
export const normType = t => TYPES[String(t || '').toLowerCase().replace(/[^a-z]/g, '')] || 'other';
export const TYPABLE = new Set(['textbox', 'textarea']);

// Pull JSON out of a model answer: whole thing, else every balanced {...} object (truncated answers).
export function salvageJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { }
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) { try { objs.push(JSON.parse(s.slice(start, i + 1))); } catch { } start = -1; }
    }
  }
  if (objs.length) return objs.length === 1 ? objs[0] : { items: objs };
  // Last try: inner objects of a cut-off {"items":[ ... list.
  const inner = [...s.matchAll(/\{[^{}]*"box"\s*:\s*\[[^\]]*\][^{}]*\}/g)].map(m => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
  return inner.length ? { items: inner } : null;
}

// Model box -> fractions of the picture. 0..1000 grid normally; if a number is above 1000 the model
// used pixels of the picture it was sent, so scale by that instead.
export function boxToFraction(box, imgW, imgH) {
  if (!Array.isArray(box) || box.length < 4) return null;
  let [x1, y1, x2, y2] = box.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const pixels = Math.max(x1, y1, x2, y2) > 1000;
  const sx = pixels ? imgW : 1000, sy = pixels ? imgH : 1000;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  const b = { fx1: clamp01(x1 / sx), fy1: clamp01(y1 / sy), fx2: clamp01(x2 / sx), fy2: clamp01(y2 / sy) };
  if (b.fx2 - b.fx1 < 0.002 || b.fy2 - b.fy1 < 0.002) return null;
  return b;
}

function itemsOf(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  for (const k of ['items', 'elements', 'controls', 'inputs', 'results']) if (Array.isArray(parsed[k])) return parsed[k];
  if (parsed.box || parsed.bbox) return [parsed];
  return [];
}

export function parseItems(content, imgW, imgH) {
  const out = [];
  for (const it of itemsOf(salvageJson(content))) {
    if (!it || typeof it !== 'object') continue;
    const b = boxToFraction(it.box || it.bbox || it.bbox_2d, imgW, imgH);
    if (!b) continue;
    const label = String(it.label ?? it.name ?? it.text ?? '').trim().slice(0, 120);
    out.push({ type: normType(it.type), label, ...b, source: 'ai' });
  }
  return dedupe(out);
}

export function parseFind(content, imgW, imgH) {
  const p = salvageJson(content);
  if (!p || p.found === false) return null;
  const it = itemsOf(p)[0] || p;
  const b = boxToFraction(it.box || it.bbox, imgW, imgH);
  return b ? { label: String(it.label || '').slice(0, 120), ...b } : null;
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.fx2, b.fx2) - Math.max(a.fx1, b.fx1));
  const iy = Math.max(0, Math.min(a.fy2, b.fy2) - Math.max(a.fy1, b.fy1));
  const inter = ix * iy;
  const area = r => (r.fx2 - r.fx1) * (r.fy2 - r.fy1);
  return inter / (area(a) + area(b) - inter || 1);
};
export function dedupe(items) {
  const kept = [];
  for (const it of items) if (!kept.some(k => iou(k, it) > 0.7)) kept.push(it);
  return kept;
}

export async function ollamaVision({ host = DEFAULT_HOST, model = DEFAULT_MODEL, prompt, pngBase64, numPredict = 3000, signal, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${host}/api/chat`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, think: false, format: 'json', keep_alive: '10m',
        options: { temperature: 0, num_ctx: 8192, num_predict: numPredict },
        messages: [{ role: 'user', content: prompt, images: [pngBase64] }],
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Could not reach Ollama at ${host}. Is it running? (${e.cause?.code || e.message})`);
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = body; try { msg = JSON.parse(body).error || body; } catch { }
    if (/not found/i.test(msg)) throw new Error(`Ollama does not have the model "${model}". Run: ollama pull ${model}`);
    throw new Error(`Ollama error ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  const j = JSON.parse(body);
  return { content: j.message?.content || '', evalCount: j.eval_count, doneReason: j.done_reason };
}

export async function ollamaModels({ host = DEFAULT_HOST, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  return (j.models || []).map(m => ({ name: m.name, vision: (m.capabilities || []).includes('vision') }));
}

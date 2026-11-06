export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const uid = () => crypto.randomUUID();
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

export function safeUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return ['http:', 'https:', 'mailto:'].includes(x.protocol) ? x.href : '';
  } catch {
    return '';
  }
}

let toastTimer;
export function toast(message, { action, onAction, ms = 4500 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.classList.add('show');
  const btn = el.querySelector('button');
  if (btn) {
    btn.onclick = () => {
      el.classList.remove('show');
      onAction?.();
    };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

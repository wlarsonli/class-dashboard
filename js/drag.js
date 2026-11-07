// Drag and drop on the Plan tab.
//   Day timeline: drag a work block or one of your events up or down to change its time (in
//   15-minute steps), or drag its bottom edge to change how long it is.
//   Week view: drag a day's work onto another day.
// With a mouse, a drag starts as soon as you move. On a touch screen you press and hold first,
// so ordinary swipes still scroll the page. The bottom edge drags right away.

const HOLD = 260; // ms to hold before a touch drag starts
const SLOP = 9; // px a finger can wobble while holding
const STEP = 15; // minutes per snap
const EDGE = 72; // px from the top or bottom of the screen where the page scrolls

let handlers = {};
let s = null; // the drag in progress
let quietUntil = 0; // clicks right after a drag are ignored

export const isDragging = () => !!s?.active;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * handlers:
 *   day({ kind, el, date, from: [s, e], to: [s, e], resized })  a timeline item was dropped
 *   week({ id, from, to })                                      a work session was dropped on a day
 *   locked(kind)                                                 tried to drag a class, Outlook event, or exam
 *   label(date, s, e)                                            time text shown while dragging
 *   done()                                                       a drag ended or was cancelled
 */
export function initDrag(h) {
  handlers = h;
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0) begin(e, e.clientX, e.clientY, 'mouse');
  });
  window.addEventListener('mousemove', (e) => {
    if (!s || s.type !== 'mouse') return;
    if (!s.active) {
      if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < 5) return;
      activate();
    }
    move(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', (e) => {
    if (s?.type === 'mouse') finish(e);
  });

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) begin(e, e.touches[0].clientX, e.touches[0].clientY, 'touch');
      else cancel();
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!s || s.type !== 'touch') return;
      const t = e.touches[0];
      if (!s.active) {
        if (Math.hypot(t.clientX - s.x0, t.clientY - s.y0) <= SLOP) return;
        if (!s.grip) return cancel(); // moved before the hold: it's a scroll
        activate();
      }
      if (e.cancelable) e.preventDefault(); // keep the page still while dragging
      move(t.clientX, t.clientY);
    },
    { passive: false },
  );
  document.addEventListener('touchend', (e) => finish(e), { passive: false });
  document.addEventListener('touchcancel', () => cancel());
  window.addEventListener('blur', () => cancel());

  // A drag isn't a tap: swallow the click that follows it.
  document.addEventListener(
    'click',
    (e) => {
      if (Date.now() < quietUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  // No "copy / look up" menu while holding a block.
  document.addEventListener('contextmenu', (e) => {
    if (s || (e.target instanceof Element && e.target.closest('[data-drag]'))) e.preventDefault();
  });
}

function begin(e, x, y, type) {
  if (s) cancel();
  const target = e.target instanceof Element ? e.target : null;
  const el = target?.closest('[data-drag], [data-locked]');
  if (!el || el.closest('dialog')) return;
  const grip = !!target.closest('[data-grip]');
  s = {
    el, type, grip, x0: x, y0: y, x, y, sy0: window.scrollY, active: false, timer: 0,
    mode: !el.dataset.drag ? 'locked' : el.dataset.drag === 'session' ? 'week' : 'day',
  };
  if (type === 'touch' && !grip) s.timer = setTimeout(activate, HOLD);
  if (type === 'mouse' && el.dataset.drag) e.preventDefault(); // no text selection while dragging
}

function activate() {
  if (!s || s.active) return;
  clearTimeout(s.timer);
  if (s.mode === 'locked') {
    const kind = s.el.dataset.locked;
    s = null;
    quietUntil = Date.now() + 600;
    handlers.locked?.(kind);
    return;
  }
  s.active = true;
  document.body.classList.add('dragging');
  s.el.classList.add('is-dragging');
  if (s.mode === 'day') {
    const lanes = s.el.closest('.tl-lanes');
    Object.assign(s, {
      lo: +lanes.dataset.lo, hi: +lanes.dataset.hi, px: +lanes.dataset.px, date: lanes.dataset.date,
      s0: +s.el.dataset.s, e0: +s.el.dataset.e, top0: s.el.style.top, h0: s.el.style.height,
      label: s.el.querySelector('.tl-time'),
    });
    s.text0 = s.label?.textContent;
    s.ns = s.s0;
    s.ne = s.e0;
  } else {
    const r = s.el.getBoundingClientRect();
    s.ghost = s.el.cloneNode(true);
    s.ghost.classList.add('drag-ghost');
    s.ghost.removeAttribute('data-drag');
    Object.assign(s.ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
    document.body.append(s.ghost);
    s.dx = s.x0 - r.left;
    s.dy = s.y0 - r.top;
    s.from = s.el.dataset.date;
  }
  navigator.vibrate?.(8);
  s.raf = requestAnimationFrame(tick);
  move(s.x, s.y);
}

function move(x, y) {
  if (!s?.active) return;
  s.x = x;
  s.y = y;
  if (s.mode === 'day') {
    const dm = (y + window.scrollY - (s.y0 + s.sy0)) / s.px; // minutes moved
    if (s.grip) {
      s.ns = s.s0;
      s.ne = clamp(Math.round((s.e0 + dm) / STEP) * STEP, s.s0 + STEP, s.hi);
      s.el.style.height = `${Math.max(22, (s.ne - s.ns) * s.px - 3)}px`;
    } else {
      const len = s.e0 - s.s0;
      s.ns = clamp(Math.round((s.s0 + dm) / STEP) * STEP, s.lo, s.hi - len);
      s.ne = s.ns + len;
      s.el.style.top = `${(s.ns - s.lo) * s.px}px`;
    }
    if (s.label) s.label.textContent = handlers.label?.(s.date, s.ns, s.ne) ?? '';
  } else {
    s.ghost.style.left = `${x - s.dx}px`;
    s.ghost.style.top = `${y - s.dy}px`;
    const zone = document.elementFromPoint(x, y)?.closest('[data-drop]') || null;
    if (zone !== s.zone) {
      s.zone?.classList.remove('drop-hover');
      zone?.classList.add('drop-hover');
      s.zone = zone;
    }
  }
}

/** Scrolls the page while you hold something near the top or bottom of the screen. */
function tick() {
  if (!s?.active) return;
  const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h')) || 0;
  const bottom = window.innerHeight - bar - EDGE;
  let v = 0;
  if (s.y < EDGE) v = -Math.ceil((EDGE - s.y) / 5);
  else if (s.y > bottom) v = Math.ceil((s.y - bottom) / 5);
  if (v) {
    window.scrollBy(0, v);
    move(s.x, s.y);
  }
  s.raf = requestAnimationFrame(tick);
}

function tidy(d) {
  cancelAnimationFrame(d.raf);
  document.body.classList.remove('dragging');
  d.el.classList.remove('is-dragging');
  d.ghost?.remove();
  d.zone?.classList.remove('drop-hover');
}

async function finish(e) {
  if (!s) return;
  clearTimeout(s.timer);
  const d = s;
  s = null;
  if (!d.active) return; // a tap: the click goes through as usual
  if (e?.cancelable) e.preventDefault();
  quietUntil = Date.now() + 450;
  tidy(d);
  try {
    if (d.mode === 'day') {
      if (d.ns !== d.s0 || d.ne !== d.e0) {
        await handlers.day?.({ kind: d.el.dataset.drag, el: d.el, date: d.date, from: [d.s0, d.e0], to: [d.ns, d.ne], resized: d.grip });
        return;
      }
    } else {
      const to = d.zone?.dataset.drop;
      if (to && to !== d.from) {
        await handlers.week?.({ id: d.el.dataset.id, from: d.from, to });
        return;
      }
    }
  } finally {
    handlers.done?.();
  }
}

function cancel() {
  if (!s) return;
  clearTimeout(s.timer);
  const d = s;
  s = null;
  if (!d.active) return;
  if (d.mode === 'day') {
    d.el.style.top = d.top0;
    d.el.style.height = d.h0;
    if (d.label) d.label.textContent = d.text0;
  }
  tidy(d);
  handlers.done?.();
}

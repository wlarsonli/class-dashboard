// Starts the app: sign-in, routing between screens, and all the click/submit handling.
import { describe, EXAMPLES, interpret } from './command.js';
import { addDays, fmtRange, startOfDay, weekStart, ymd } from './dates.js';
import { initDrag, isDragging } from './drag.js';
import { openBlockMenu, openCourseEditor, openEventMenu, openSessionMenu, openTaskEditor } from './editor.js';
import { hm } from './planner.js';
import { enablePush, registerSW } from './push.js';
import { parseQuickAdd } from './quickadd.js';
import {
  applyCommand, clearAsk, courseById, dragBlock, dragSession, exportData, importData, moveEventDay, moveTaskEvent, onRender, quickAdd, refresh,
  replan, rerender, resizeBlock, saveIntegrations, saveSettings, state, store, syncIfStale, taskById, toggleDone,
} from './state.js';
import { $, $$, esc, toast } from './util.js';
import { renderClasses } from './views/classes.js';
import { renderDay } from './views/day.js';
import { renderSettings } from './views/settings.js';
import { renderTasks } from './views/tasks.js';
import { renderToday } from './views/today.js';
import { renderWeek } from './views/week.js';

const VIEWS = { today: renderToday, day: renderDay, week: renderWeek, classes: renderClasses, tasks: renderTasks, settings: renderSettings };
const TITLES = { today: 'Today', day: 'Day plan', week: 'Week plan', classes: 'Classes', tasks: 'Tasks', settings: 'Settings' };
const NAV_OF = { day: 'plan', week: 'plan' };
const main = document.getElementById('view');
const modal = document.getElementById('modal');
const drafts = { 'quick-input': '', 'ask-input': '' };
let pendingRender = false;

const viewFromHash = () => {
  const v = location.hash.slice(1);
  return VIEWS[v] ? v : 'today';
};

function applyTheme() {
  const pref = state.settings.theme || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#1d1a26' : '#fbf7f3');
}

// While you're typing in a settings field, background refreshes wait instead of redrawing the page.
function isEditing() {
  const a = document.activeElement;
  return !!(a && main.contains(a) && a.matches('input, textarea, select') && !['quick-input', 'ask-input', 'task-search'].includes(a.id));
}

/** The day a typed change is about when it doesn't name one: the day (or week) you're looking at. */
function viewedDate() {
  const today = startOfDay(new Date());
  if (state.view === 'day') return ymd(addDays(today, state.dayOffset));
  if (state.view === 'week' && state.weekOffset > 0) return ymd(addDays(weekStart(today), state.weekOffset * 7));
  return ymd(today);
}

/** Live preview under the box: what pressing Enter will do. */
function updatePreview(input) {
  const out = document.getElementById(`${input.id === 'quick-input' ? 'quick' : 'ask'}-preview`);
  if (!out) return;
  const text = input.value.trim();
  if (!text) {
    out.innerHTML = '';
    return;
  }
  const cmd = interpret(text, { state, date: viewedDate() });
  if (cmd?.kind === 'error') {
    out.innerHTML = `<span class="qp-note">${esc(cmd.message)}</span>`;
    return;
  }
  if (cmd?.kind === 'task' && input.id === 'ask-input' && !parseQuickAdd(text, state.courses).due_at) {
    out.innerHTML = '<span class="qp-note">Add a time, like “basketball 5-7pm”, or a day for a new task.</span>';
    return;
  }
  const [head, ...bits] = describe(cmd, text, state);
  out.innerHTML = `<span class="qp-title${cmd?.kind === 'task' ? '' : ' plan'}">${esc(head || '')}</span>${bits.map((b) => `<span class="qp-bit">${esc(b)}</span>`).join('')}`;
}

/** Enter in either box: a plan change goes to the planner, anything else becomes a task. */
async function submitText(text, { box }) {
  const cmd = interpret(text, { state, date: viewedDate() });
  if (!cmd) return;
  if (cmd.kind === 'error') {
    state.ask = { ok: false, text, title: cmd.message, examples: /couldn't|Which|What time/.test(cmd.message) ? EXAMPLES.slice(0, 6) : null };
    rerender();
    return false;
  }
  if (cmd.kind === 'task') {
    if (box === 'ask' && !parseQuickAdd(text, state.courses).due_at) {
      state.ask = { ok: false, text, title: "I couldn't tell what to change.", examples: EXAMPLES };
      rerender();
      return false;
    }
    state.ask = null;
    const t = await quickAdd(text);
    if (t) toast(`Added: ${t.title}`, { action: 'Edit', onAction: () => openTaskEditor(taskById(t.id)) });
    return true;
  }
  await applyCommand(cmd, text);
  return true;
}

function render() {
  applyTheme();
  if (!state.ready) return;
  if ((state.background && isEditing()) || isDragging()) {
    pendingRender = true; // wait until you're done typing or dragging
    return;
  }
  const view = viewFromHash();
  const changed = view !== state.view;
  // Opening the Plan tab shows today, unless you tapped a specific day in the week view.
  if (changed && view === 'day' && state.view !== 'week') state.dayOffset = 0;
  state.view = view;
  const active = document.activeElement;
  const focusId = active && main.contains(active) ? active.id : '';
  const sel = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = window.scrollY;

  main.innerHTML = VIEWS[view]();

  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === (NAV_OF[view] || view);
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[view]} · Class Dashboard`;
  const banner = $('#banner');
  banner.hidden = !state.offline;
  banner.textContent = state.offline ? "You're offline. This is your last saved copy, and changes won't save until you reconnect." : '';

  for (const [id, text] of Object.entries(drafts)) {
    const el = document.getElementById(id);
    if (el && text) {
      el.value = text;
      updatePreview(el);
    }
  }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (sel && el.setSelectionRange) {
        try {
          el.setSelectionRange(...sel);
        } catch {
          /* not a text field */
        }
      }
    }
  }
  window.scrollTo(0, changed ? 0 : scroll);
}

async function backgroundRefresh() {
  state.background = true;
  try {
    await refresh({ silent: true });
  } finally {
    state.background = false;
  }
}

function renderSignIn(mode = 'in', error = '') {
  document.body.classList.add('signed-out');
  main.innerHTML = `<div class="signin card">
    <img src="icons/icon.svg" alt="" width="56" height="56">
    <h1>${mode === 'in' ? 'Sign in' : 'Create your account'}</h1>
    <p class="hint">${mode === 'in' ? 'Use the email and password you set up for your dashboard.' : 'You only do this once. New sign-ups get turned off afterwards.'}</p>
    <form class="stack-sm" id="signin-form">
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" minlength="8" required></label>
      ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
      <button class="btn btn-primary" type="submit">${mode === 'in' ? 'Sign in' : 'Create account'}</button>
    </form>
    <button class="btn ghost small" type="button" id="signin-toggle">${mode === 'in' ? 'First time here? Create your account' : 'Already have an account? Sign in'}</button>
  </div>`;
  $('#signin-toggle').onclick = () => renderSignIn(mode === 'in' ? 'up' : 'in');
  $('#signin-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (mode === 'in') await store.signIn(fd.get('email').trim(), fd.get('password'));
      else await store.signUp(fd.get('email').trim(), fd.get('password'));
      document.body.classList.remove('signed-out');
      await refresh();
    } catch (err) {
      renderSignIn(mode, err.message || String(err));
    }
  };
}

async function readImport(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let json;
  try {
    json = JSON.parse(await file.text());
  } catch {
    toast("That file isn't valid JSON.");
    return;
  }
  if (state.tasks.length && !confirm('Importing replaces everything currently in the dashboard. Continue?')) return;
  try {
    await importData(json);
  } catch (err) {
    toast(err.message || String(err));
  }
}

const ACTIONS = {
  toggle: (el) => toggleDone(el.dataset.id),
  open: (el) => openTaskEditor(taskById(el.dataset.id)),
  'new-task': (el) => openTaskEditor(null, { course: el.dataset.course || null }),
  session: (el) => openSessionMenu(el.dataset.id, el.dataset.date),
  block: (el) => openBlockMenu(el.dataset.id, el.dataset.date, el.dataset.start),
  event: (el) => openEventMenu(el.dataset.ev, el.dataset.date),
  'ask-undo': () => applyCommand({ kind: 'undo' }),
  'ask-dismiss': () => clearAsk(),
  'ask-example': (el) => {
    const input = $('#ask-input') || $('#quick-input');
    if (!input) return;
    input.value = el.dataset.text;
    drafts[input.id] = input.value;
    updatePreview(input);
    input.focus();
  },
  'clear-limit': (el) => applyCommand({ kind: 'limit', dates: [el.dataset.date], minutes: null, chips: ['Plan work as usual', 'this day'] }),
  'day-prev': () => {
    state.dayOffset -= 1;
    rerender();
  },
  'day-next': () => {
    state.dayOffset += 1;
    rerender();
  },
  'day-today': () => {
    state.dayOffset = 0;
    rerender();
  },
  'open-day': (el) => {
    state.dayOffset = parseInt(el.dataset.offset, 10) || 0;
    if (location.hash === '#day') rerender();
    else location.hash = '#day';
  },
  'week-prev': () => {
    state.weekOffset -= 1;
    rerender();
  },
  'week-next': () => {
    state.weekOffset += 1;
    rerender();
  },
  'week-today': () => {
    state.weekOffset = 0;
    rerender();
  },
  replan: () => replan(),
  'edit-course': (el) => openCourseEditor(courseById(el.dataset.id)),
  'new-course': (el) => openCourseEditor(null, { kind: el.dataset.kind || 'class' }),
  status: (el) => {
    state.filter.status = el.dataset.value;
    rerender();
  },
  export: () => exportData(),
  copy: async (el) => {
    await navigator.clipboard.writeText(el.dataset.copy);
    toast('Copied.');
  },
  'enable-push': async () => {
    await enablePush(store);
    toast('Notifications are on for this device.');
    rerender();
  },
  'test-push': async () => {
    await store.invoke('notify', { test: true });
    toast('Test sent. It should show up in a few seconds.');
  },
  'sync-now': async () => {
    toast('Checking Canvas and Outlook…');
    const r = await store.invoke('sync', {});
    await refresh();
    toast(r?.summary || 'Synced.');
  },
  'sign-out': async () => {
    await store.signOut();
    location.reload();
  },
  'erase-local': () => {
    if (!confirm("Erase everything saved in this browser? This can't be undone.")) return;
    localStorage.clear();
    location.reload();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('dialog')) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  try {
    await fn(el);
  } catch (err) {
    console.error(err);
    toast(err.message || String(err));
  }
});

const FORMS = {
  async quick(fd) {
    const text = String(fd.get('text') || '').trim();
    if (!text) return;
    drafts['quick-input'] = '';
    if ((await submitText(text, { box: 'quick' })) === false) drafts['quick-input'] = text;
    rerender();
  },
  async ask(fd) {
    const text = String(fd.get('text') || '').trim();
    if (!text) return;
    drafts['ask-input'] = '';
    if ((await submitText(text, { box: 'ask' })) === false) drafts['ask-input'] = text;
    rerender();
  },
  async alerts(fd) {
    await saveSettings({
      alerts: { rundown: fd.has('rundown'), nudges: fd.has('nudges') },
      rundown_time: fd.get('rundown_time'),
      nudge_time: fd.get('nudge_time'),
      quiet_during_classes: fd.has('quiet'),
    });
    toast('Alert times saved.');
  },
  async planning(fd) {
    const m = (k) => Math.max(0, Math.round(parseFloat(fd.get(k) || '0') * 60));
    const prep = (k) => ({ daily: m(`prep_${k}_daily`), days: Math.max(1, parseInt(fd.get(`prep_${k}_days`), 10) || 1) });
    const start = fd.get('win_start') || '08:00';
    const weekend = fd.get('win_weekend') || start;
    const end = fd.get('win_end') || '23:00';
    if (end <= start || end <= weekend) {
      toast('The end of your work hours has to be after the start.');
      return;
    }
    await saveSettings({
      capacity: { weekday: m('cap_weekday'), weekend: m('cap_weekend') },
      workload: { ...state.settings.workload, deadlines: parseInt(fd.get('wl_deadlines'), 10) || 3 },
      study_window: { start, end, weekend_start: weekend },
      exam_prep: { final: prep('final'), midterm: prep('midterm'), quiz: prep('quiz') },
      default_estimates: {
        ...state.settings.default_estimates,
        assignment: m('est_assignment'),
        essay: m('est_essay'),
        reading: m('est_reading'),
        task: m('est_task'),
      },
    });
    toast('Planning settings saved. Your plan was updated.');
  },
  async term(fd) {
    const breaks = [];
    for (let i = 0; fd.has(`break_label_${i}`); i++) {
      const start = fd.get(`break_start_${i}`);
      const end = fd.get(`break_end_${i}`) || start;
      if (start) breaks.push({ label: String(fd.get(`break_label_${i}`)).trim() || 'Break', start, end: end < start ? start : end });
    }
    const nextStart = fd.get('next_start');
    await saveSettings({
      term: {
        name: String(fd.get('name')).trim(),
        start: fd.get('start'),
        classes_end: fd.get('classes_end'),
        end: fd.get('end'),
        finals_start: fd.get('finals_start'),
        finals_end: fd.get('finals_end'),
        breaks,
        next_term: nextStart ? { label: String(fd.get('next_label')).trim() || 'Next term', start: nextStart } : null,
      },
    });
    toast('Term dates saved.');
  },
  async connections(fd) {
    await saveIntegrations({
      canvas_feed_url: String(fd.get('canvas_feed_url') || '').trim(),
      outlook_feed_url: String(fd.get('outlook_feed_url') || '').trim(),
    });
    toast('Links saved.');
  },
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || form.closest('dialog')) return;
  e.preventDefault();
  try {
    await FORMS[form.dataset.form]?.(new FormData(form));
  } catch (err) {
    console.error(err);
    toast(err.message || String(err));
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'quick-input' || t.id === 'ask-input') {
    drafts[t.id] = t.value;
    updatePreview(t);
  } else if (t.dataset?.filter === 'q') {
    state.filter.q = t.value;
    rerender();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.closest('dialog')) return;
  try {
    if (t.matches('[data-import]')) await readImport(t);
    else if (t.dataset?.filter && t.dataset.filter !== 'q') {
      state.filter[t.dataset.filter] = t.value;
      rerender();
    } else if (t.dataset?.setting === 'theme') await saveSettings({ theme: t.value });
  } catch (err) {
    toast(err.message || String(err));
  }
});

// Drag and drop on the Plan tab (see drag.js).
const LOCKED = {
  outlook: 'This comes from Outlook. Move it there, and your plan catches up within 15 minutes.',
  class: 'Classes come from your schedule. If one is cancelled, tell the planner, like “no math class tuesday”.',
  exam: "Exam times come from your class. Tap the exam if its date changed.",
};
initDrag({
  label: (date, s, e) => fmtRange(new Date(`${date}T${hm(s)}`), new Date(`${date}T${hm(Math.min(e, 1439))}`)),
  locked: (kind) => toast(LOCKED[kind] || "This one can't be moved here."),
  async day({ kind, el, date, to, resized }) {
    try {
      if (kind === 'block') {
        if (resized) await resizeBlock(el.dataset.id, date, el.dataset.start, to[1] - to[0]);
        else await dragBlock(el.dataset.id, date, el.dataset.start, hm(to[0]));
      } else if (kind === 'mine') await moveEventDay(el.dataset.ev, date, { start: hm(to[0]), end: hm(Math.min(to[1], 1439)) });
      else if (kind === 'tevent') await moveTaskEvent(el.dataset.id, date, hm(to[0]), to[1] - to[0]);
    } catch (err) {
      console.error(err);
      toast(err.message || String(err));
    }
    rerender(); // in case nothing changed, put the block back where it was
  },
  async week({ id, from, to }) {
    try {
      await dragSession(id, from, to);
    } catch (err) {
      console.error(err);
      toast(err.message || String(err));
    }
  },
  done: () => {
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  },
});

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || modal.open || e.target.closest('input, textarea, select, [contenteditable]')) return;
  const qi = $('#quick-input');
  if (qi) {
    e.preventDefault();
    qi.focus();
  }
});

modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});
modal.addEventListener('close', () => {
  modal.innerHTML = '';
});
main.addEventListener('focusout', () =>
  setTimeout(() => {
    if (pendingRender && !isEditing()) {
      pendingRender = false;
      render();
    }
  }, 0),
);

async function start() {
  onRender(render);
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  registerSW();
  window.addEventListener('hashchange', render);
  let signedIn = false;
  try {
    ({ signedIn } = await store.init());
  } catch (err) {
    console.error(err);
    main.innerHTML = `<section class="card"><p>The dashboard couldn't start: ${esc(err.message || err)}</p></section>`;
    return;
  }
  if (!signedIn) return renderSignIn();
  await refresh();
  syncIfStale(); // pick up anything new in Outlook or Canvas, then re-plan around it
  setInterval(() => document.visibilityState === 'visible' && backgroundRefresh(), 120000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    backgroundRefresh();
    syncIfStale();
  });
}

start();

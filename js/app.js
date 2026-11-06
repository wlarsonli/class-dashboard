// Starts the app: sign-in, routing between screens, and all the click/submit handling.
import { openCourseEditor, openSessionMenu, openTaskEditor } from './editor.js';
import { enablePush, registerSW } from './push.js';
import { describeQuickAdd, parseQuickAdd } from './quickadd.js';
import {
  courseById, exportData, importData, moveSession, onRender, quickAdd, refresh, replan, rerender, saveIntegrations, saveSettings,
  state, store, taskById, toggleDone,
} from './state.js';
import { $, $$, esc, toast } from './util.js';
import { renderClasses } from './views/classes.js';
import { renderSettings } from './views/settings.js';
import { renderTasks } from './views/tasks.js';
import { renderToday } from './views/today.js';
import { renderWeek } from './views/week.js';

const VIEWS = { today: renderToday, week: renderWeek, classes: renderClasses, tasks: renderTasks, settings: renderSettings };
const TITLES = { today: 'Today', week: 'Week', classes: 'Classes', tasks: 'Tasks', settings: 'Settings' };
const main = document.getElementById('view');
const modal = document.getElementById('modal');
let quickDraft = '';
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
  return !!(a && main.contains(a) && a.matches('input, textarea, select') && !['quick-input', 'task-search'].includes(a.id));
}

function updateQuickPreview(input) {
  const out = $('#quick-preview');
  if (!out) return;
  const text = input.value.trim();
  if (!text) {
    out.innerHTML = '';
    return;
  }
  const p = parseQuickAdd(text, state.courses);
  out.innerHTML = `<span class="qp-title">${esc(p.title || 'New task')}</span>${describeQuickAdd(p)
    .map((b) => `<span class="qp-bit">${esc(b)}</span>`)
    .join('')}`;
}

function render() {
  applyTheme();
  if (!state.ready) return;
  if (state.background && isEditing()) {
    pendingRender = true;
    return;
  }
  const view = viewFromHash();
  const changed = view !== state.view;
  state.view = view;
  const active = document.activeElement;
  const focusId = active && main.contains(active) ? active.id : '';
  const sel = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = window.scrollY;

  main.innerHTML = VIEWS[view]();

  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === view;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[view]} · Class Dashboard`;
  const banner = $('#banner');
  banner.hidden = !state.offline;
  banner.textContent = state.offline ? "You're offline. This is your last saved copy, and changes won't save until you reconnect." : '';

  const qi = $('#quick-input');
  if (qi && quickDraft) {
    qi.value = quickDraft;
    updateQuickPreview(qi);
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
    quickDraft = '';
    const t = await quickAdd(text);
    if (t) toast(`Added: ${t.title}`, { action: 'Edit', onAction: () => openTaskEditor(taskById(t.id)) });
    $('#quick-input')?.focus();
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
    await saveSettings({
      capacity: { weekday: m('cap_weekday'), weekend: m('cap_weekend') },
      workload: { ...state.settings.workload, deadlines: parseInt(fd.get('wl_deadlines'), 10) || 3 },
      default_estimates: {
        ...state.settings.default_estimates,
        assignment: m('est_assignment'),
        essay: m('est_essay'),
        reading: m('est_reading'),
        exam: m('est_exam'),
        task: m('est_task'),
      },
    });
    toast('Planning settings saved.');
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
  if (t.id === 'quick-input') {
    quickDraft = t.value;
    updateQuickPreview(t);
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

// Drag a work session to another day (desktop). On phones, tapping it opens a menu instead.
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('[data-drag]');
  if (!el) return;
  e.dataTransfer.setData('text/plain', JSON.stringify({ id: el.dataset.id, date: el.dataset.date }));
  e.dataTransfer.effectAllowed = 'move';
  el.classList.add('dragging');
});
document.addEventListener('dragend', (e) => e.target.closest?.('[data-drag]')?.classList.remove('dragging'));
document.addEventListener('dragover', (e) => {
  const zone = e.target.closest?.('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  $$('.drop-hover').forEach((z) => z !== zone && z.classList.remove('drop-hover'));
  zone.classList.add('drop-hover');
});
document.addEventListener('dragleave', (e) => {
  const zone = e.target.closest?.('[data-drop]');
  if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-hover');
});
document.addEventListener('drop', async (e) => {
  const zone = e.target.closest?.('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('drop-hover');
  try {
    const d = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
    if (d.id) await moveSession(d.id, d.date, zone.dataset.drop);
  } catch {
    /* not one of ours */
  }
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
  setInterval(() => document.visibilityState === 'visible' && backgroundRefresh(), 120000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && backgroundRefresh());
}

start();

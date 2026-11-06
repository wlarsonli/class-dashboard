// Pop-up editors: tasks, classes, and the "move this work session" menu.
import { TYPE_LABEL } from './components.js';
import { addDays, atTime, DOW, fmtDate, fmtMinutes, hhmm, parseYmd, relDay, ymd } from './dates.js';
import { estimateOf, planTasks } from './planner.js';
import {
  createSeries, deleteCourse, deleteTask, moveSession, newTask, saveCourse, saveSeriesFrom, saveTask, state, taskById, toggleDone,
} from './state.js';
import { clone, esc, uid } from './util.js';

export const PALETTE = ['#C9B8F0', '#A8DCC8', '#F6C3A5', '#A9CCEB', '#F2B8C6', '#F3DF9A', '#C5D9A8', '#D4CDE3', '#F4B3A2', '#A6DDDF'];
const MINUTES = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LETTER = { 0: 'Su', 1: 'M', 2: 'T', 3: 'W', 4: 'Th', 5: 'F', 6: 'Sa' };

const dialog = () => document.getElementById('modal');

function open(html, wire) {
  const d = dialog();
  d.innerHTML = html;
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  wire(d);
  if (!d.open) d.showModal();
  (d.querySelector('[autofocus]') || d.querySelector('input, select, textarea'))?.focus();
}

const dayChecks = (selected = []) =>
  `<div class="day-checks">${DAY_ORDER.map(
    (d) => `<label><input type="checkbox" value="${d}"${selected.includes(d) ? ' checked' : ''} aria-label="${DOW[d]}"><span>${DAY_LETTER[d]}</span></label>`,
  ).join('')}</div>`;
const readDays = (el) => [...el.querySelectorAll('.day-checks input:checked')].map((x) => +x.value);

const removeBtn = (what) => `<button type="button" class="btn icon small" data-remove-row aria-label="Remove ${what}">×</button>`;

function sessionRow(s) {
  const opts = [...new Set([...MINUTES, s.minutes])].sort((a, b) => a - b);
  return `<div class="plan-row" data-pinned="${s.pinned ? 'true' : 'false'}">
    <input type="date" value="${esc(s.date)}" aria-label="Day">
    <select aria-label="How long">${opts.map((m) => `<option value="${m}"${m === s.minutes ? ' selected' : ''}>${esc(fmtMinutes(m))}</option>`).join('')}</select>
    <span class="plan-flag">${s.pinned ? 'set by you' : 'suggested'}</span>
    ${removeBtn('session')}
  </div>`;
}

const subRow = (s) => `<li class="sub-row" data-id="${esc(s.id)}">
  <input type="checkbox"${s.done ? ' checked' : ''} aria-label="Done">
  <input type="text" value="${esc(s.title)}" aria-label="Step">
  ${removeBtn('step')}
</li>`;

const linkRow = (l = {}) => `<div class="link-row">
  <input type="text" placeholder="Label" value="${esc(l.label || '')}" aria-label="Link label">
  <input type="url" placeholder="https://" value="${esc(l.url || '')}" aria-label="Link address" spellcheck="false">
  ${removeBtn('link')}
</div>`;

function courseOptions(selected) {
  return `<option value="">None</option>${state.courses
    .filter((c) => !c.archived || c.id === selected)
    .map((c) => `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${esc(c.short || c.name)}${c.kind !== 'category' && c.name ? ` · ${esc(c.name)}` : ''}</option>`)
    .join('')}`;
}

function showError(form, msg) {
  const p = form.querySelector('.form-error');
  p.textContent = msg;
  p.hidden = false;
  p.scrollIntoView({ block: 'nearest' });
}

function readPlan(form) {
  const out = [];
  for (const r of form.querySelectorAll('.plan-row')) {
    const date = r.querySelector('input[type=date]').value;
    if (!date) continue;
    const minutes = +r.querySelector('select').value;
    const pinned = r.dataset.pinned === 'true';
    const same = out.find((s) => s.date === date);
    if (same) {
      same.minutes += minutes;
      same.pinned = same.pinned || pinned;
    } else out.push({ date, minutes, pinned });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function collectTask(form, t, { validate }) {
  const el = form.elements;
  const title = el.title.value.trim();
  if (validate && !title) {
    showError(form, 'Give the task a title.');
    el.title.focus();
    return null;
  }
  const due_at = !el.no_due.checked && el.due_date.value ? atTime(el.due_date.value, el.due_time.value || '23:59').toISOString() : null;
  if (validate && el.repeat_on?.checked) {
    if (!due_at) return showError(form, 'A repeating task needs a first due date.'), null;
    if (!form.querySelector('.repeat-opts .day-checks input:checked')) return showError(form, 'Pick at least one day for it to repeat on.'), null;
    if (!el.repeat_until.value || el.repeat_until.value < el.due_date.value) return showError(form, 'The end date has to be after the first due date.'), null;
  }
  const type = el.type.value;
  const timed = type === 'exam' || type === 'event';
  const today = ymd(new Date());
  return {
    ...t,
    title,
    course_id: el.course_id.value || null,
    type,
    due_at,
    duration_minutes: timed && el.duration_minutes.value ? +el.duration_minutes.value : timed ? null : t.duration_minutes ?? null,
    location: timed ? el.location.value.trim() : t.location || '',
    estimate_minutes: el.estimate_hours.value === '' ? null : Math.round(parseFloat(el.estimate_hours.value) * 60),
    priority: +(form.querySelector('[name=priority]:checked')?.value || 0),
    notes: el.notes.value,
    subtasks: [...form.querySelectorAll('.sub-row')]
      .map((li) => ({ id: li.dataset.id || uid(), title: li.querySelector('input[type=text]').value.trim(), done: li.querySelector('input[type=checkbox]').checked }))
      .filter((s) => s.title),
    links: [...form.querySelectorAll('.link-row')]
      .map((r) => {
        const [label, url] = r.querySelectorAll('input');
        return { label: label.value.trim(), url: url.value.trim() };
      })
      .filter((l) => l.url),
    plan: [...(t.plan || []).filter((s) => s.date < today), ...readPlan(form)],
    estimated_date: !!t.estimated_date && t.due_at === due_at,
  };
}

export function openTaskEditor(task, prefill = {}) {
  const isNew = !task;
  const t = isNew
    ? newTask({ type: prefill.course ? 'assignment' : 'task', course_id: prefill.course || null, due_at: prefill.due_at || null })
    : clone(task);
  const due = t.due_at ? new Date(t.due_at) : null;
  const series = !isNew && !!t.series_id;
  const termEnd = state.settings.term?.classes_end || state.settings.term?.end || ymd(addDays(new Date(), 56));
  const defaultEst = estimateOf({ ...t, estimate_minutes: null }, state.settings);
  const today = ymd(new Date());
  const futurePlan = (t.plan || []).filter((s) => s.date >= today);
  const timed = t.type === 'exam' || t.type === 'event';
  const types = Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}"${t.type === k ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const prio = [0, 1, 2, 3]
    .map((p) => `<label><input type="radio" name="priority" value="${p}"${(t.priority || 0) === p ? ' checked' : ''}><span>${['None', 'Low', 'Med', 'High'][p]}</span></label>`)
    .join('');
  const hours = (m) => Math.round((m / 60) * 100) / 100;

  const html = `<form class="sheet-form" novalidate>
    <header class="sheet-head"><h2>${isNew ? 'New task' : 'Edit task'}</h2><button type="button" class="btn icon" data-close aria-label="Close">×</button></header>
    <div class="sheet-body">
      <label class="field"><span>Title</span><input name="title" value="${esc(t.title)}" autofocus></label>
      <div class="grid2">
        <label class="field"><span>Class or category</span><select name="course_id">${courseOptions(t.course_id)}</select></label>
        <label class="field"><span>Type</span><select name="type">${types}</select></label>
      </div>
      <fieldset class="field"><legend>Due</legend>
        <div class="due-row">
          <input type="date" name="due_date" value="${due ? ymd(due) : ''}" aria-label="Due date">
          <input type="time" name="due_time" value="${due ? hhmm(due) : '23:59'}" aria-label="Due time">
          <label class="check-inline"><input type="checkbox" name="no_due"${due ? '' : ' checked'}> No due date</label>
        </div>
      </fieldset>
      <div class="grid2 exam-only"${timed ? '' : ' hidden'}>
        <label class="field"><span>Length (minutes)</span><input type="number" name="duration_minutes" min="0" step="5" value="${t.duration_minutes ?? ''}"></label>
        <label class="field"><span>Location</span><input name="location" value="${esc(t.location || '')}"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Time needed (hours)</span><input type="number" name="estimate_hours" min="0" max="60" step="0.25" value="${t.estimate_minutes === null || t.estimate_minutes === undefined ? '' : hours(t.estimate_minutes)}" placeholder="${hours(defaultEst)} (default)"></label>
        <fieldset class="field"><legend>Priority</legend><div class="seg radios">${prio}</div></fieldset>
      </div>
      <fieldset class="field"><legend>Work sessions</legend>
        <div class="plan-rows">${futurePlan.map(sessionRow).join('') || '<p class="hint plan-empty">Once the task has a due date, the planner picks days for you.</p>'}</div>
        <div class="row-gap"><button type="button" class="btn small" data-add-session>+ Add a session</button><button type="button" class="btn small" data-suggest>Suggest days</button></div>
      </fieldset>
      <fieldset class="field"><legend>Steps</legend>
        <ul class="sub-rows">${(t.subtasks || []).map(subRow).join('')}</ul>
        <input class="sub-new" type="text" placeholder="Add a step and press Enter" aria-label="New step">
      </fieldset>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(t.notes || '')}</textarea></label>
      <fieldset class="field"><legend>Links</legend><div class="link-rows">${(t.links || []).map(linkRow).join('')}</div><button type="button" class="btn small" data-add-link>+ Add a link</button></fieldset>
      ${
        series
          ? '<label class="check-inline series-apply"><input type="checkbox" name="apply_series" checked> Also update the later tasks in this weekly series</label>'
          : `<fieldset class="field"><legend>Repeat</legend>
              <label class="check-inline"><input type="checkbox" name="repeat_on"> Repeat every week</label>
              <div class="repeat-opts" hidden>${dayChecks(due ? [due.getDay()] : [])}<label class="field inline"><span>Until</span><input type="date" name="repeat_until" value="${esc(termEnd)}"></label></div>
            </fieldset>`
      }
      <p class="form-error" role="alert" hidden></p>
    </div>
    <footer class="sheet-foot">
      ${isNew ? '' : '<button type="button" class="btn ghost danger" data-delete>Delete</button>'}
      <span class="spacer"></span>
      ${isNew ? '' : `<button type="button" class="btn" data-toggle-done>${t.status === 'done' ? 'Mark not done' : 'Mark done'}</button>`}
      <button type="submit" class="btn btn-primary">${isNew ? 'Add task' : 'Save'}</button>
    </footer>
  </form>`;

  open(html, (d) => {
    const form = d.querySelector('form');
    const el = form.elements;
    const q = (s) => form.querySelector(s);

    el.type.addEventListener('change', () => {
      q('.exam-only').hidden = !['exam', 'event'].includes(el.type.value);
    });
    const syncDue = () => {
      el.due_date.disabled = el.no_due.checked;
      el.due_time.disabled = el.no_due.checked;
    };
    el.no_due.addEventListener('change', () => {
      if (!el.no_due.checked && !el.due_date.value) el.due_date.value = today;
      syncDue();
    });
    el.due_date.addEventListener('change', () => {
      if (el.due_date.value) el.no_due.checked = false;
      syncDue();
    });
    syncDue();

    el.repeat_on?.addEventListener('change', () => {
      q('.repeat-opts').hidden = !el.repeat_on.checked;
      if (el.repeat_on.checked && el.due_date.value && !q('.repeat-opts .day-checks input:checked')) {
        const box = q(`.repeat-opts .day-checks input[value="${parseYmd(el.due_date.value).getDay()}"]`);
        if (box) box.checked = true;
      }
    });

    form.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove-row]');
      if (rm) rm.parentElement.remove();
    });

    const planRows = q('.plan-rows');
    const clearHint = () => planRows.querySelector('.plan-empty')?.remove();
    q('[data-add-session]').addEventListener('click', () => {
      clearHint();
      planRows.insertAdjacentHTML('beforeend', sessionRow({ date: today, minutes: 60, pinned: true }));
    });
    planRows.addEventListener('change', (e) => {
      const r = e.target.closest('.plan-row');
      if (!r) return;
      r.dataset.pinned = 'true';
      r.querySelector('.plan-flag').textContent = 'set by you';
    });
    q('[data-suggest]').addEventListener('click', () => {
      const draft = collectTask(form, t, { validate: false });
      if (!draft.due_at) return showError(form, 'Add a due date first, then the planner can suggest days.');
      draft.plan = draft.plan.filter((s) => s.date < today || s.pinned);
      const tasks = state.tasks.filter((x) => x.id !== draft.id).concat([draft]);
      const plan = (planTasks({ ...state, tasks }, { mode: 'rebalance', only: draft.id }).get(draft.id) || draft.plan).filter((s) => s.date >= today);
      planRows.innerHTML = plan.map(sessionRow).join('') || '<p class="hint plan-empty">Nothing to plan: this task needs no time, or the due date has passed.</p>';
    });

    const subNew = q('.sub-new');
    subNew.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = subNew.value.trim();
      if (!v) return;
      q('.sub-rows').insertAdjacentHTML('beforeend', subRow({ id: uid(), title: v, done: false }));
      subNew.value = '';
    });
    q('[data-add-link]').addEventListener('click', () => q('.link-rows').insertAdjacentHTML('beforeend', linkRow()));

    q('[data-toggle-done]')?.addEventListener('click', async () => {
      d.close();
      await toggleDone(t.id);
    });
    q('[data-delete]')?.addEventListener('click', () => {
      const foot = q('.sheet-foot');
      foot.innerHTML = `<span class="confirm-text">Delete “${esc(t.title)}”?</span><span class="spacer"></span>
        <button type="button" class="btn" data-cancel>Cancel</button>
        ${series ? '<button type="button" class="btn danger" data-del-series>This and later ones</button>' : ''}
        <button type="button" class="btn danger" data-del-one>${series ? 'Just this one' : 'Delete'}</button>`;
      foot.querySelector('[data-cancel]').onclick = () => openTaskEditor(taskById(t.id));
      foot.querySelector('[data-del-one]').onclick = async () => {
        d.close();
        await deleteTask(t.id);
      };
      foot.querySelector('[data-del-series]')?.addEventListener('click', async () => {
        d.close();
        await deleteTask(t.id, { series: true });
      });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const task = collectTask(form, t, { validate: true });
      if (!task) return;
      const repeat = el.repeat_on?.checked;
      d.close();
      if (repeat) {
        await createSeries(task, { days: readDays(q('.repeat-opts')), until: el.repeat_until.value });
      } else if (series && el.apply_series?.checked) {
        await saveSeriesFrom(task);
      } else {
        await saveTask(task);
      }
    });
  });
}

const shortDay = (d) => {
  const dt = parseYmd(d);
  const r = relDay(dt);
  return r === 'Today' || r === 'Tomorrow' ? r : `${DOW[dt.getDay()]} ${dt.getDate()}`;
};

/** Tap a work session in the week view: move it, remove it, or open the task. */
export function openSessionMenu(taskId, date) {
  const t = taskById(taskId);
  const s = t && (t.plan || []).find((x) => x.date === date);
  if (!s) return;
  const today = ymd(new Date());
  const lastDay = t.due_at && ymd(new Date(t.due_at)) >= today ? ymd(new Date(t.due_at)) : ymd(addDays(new Date(), 6));
  const days = [];
  for (let d = parseYmd(today); ymd(d) <= lastDay && days.length < 14; d = addDays(d, 1)) days.push(ymd(d));
  const future = (t.plan || []).filter((x) => x.date >= today).length;
  open(
    `<div class="sheet-form small">
      <header class="sheet-head"><h2>${esc(t.title)}</h2><button type="button" class="btn icon" data-close aria-label="Close">×</button></header>
      <div class="sheet-body">
        <p>${esc(fmtMinutes(s.minutes))} planned for ${esc(fmtDate(parseYmd(date), { long: true }))}. Move it to:</p>
        <div class="day-pick">${days
          .map((d) => `<button type="button" class="btn${d === date ? ' active' : ''}" data-move="${d}"${d === date ? ' disabled' : ''}>${esc(shortDay(d))}</button>`)
          .join('')}</div>
      </div>
      <footer class="sheet-foot">
        ${future > 1 ? '<button type="button" class="btn ghost danger" data-remove-session>Remove this session</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-open-task>Open task</button>
      </footer>
    </div>`,
    (d) => {
      d.querySelectorAll('[data-move]').forEach((b) =>
        b.addEventListener('click', async () => {
          d.close();
          await moveSession(taskId, date, b.dataset.move);
        }),
      );
      d.querySelector('[data-open-task]').addEventListener('click', () => openTaskEditor(taskById(taskId)));
      d.querySelector('[data-remove-session]')?.addEventListener('click', async () => {
        d.close();
        const cur = taskById(taskId);
        await saveTask({
          ...cur,
          plan: cur.plan.filter((x) => x.date !== date).map((x) => (x.date >= today ? { ...x, pinned: true } : x)),
        });
      });
    },
  );
}

export function openCourseEditor(course, { kind = 'class' } = {}) {
  const isNew = !course;
  const c = isNew
    ? {
        id: uid(), kind, code: '', name: '', short: '', color: PALETTE[state.courses.length % PALETTE.length], instructor: '', email: '',
        office_hours: [], links: [], policies: '', canvas_course_id: null, aliases: [], sort_order: state.courses.length, archived: false,
      }
    : clone(course);
  const meetings = isNew ? [] : clone(state.meetings.filter((m) => m.course_id === c.id));
  const term = state.settings.term || {};
  const isClass = c.kind !== 'category';
  const known = PALETTE.some((p) => p.toLowerCase() === (c.color || '').toLowerCase());
  const swatches =
    PALETTE.map(
      (p) => `<label class="swatch" style="--c:${p}"><input type="radio" name="color" value="${p}"${p.toLowerCase() === (c.color || '').toLowerCase() ? ' checked' : ''} aria-label="Color ${p}"><span></span></label>`,
    ).join('') +
    `<label class="swatch custom" title="Pick any color"><input type="radio" name="color" value="custom"${known ? '' : ' checked'} aria-label="Custom color"><input type="color" name="color_custom" value="${esc(c.color || '#C9B8F0')}" aria-label="Custom color"></label>`;
  const kinds = ['Lecture', 'Discussion', 'Seminar', 'Lab', 'Section', 'Tutorial'];
  const meetingRow = (m = {}) => `<div class="meet-row" data-id="${esc(m.id || '')}">
    <select aria-label="Kind">${kinds.map((k) => `<option${(m.kind || 'Lecture') === k ? ' selected' : ''}>${k}</option>`).join('')}</select>
    ${dayChecks(m.days || [])}
    <input type="time" value="${esc(m.start_time || '09:30')}" aria-label="Starts">
    <input type="time" value="${esc(m.end_time || '10:20')}" aria-label="Ends">
    <input type="text" value="${esc(m.location || '')}" placeholder="Room" aria-label="Room">
    ${removeBtn('meeting time')}
  </div>`;
  const ohRow = (o = {}) => `<div class="oh-row">
    <input type="text" value="${esc(o.who || '')}" placeholder="Who" aria-label="Who">
    ${dayChecks(o.days || [])}
    <input type="time" value="${esc(o.start || '')}" aria-label="Starts">
    <input type="time" value="${esc(o.end || '')}" aria-label="Ends">
    <input type="text" value="${esc(o.where || '')}" placeholder="Where" aria-label="Where">
    <input type="text" value="${esc(o.text || o.note || '')}" placeholder="Note, or “By appointment”" aria-label="Note">
    ${removeBtn('office hours')}
  </div>`;

  const html = `<form class="sheet-form wide" novalidate>
    <header class="sheet-head"><h2>${isNew ? (isClass ? 'New class' : 'New category') : `Edit ${esc(c.short || c.name)}`}</h2><button type="button" class="btn icon" data-close aria-label="Close">×</button></header>
    <div class="sheet-body">
      <div class="grid2">
        <label class="field"><span>Kind</span><select name="kind"><option value="class"${isClass ? ' selected' : ''}>Class</option><option value="category"${isClass ? '' : ' selected'}>Category (not a class)</option></select></label>
        <label class="field"><span>Short name</span><input name="short" value="${esc(c.short)}" placeholder="CS" autofocus></label>
      </div>
      <label class="field"><span>Full name</span><input name="name" value="${esc(c.name)}" placeholder="Intro to Computer Science I"></label>
      <div class="grid2 class-only"${isClass ? '' : ' hidden'}>
        <label class="field"><span>Course code</span><input name="code" value="${esc(c.code)}" placeholder="CMSC 14100"></label>
        <label class="field"><span>Canvas course number</span><input name="canvas_course_id" value="${esc(c.canvas_course_id || '')}" inputmode="numeric" placeholder="From the course's Canvas address"></label>
      </div>
      <fieldset class="field"><legend>Color</legend><div class="swatches">${swatches}</div></fieldset>
      <div class="grid2 class-only"${isClass ? '' : ' hidden'}>
        <label class="field"><span>Instructor</span><input name="instructor" value="${esc(c.instructor)}"></label>
        <label class="field"><span>Email</span><input type="email" name="email" value="${esc(c.email)}"></label>
      </div>
      <fieldset class="field class-only"${isClass ? '' : ' hidden'}><legend>Class meetings</legend><div class="meet-rows">${meetings.map(meetingRow).join('')}</div><button type="button" class="btn small" data-add-meeting>+ Add a meeting time</button></fieldset>
      <fieldset class="field class-only"${isClass ? '' : ' hidden'}><legend>Office hours</legend><div class="oh-rows">${(c.office_hours || []).map(ohRow).join('')}</div><button type="button" class="btn small" data-add-oh>+ Add office hours</button></fieldset>
      <fieldset class="field"><legend>Links</legend><div class="link-rows">${(c.links || []).map(linkRow).join('')}</div><button type="button" class="btn small" data-add-link>+ Add a link</button></fieldset>
      <label class="field"><span>Policies and notes</span><textarea name="policies" rows="4">${esc(c.policies || '')}</textarea></label>
      <label class="field"><span>Extra quick-add nicknames (comma-separated)</span><input name="aliases" value="${esc((c.aliases || []).join(', '))}" placeholder="comp, 141"></label>
      <label class="check-inline"><input type="checkbox" name="archived"${c.archived ? ' checked' : ''}> Archive (hide from the dashboard)</label>
      <p class="form-error" role="alert" hidden></p>
    </div>
    <footer class="sheet-foot">
      ${isNew ? '' : '<button type="button" class="btn ghost danger" data-delete>Delete</button>'}
      <span class="spacer"></span>
      <button type="submit" class="btn btn-primary">${isNew ? 'Add' : 'Save'}</button>
    </footer>
  </form>`;

  open(html, (d) => {
    const form = d.querySelector('form');
    const el = form.elements;
    const q = (s) => form.querySelector(s);
    el.kind.addEventListener('change', () => form.querySelectorAll('.class-only').forEach((x) => (x.hidden = el.kind.value === 'category')));
    el.color_custom.addEventListener('input', () => {
      form.querySelector('input[name=color][value=custom]').checked = true;
    });
    form.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove-row]');
      if (rm) rm.parentElement.remove();
    });
    q('[data-add-meeting]').addEventListener('click', () => q('.meet-rows').insertAdjacentHTML('beforeend', meetingRow()));
    q('[data-add-oh]').addEventListener('click', () => q('.oh-rows').insertAdjacentHTML('beforeend', ohRow()));
    q('[data-add-link]').addEventListener('click', () => q('.link-rows').insertAdjacentHTML('beforeend', linkRow()));
    q('[data-delete]')?.addEventListener('click', () => {
      const foot = q('.sheet-foot');
      foot.innerHTML = `<span class="confirm-text">Delete ${esc(c.short || c.name)}? Its tasks stay but lose their class.</span><span class="spacer"></span>
        <button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn danger" data-confirm>Delete</button>`;
      foot.querySelector('[data-cancel]').onclick = () => openCourseEditor(course);
      foot.querySelector('[data-confirm]').onclick = async () => {
        d.close();
        await deleteCourse(c.id);
      };
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const short = el.short.value.trim();
      const name = el.name.value.trim();
      if (!short && !name) return showError(form, 'Give it a short name, like “CS”.');
      const picked = form.querySelector('input[name=color]:checked')?.value;
      const category = el.kind.value === 'category';
      const saved = {
        ...c,
        kind: el.kind.value,
        short: short || name,
        name,
        code: category ? '' : el.code.value.trim(),
        canvas_course_id: category ? c.canvas_course_id : el.canvas_course_id.value.trim() || null,
        color: picked === 'custom' || !picked ? el.color_custom.value : picked,
        instructor: category ? '' : el.instructor.value.trim(),
        email: category ? '' : el.email.value.trim(),
        policies: el.policies.value,
        aliases: el.aliases.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        archived: el.archived.checked,
        links: [...form.querySelectorAll('.link-row')]
          .map((r) => {
            const [label, url] = r.querySelectorAll('input');
            return { label: label.value.trim(), url: url.value.trim() };
          })
          .filter((l) => l.url),
        office_hours: category
          ? []
          : [...form.querySelectorAll('.oh-row')]
              .map((r) => {
                const [who, start, end, where, note] = [...r.querySelectorAll('input:not([type=checkbox])')].map((x) => x.value.trim());
                const days = readDays(r);
                if (days.length && start && end) return { who, days, start, end, where, note };
                return who || note ? { who, text: note, where } : null;
              })
              .filter(Boolean),
      };
      const meets = category
        ? []
        : [...form.querySelectorAll('.meet-row')]
            .map((r) => {
              const old = meetings.find((m) => m.id && m.id === r.dataset.id) || {};
              const [start_time, end_time] = [...r.querySelectorAll('input[type=time]')].map((x) => x.value);
              return {
                ...old,
                id: old.id || uid(),
                kind: r.querySelector('select').value,
                days: readDays(r),
                start_time,
                end_time,
                location: r.querySelector('input[type=text]').value.trim(),
                start_date: old.start_date || term.start || null,
                end_date: old.end_date || term.classes_end || term.end || null,
                exceptions: old.exceptions || [],
              };
            })
            .filter((m) => m.days.length && m.start_time && m.end_time);
      d.close();
      await saveCourse(saved, meets);
    });
  });
}

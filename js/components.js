// Small HTML builders shared by the screens.
import { atTime, dayDiff, fmtMinutes, fmtTime, relDay } from './dates.js';
import { estimateOf, studyPlanOf } from './planner.js';
import { courseById, state } from './state.js';
import { esc } from './util.js';

export const TYPE_LABEL = {
  assignment: 'Assignment',
  essay: 'Essay or paper',
  reading: 'Reading',
  exam: 'Exam or quiz',
  task: 'To-do',
  admin: 'Admin',
  event: 'Event',
};

export const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.3-6-11a6 6 0 0112 0c0 5.7-6 11-6 11z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.2" fill="currentColor"/></svg>',
};

export function chip(course, { small = false } = {}) {
  if (!course) return '';
  return `<span class="chip${small ? ' chip-sm' : ''}" style="--c:${esc(course.color || '#ddd')}">${esc(course.short || course.name)}</span>`;
}

/** 'overdue', 'soon' (24 h), 'near' (3 days), or ''. */
export function urgency(t, now = new Date()) {
  if (!t.due_at || t.status === 'done') return '';
  const due = new Date(t.due_at);
  if (due < now) return 'overdue';
  if (due - now <= 24 * 3600000) return 'soon';
  if (dayDiff(now, due) <= 3) return 'near';
  return '';
}

export function dueText(t, now = new Date()) {
  if (!t.due_at) return t.type === 'exam' ? 'Date not announced' : 'No due date';
  const d = new Date(t.due_at);
  let day = relDay(d, now);
  if (['Today', 'Tomorrow', 'Yesterday'].includes(day)) day = day.toLowerCase();
  const when = `${day}, ${fmtTime(d)}`;
  if (t.status !== 'done' && d < now) return `Overdue (${when})`;
  if (t.type === 'exam' || t.type === 'event') return when[0].toUpperCase() + when.slice(1);
  return `Due ${when}`;
}

const PRIORITY = ['', 'Low', 'Med', 'High'];

export function taskRow(t, { now = new Date(), planned = 0, at = [], compact = false } = {}) {
  const c = courseById(t.course_id);
  const u = urgency(t, now);
  const done = t.status === 'done';
  const subs = t.subtasks || [];
  const study = studyPlanOf(t, state.settings);
  const meta = [];
  if (!compact) meta.push(chip(c));
  meta.push(`<span class="due ${u}">${esc(dueText(t, now))}</span>`);
  if (planned) {
    const when = at.length ? `${at.map((s) => fmtTime(atTime('2000-01-01', s))).join(', ')} · ` : '';
    meta.push(`<span class="planned-at">${esc(when)}${esc(fmtMinutes(planned))} planned today</span>`);
  } else if (study && !done) {
    meta.push(`<span>Study ${esc(fmtMinutes(study.daily))} a day</span>`);
  } else if (!done && t.type !== 'event') {
    const est = estimateOf(t, state.settings);
    if (est) meta.push(`<span>${esc(fmtMinutes(est))}</span>`);
  }
  if (subs.length) meta.push(`<span>${subs.filter((s) => s.done).length}/${subs.length} steps</span>`);
  if (t.estimated_date) meta.push('<span class="tag" title="Expected date. It updates when the real one is posted on Canvas.">expected</span>');
  if (t.type === 'exam' && t.location) meta.push(`<span>${esc(t.location)}</span>`);
  const prio = t.priority ? `<span class="prio p${t.priority}" title="${PRIORITY[t.priority]} priority">${PRIORITY[t.priority]}</span>` : '';
  return `<div class="task ${done ? 'is-done' : ''} ${u}" style="--c:${esc(c?.color || 'var(--accent)')}">
    <button class="check" type="button" data-action="toggle" data-id="${t.id}" aria-label="${done ? 'Mark as not done' : 'Mark as done'}: ${esc(t.title)}" aria-pressed="${done}">${ICON.check}</button>
    <button class="task-body" type="button" data-action="open" data-id="${t.id}">
      <span class="task-title">${esc(t.title)}${prio}</span>
      <span class="task-meta">${meta.filter(Boolean).join('')}</span>
    </button>
  </div>`;
}

export function section(title, inner, { count = null, cls = '', action = '', id = '' } = {}) {
  return `<section class="card ${cls}"${id ? ` id="${id}"` : ''}>
    <header class="card-head"><h2>${esc(title)}${count !== null ? ` <span class="count">${count}</span>` : ''}</h2>${action}</header>
    ${inner}
  </section>`;
}

export const empty = (msg) => `<p class="empty">${esc(msg)}</p>`;

/** The box on the Plan tab where you type changes like "clear 5-7pm for basketball". */
export function askBox(placeholder = 'Tell the planner: “basketball 5-7pm”') {
  return `<form class="quick card ask" data-form="ask" autocomplete="off">
    <label class="sr-only" for="ask-input">Tell the planner what to change</label>
    <input id="ask-input" name="text" type="text" placeholder="${esc(placeholder)}" enterkeyhint="go" autocapitalize="off" spellcheck="false">
    <button class="btn btn-primary" type="submit">Go</button>
    <div class="quick-preview" id="ask-preview" aria-live="polite"></div>
  </form>`;
}

/** What the last typed change did, with Undo. */
export function askResult() {
  const a = state.ask;
  if (!a) return '';
  const moved = a.moved || [];
  return `<section class="card ask-result${a.ok ? '' : ' tone-warn'}" role="status">
    <div class="ask-head">
      <span class="ask-icon${a.ok ? '' : ' warn'}">${a.ok ? ICON.check : ICON.warn}</span>
      <p class="ask-title">${esc(a.title)}</p>
      ${a.snap ? '<button class="btn small" type="button" data-action="ask-undo">Undo</button>' : ''}
      <button class="btn icon small ghost" type="button" data-action="ask-dismiss" aria-label="Dismiss">×</button>
    </div>
    ${(a.lines || []).map((l) => `<p class="ask-line">${esc(l)}</p>`).join('')}
    ${moved.length ? `<ul class="ask-moved">${moved.slice(0, 5).map((m) => `<li>${esc(m)}</li>`).join('')}${moved.length > 5 ? `<li>and ${moved.length - 5} more</li>` : ''}</ul>` : ''}
    ${a.ai ? `<div class="row-gap ask-ai"><button class="btn small" type="button" data-action="ask-ai" data-text="${esc(a.ai)}"><span aria-hidden="true">✦</span> Ask AI instead</button></div>` : ''}
    ${a.examples ? `<p class="ask-line">Things you can say:</p><div class="ask-examples">${a.examples.map((x) => `<button type="button" class="qp-bit" data-action="ask-example" data-text="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
  </section>`;
}

export const byDue = (a, b) => (a.due_at || '9999') < (b.due_at || '9999') ? -1 : (a.due_at || '9999') > (b.due_at || '9999') ? 1 : (b.priority || 0) - (a.priority || 0);

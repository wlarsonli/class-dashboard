import { byDue, empty, taskRow } from '../components.js';
import { atTime, DOW, fmtDays, fmtHM, fmtRange, toMinutes } from '../dates.js';
import { courseById, liveTasks, state } from '../state.js';
import { esc, safeUrl } from '../util.js';

const range = (a, b) => fmtRange(atTime('2000-01-01', a), atTime('2000-01-01', b));

/** Does an office-hours slot overlap any of your class meetings? */
function ohFit(o) {
  if (!o.days?.length || !o.start || !o.end) return null;
  const s = toMinutes(o.start);
  const e = toMinutes(o.end);
  for (const m of state.meetings) {
    const c = courseById(m.course_id);
    if (!c || c.archived) continue;
    if (!o.days.some((d) => m.days.includes(d))) continue;
    const ms = toMinutes(m.start_time);
    const me = toMinutes(m.end_time);
    if (ms < e && me > s) {
      const what = `${c.short} ${m.kind.toLowerCase()}`;
      if (me < e && ms <= s) return { ok: false, text: `Free after ${fmtHM(m.end_time)} (${what})` };
      if (ms > s && me >= e) return { ok: false, text: `Free until ${fmtHM(m.start_time)} (${what})` };
      return { ok: false, text: `Clashes with ${what}` };
    }
  }
  return { ok: true, text: 'Fits your schedule' };
}

function ohLine(o) {
  const when = o.text ? esc(o.text) : `${esc((o.days || []).map((d) => DOW[d]).join(' & '))} ${esc(range(o.start, o.end))}`;
  const fit = ohFit(o);
  return `<li class="oh-line">
    <span class="oh-who">${esc(o.who || '')}${o.note ? ` <em>(${esc(o.note)})</em>` : ''}</span>
    <span class="oh-when">${when}${o.where ? ` · ${esc(o.where)}` : ''}</span>
    ${fit ? `<span class="fit ${fit.ok ? 'ok' : 'clash'}">${esc(fit.text)}</span>` : ''}
  </li>`;
}

function courseCard(c) {
  const meetings = state.meetings.filter((m) => m.course_id === c.id);
  const tasks = liveTasks().filter((t) => t.course_id === c.id);
  const done = tasks.filter((t) => t.status === 'done').length;
  const upcoming = tasks.filter((t) => t.status !== 'done').sort(byDue).slice(0, 3);
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const links = (c.links || []).map((l) => ({ ...l, href: safeUrl(l.url) })).filter((l) => l.href);
  const oh = c.office_hours || [];
  return `<article class="card course" style="--c:${esc(c.color)}">
    <header class="course-head">
      <div><p class="eyebrow">${esc(c.code || 'Category')}</p><h2>${esc(c.name || c.short)}</h2></div>
      <button class="btn small" type="button" data-action="edit-course" data-id="${c.id}">Edit</button>
    </header>
    ${c.instructor || c.email ? `<p class="course-line">${esc(c.instructor)}${c.instructor && c.email ? ' · ' : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p>` : ''}
    ${
      meetings.length
        ? `<ul class="plain meetings">${meetings
            .map((m) => `<li><strong>${esc(m.kind)}</strong> ${esc(fmtDays(m.days))} ${esc(range(m.start_time, m.end_time))}${m.location ? ` · ${esc(m.location)}` : ''}</li>`)
            .join('')}</ul>`
        : ''
    }
    ${oh.length ? `<details class="oh"${oh.length <= 3 ? ' open' : ''}><summary>Office hours (${oh.length})</summary><ul class="plain">${oh.map(ohLine).join('')}</ul></details>` : ''}
    ${links.length ? `<p class="links">${links.map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label || 'Link')}</a>`).join('')}</p>` : ''}
    ${c.policies ? `<details class="policies"><summary>Policies and notes</summary><p>${esc(c.policies).replace(/\n/g, '<br>')}</p></details>` : ''}
    ${tasks.length ? `<div class="progress"><div class="bar"><span style="width:${pct}%"></span></div><span>${done} of ${tasks.length} done</span></div>` : ''}
    ${upcoming.length ? `<div class="task-list">${upcoming.map((t) => taskRow(t, { compact: true })).join('')}</div>` : ''}
    <button class="btn ghost small" type="button" data-action="new-task" data-course="${c.id}">+ Add a task</button>
  </article>`;
}

export function renderClasses() {
  const classes = state.courses.filter((c) => c.kind !== 'category' && !c.archived);
  const cats = state.courses.filter((c) => c.kind === 'category' && !c.archived);
  return `<div class="page-head">
    <div><p class="eyebrow">${esc(state.settings.term?.name || '')}</p><h1>Classes</h1></div>
    <div class="head-actions">
      <button class="btn" type="button" data-action="new-course" data-kind="category">+ Category</button>
      <button class="btn btn-primary" type="button" data-action="new-course" data-kind="class">+ Class</button>
    </div>
  </div>
  ${classes.length ? `<div class="course-grid">${classes.map(courseCard).join('')}</div>` : empty('No classes yet. Add one to get started.')}
  ${cats.length ? `<h2 class="sub">Everything else</h2><div class="course-grid cats">${cats.map(courseCard).join('')}</div>` : ''}`;
}

import { byDue, chip, ICON } from '../components.js';
import { addDays, DOW, fmtDate, fmtMinutes, fmtTime, MON, parseYmd, weekStart, ymd } from '../dates.js';
import { isStudyBlock, loadByDay, makeCapacity, workloadWarnings } from '../planner.js';
import { courseById, liveTasks, state } from '../state.js';
import { breakOn, busyOn, meetingsOn } from '../term.js';
import { esc } from '../util.js';

const color = (t) => esc(courseById(t.course_id)?.color || 'var(--accent)');

export function renderWeek() {
  const now = new Date();
  const todayStr = ymd(now);
  const start = addDays(weekStart(now), state.weekOffset * 7);
  const end = addDays(start, 6);
  const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(start, i)));
  const tasks = liveTasks();
  const capacity = makeCapacity(state, now);
  const load = loadByDay(tasks);
  const warns = new Map(workloadWarnings(state, { now, days: 42 }).map((w) => [w.date, w]));
  const range =
    start.getMonth() === end.getMonth()
      ? `${MON[start.getMonth()]} ${start.getDate()}–${end.getDate()}`
      : `${MON[start.getMonth()]} ${start.getDate()} – ${MON[end.getMonth()]} ${end.getDate()}`;
  const weekPlanned = days.reduce((a, d) => a + (load[d] || 0), 0);
  const label = { '-1': 'Last week', 0: 'This week', 1: 'Next week' }[state.weekOffset] || 'Week of';

  const head = `<div class="page-head">
    <div><p class="eyebrow">${esc(label)}</p><h1>${esc(range)}</h1></div>
    <div class="head-actions">
      <div class="seg">
        <button class="btn icon" type="button" data-action="week-prev" aria-label="Previous week">${ICON.left}</button>
        <button class="btn" type="button" data-action="week-today">This week</button>
        <button class="btn icon" type="button" data-action="week-next" aria-label="Next week">${ICON.right}</button>
      </div>
      <button class="btn btn-primary" type="button" data-action="replan" title="Spread unpinned work sessions out again">Re-plan</button>
    </div>
  </div>
  <p class="hint">${esc(fmtMinutes(weekPlanned))} of work planned this week. Drag a work session to another day, or tap it, to move it. Sessions you move stay put when you re-plan.</p>`;

  const cols = days
    .map((d) => {
      const date = parseYmd(d);
      const isToday = d === todayStr;
      const brk = breakOn(d, state.settings);
      const classes = meetingsOn(d, state);
      const events = busyOn(d, state).filter((b) => !b.all_day && !isStudyBlock(b));
      const due = tasks.filter((t) => t.due_at && ymd(new Date(t.due_at)) === d).sort(byDue);
      const sessions = tasks
        .filter((t) => t.status !== 'done')
        .flatMap((t) => (t.plan || []).filter((s) => s.date === d).map((s) => ({ t, s })))
        .sort((a, b) => byDue(a.t, b.t));
      const planned = load[d] || 0;
      const cap = capacity(d);
      const pct = cap ? Math.min(100, (planned / cap) * 100) : planned ? 100 : 0;
      const w = warns.get(d);
      const sched = [
        ...classes.map(
          (m) => `<li title="${esc(`${m.meeting.kind}, ${m.location}`)}"><span>${esc(fmtTime(m.start))}</span>${chip(m.course, { small: true })}${m.note ? `<em>${esc(m.note)}</em>` : ''}</li>`,
        ),
        ...events.map(
          (b) => `<li title="${esc(b.location || '')}"><span>${esc(fmtTime(new Date(b.starts_at)))}</span><em>${esc(b.title)}</em></li>`,
        ),
      ];
      return `<section class="day card${isToday ? ' is-today' : ''}${d < todayStr ? ' is-past' : ''}" data-drop="${d}" aria-label="${esc(fmtDate(date, { long: true }))}">
        <header class="day-head">
          <div><span class="day-name">${DOW[date.getDay()]}</span> <span class="day-num">${date.getDate()}</span>${isToday ? ' <span class="tag today-tag">Today</span>' : ''}</div>
          ${w ? `<span class="warn-badge" title="${esc(w.reasons.join(', '))}">${ICON.warn}</span>` : ''}
        </header>
        ${brk ? `<p class="day-break">${esc(brk.label)}</p>` : ''}
        <div class="meter" title="${esc(`${fmtMinutes(planned)} planned, about ${fmtMinutes(cap)} free`)}"><span class="${planned > cap + 30 ? 'over' : ''}" style="width:${pct.toFixed(0)}%"></span></div>
        <p class="meter-label">${planned ? `${esc(fmtMinutes(planned))} planned` : 'Nothing planned'}${w ? ` · <strong>${esc(w.reasons[0])}</strong>` : ''}</p>
        ${sched.length ? `<ul class="mini-sched">${sched.join('')}</ul>` : ''}
        ${
          due.length
            ? `<div class="day-group"><h3>Due</h3>${due
                .map(
                  (t) => `<button type="button" class="due-chip${t.status === 'done' ? ' is-done' : ''}" data-action="open" data-id="${t.id}" style="--c:${color(t)}">
                    <span>${esc(t.title)}</span><small>${esc(fmtTime(new Date(t.due_at)))}</small></button>`,
                )
                .join('')}</div>`
            : ''
        }
        <div class="day-group"><h3>Work</h3>${
          sessions.length
            ? sessions
                .map(
                  ({ t, s }) => `<button type="button" class="session" draggable="true" data-drag data-action="session" data-id="${t.id}" data-date="${d}" style="--c:${color(t)}">
                    <span>${esc(t.title)}</span><small>${esc(fmtMinutes(s.minutes))}${s.pinned ? ` ${ICON.pin}` : ''}</small></button>`,
                )
                .join('')
            : '<p class="day-empty">Free</p>'
        }</div>
      </section>`;
    })
    .join('');

  return `${head}<div class="week-grid">${cols}</div>`;
}

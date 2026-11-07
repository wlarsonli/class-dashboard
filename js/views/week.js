import { askBox, askResult, byDue, chip, ICON } from '../components.js';
import { addDays, atTime, dayDiff, DOW, fmtDate, fmtMinutes, fmtTime, MON, parseYmd, startOfDay, weekStart, ymd } from '../dates.js';
import { dayLimit, isStudyBlock, loadByDay, makeCapacity, workloadWarnings } from '../planner.js';
import { courseById, liveTasks, state } from '../state.js';
import { breakOn, busyOn, eventsOn, meetingsOn } from '../term.js';
import { esc } from '../util.js';

const color = (t) => esc(courseById(t.course_id)?.color || 'var(--accent)');

export function renderWeek() {
  const now = new Date();
  const todayStr = ymd(now);
  const start = addDays(weekStart(now), state.weekOffset * 7);
  const end = addDays(start, 6);
  const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(start, i)));
  const tasks = liveTasks();
  const capacity = makeCapacity(state, startOfDay(now));
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
      <div class="seg pills" role="group" aria-label="View"><a href="#day">Day</a><a class="active" href="#week" aria-current="page">Week</a></div>
      <div class="seg">
        <button class="btn icon" type="button" data-action="week-prev" aria-label="Previous week">${ICON.left}</button>
        <button class="btn" type="button" data-action="week-today">This week</button>
        <button class="btn icon" type="button" data-action="week-next" aria-label="Next week">${ICON.right}</button>
      </div>
      <button class="btn btn-primary" type="button" data-action="replan" title="Re-plan everything you haven't placed yourself">Re-plan</button>
    </div>
  </div>
  ${askBox()}
  ${askResult()}
  <p class="hint">${esc(fmtMinutes(weekPlanned))} of work planned this week. Tap a day to see its full schedule. Drag a work session to another day (on your phone, press and hold first), or tap it for options.</p>`;

  const cols = days
    .map((d) => {
      const date = parseYmd(d);
      const isToday = d === todayStr;
      const brk = breakOn(d, state.settings);
      const classes = meetingsOn(d, state);
      const events = busyOn(d, state).filter((b) => !b.all_day && !isStudyBlock(b));
      const mine = eventsOn(d, state);
      const limit = dayLimit(state, d);
      const due = tasks.filter((t) => t.due_at && ymd(new Date(t.due_at)) === d).sort(byDue);
      // One chip per task per day, showing when its first block starts.
      const byTask = new Map();
      for (const t of tasks) {
        if (t.status === 'done') continue;
        for (const s of t.plan || []) {
          if (s.date !== d) continue;
          const x = byTask.get(t.id) || { t, minutes: 0, starts: [], pinned: false, unplaced: false };
          x.minutes += s.minutes;
          if (s.start && !s.unscheduled) x.starts.push(s.start);
          x.pinned = x.pinned || !!s.pinned;
          x.unplaced = x.unplaced || !!s.unscheduled;
          byTask.set(t.id, x);
        }
      }
      const sessions = [...byTask.values()].sort((a, b) => (a.starts[0] || '99').localeCompare(b.starts[0] || '99'));
      const planned = load[d] || 0;
      const cap = capacity(d);
      const pct = cap ? Math.min(100, (planned / cap) * 100) : planned ? 100 : 0;
      const w = warns.get(d);
      // Classes, your events, and Outlook events, in time order.
      const minsOf = (x) => x.getHours() * 60 + x.getMinutes();
      const sched = [
        ...classes.map((m) => ({
          at: minsOf(m.start),
          html: `<li title="${esc(`${m.meeting.kind}, ${m.location}`)}"><span>${esc(fmtTime(m.start))}</span>${chip(m.course, { small: true })}${m.note ? `<em>${esc(m.note)}</em>` : ''}</li>`,
        })),
        ...mine.map((o) => ({
          at: o.s,
          html: `<li class="mine"><span>${esc(fmtTime(atTime(d, o.start)))}</span><button type="button" class="mine-link" data-action="event" data-ev="${o.ev.id}" data-date="${d}">${esc(o.title)}</button></li>`,
        })),
        ...events.map((b) => ({
          at: minsOf(new Date(b.starts_at)),
          html: `<li title="${esc(b.location || '')}"><span>${esc(fmtTime(new Date(b.starts_at)))}</span><em>${esc(b.title)}</em></li>`,
        })),
      ]
        .sort((x, y) => x.at - y.at)
        .map((x) => x.html);
      const offset = dayDiff(startOfDay(now), date);
      return `<section class="day card${isToday ? ' is-today' : ''}${d < todayStr ? ' is-past' : ''}" data-drop="${d}" aria-label="${esc(fmtDate(date, { long: true }))}">
        <header class="day-head">
          <button type="button" class="day-link" data-action="open-day" data-offset="${offset}" aria-label="Open ${esc(fmtDate(date, { long: true }))}">
            <span class="day-name">${DOW[date.getDay()]}</span> <span class="day-num">${date.getDate()}</span>${isToday ? ' <span class="tag today-tag">Today</span>' : ''}
          </button>
          ${w ? `<span class="warn-badge" title="${esc(w.reasons.join(', '))}">${ICON.warn}</span>` : ''}
        </header>
        ${brk ? `<p class="day-break">${esc(brk.label)}</p>` : ''}
        ${limit === 0 ? '<p class="day-break off">Day off</p>' : limit !== null ? `<p class="day-break">At most ${esc(fmtMinutes(limit))} of work</p>` : ''}
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
                  (x) => `<button type="button" class="session${x.unplaced ? ' unplaced' : ''}" data-drag="session" data-action="session" data-id="${x.t.id}" data-date="${d}" style="--c:${color(x.t)}">
                    <span>${esc(x.t.type === 'exam' ? `Study: ${x.t.title}` : x.t.title)}</span>
                    <small>${x.starts.length ? `${esc(fmtTime(atTime(d, x.starts[0])))} · ` : ''}${esc(fmtMinutes(x.minutes))}${x.unplaced ? ' · doesn’t fit' : ''}${x.pinned ? ` ${ICON.pin}` : ''}</small></button>`,
                )
                .join('')
            : '<p class="day-empty">Free</p>'
        }</div>
      </section>`;
    })
    .join('');

  return `${head}<div class="week-grid">${cols}</div>`;
}

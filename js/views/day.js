// Day view: a timeline of one day with classes, Outlook events, exams, deadlines, and the
// work blocks the planner scheduled. Tap a work block to move it.
import { byDue, ICON } from '../components.js';
import { addDays, DOW_LONG, fmtMinutes, fmtRange, fmtTime, MON_LONG, parseYmd, relDay, startOfDay, toMinutes, ymd } from '../dates.js';
import { DEFAULT_WINDOW, freeGaps, outlookStudy } from '../planner.js';
import { courseById, liveTasks, state } from '../state.js';
import { breakOn, busyOn, meetingsOn } from '../term.js';
import { esc } from '../util.js';

const PX = 1.1; // pixels per minute
const minsOf = (d) => d.getHours() * 60 + d.getMinutes();
const at = (dateStr, m) => {
  const d = parseYmd(dateStr);
  d.setMinutes(m);
  return d;
};

/** Side-by-side columns for things that overlap, like a calendar app. */
function layout(items) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = [];
  let end = -1;
  const flush = () => {
    const cols = [];
    for (const it of cluster) {
      let c = cols.findIndex((e) => e <= it.s);
      if (c < 0) {
        c = cols.length;
        cols.push(0);
      }
      cols[c] = it.e;
      it.col = c;
    }
    for (const it of cluster) it.cols = cols.length;
    out.push(...cluster);
    cluster = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.s >= end) {
      flush();
      end = -1;
    }
    cluster.push(it);
    end = Math.max(end, it.e);
  }
  if (cluster.length) flush();
  return out;
}

export function dayItems(d, now = new Date()) {
  const tasks = liveTasks();
  const items = [];
  for (const m of meetingsOn(d, state)) {
    items.push({ kind: 'class', s: minsOf(m.start), e: minsOf(m.end), title: `${m.course.short} ${m.meeting.kind}`, sub: [m.location, m.note].filter(Boolean).join(' · '), color: m.course.color });
  }
  const attributed = new Map();
  for (const [taskId, list] of outlookStudy(state, now)) for (const v of list) attributed.set(v.uid, taskId);
  const d0 = parseYmd(d);
  const d1 = addDays(d0, 1);
  const allDay = [];
  for (const b of busyOn(d, state)) {
    if (b.all_day) {
      allDay.push(b);
      continue;
    }
    const s = new Date(b.starts_at);
    const e = new Date(b.ends_at);
    const forTask = attributed.get(b.uid || String(b.id));
    const t = forTask ? tasks.find((x) => x.id === forTask) : null;
    items.push({
      kind: t ? 'event study' : 'event',
      s: s < d0 ? 0 : minsOf(s),
      e: e >= d1 ? 1440 : minsOf(e),
      title: b.title,
      sub: t ? `Counts toward ${t.title}` : b.location || 'Outlook',
      color: t ? courseById(t.course_id)?.color : null,
    });
  }
  for (const t of tasks) {
    if (!t.due_at || ymd(new Date(t.due_at)) !== d) continue;
    const due = new Date(t.due_at);
    const c = courseById(t.course_id);
    if (t.type === 'exam' || t.type === 'event') {
      items.push({ kind: 'exam', s: minsOf(due), e: minsOf(due) + (t.duration_minutes || 60), title: `${c ? `${c.short} · ` : ''}${t.title}`, sub: t.location, color: c?.color, id: t.id });
    }
  }
  const unscheduled = [];
  for (const t of tasks) {
    if (t.status === 'done') continue;
    const c = courseById(t.course_id);
    for (const s of t.plan || []) {
      if (s.date !== d) continue;
      if (!s.start || s.unscheduled) {
        unscheduled.push({ t, s });
        continue;
      }
      const st = toMinutes(s.start);
      items.push({
        kind: `work${s.fixed ? ' fixed' : ''}`,
        s: st,
        e: st + s.minutes,
        title: t.type === 'exam' ? `Study: ${t.title}` : t.title,
        sub: `${c ? `${c.short} · ` : ''}${fmtMinutes(s.minutes)}${s.fixed ? ' · set by you' : ''}`,
        color: c?.color,
        id: t.id,
        date: d,
        start: s.start,
      });
    }
  }
  const deadlines = tasks
    .filter((t) => t.due_at && ymd(new Date(t.due_at)) === d && t.type !== 'exam' && t.type !== 'event')
    .sort(byDue)
    .map((t) => ({ t, m: minsOf(new Date(t.due_at)) }));
  return { items, allDay, unscheduled, deadlines };
}

export function renderDay() {
  const now = new Date();
  const date = addDays(startOfDay(now), state.dayOffset);
  const d = ymd(date);
  const isToday = d === ymd(now);
  const { items, allDay, unscheduled, deadlines } = dayItems(d, now);
  const win = { ...DEFAULT_WINDOW, ...(state.settings.study_window || {}) };
  const work = items.filter((i) => i.kind.startsWith('work'));
  const planned = work.reduce((a, i) => a + (i.e - i.s), 0) + unscheduled.reduce((a, u) => a + u.s.minutes, 0);
  const extra = work.map((w) => ({ s: w.s, e: w.e + 10 }));
  const freeLeft = freeGaps(d, state, { now, extra }).reduce((a, [s, e]) => a + (e - s >= 30 ? e - s : 0), 0);

  // Timeline range: your study hours, stretched to fit anything earlier or later.
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const dayStart = toMinutes(weekend && win.weekend_start ? win.weekend_start : win.start);
  const lo = Math.floor(Math.min(dayStart, ...items.map((i) => i.s), ...deadlines.map((x) => x.m)) / 60) * 60;
  const hi = Math.min(1440, Math.ceil(Math.max(toMinutes(win.end), ...items.map((i) => i.e), ...deadlines.map((x) => x.m + 30)) / 60) * 60);
  const y = (m) => (m - lo) * PX;
  const hours = [];
  for (let m = lo; m <= hi; m += 60) hours.push(`<span class="tl-hour" style="top:${y(m)}px">${m === 1440 ? '12 am' : esc(fmtTime(at(d, m)))}</span>`);

  const blocks = layout(items.filter((i) => i.e > lo && i.s < hi))
    .map((i) => {
      const top = y(Math.max(i.s, lo));
      const h = Math.max(22, (Math.min(i.e, hi) - Math.max(i.s, lo)) * PX - 3);
      const style = `top:${top}px;height:${h}px;left:calc(${(i.col / i.cols) * 100}% + 2px);width:calc(${100 / i.cols}% - 4px);${i.color ? `--c:${esc(i.color)};` : ''}`;
      const time = esc(fmtRange(at(d, i.s), at(d, i.e)));
      const inner = `<span class="tl-title">${esc(i.title)}</span><span class="tl-time">${time}${i.sub ? ` · ${esc(i.sub)}` : ''}</span>`;
      const short = h < 44 ? ' short' : '';
      if (i.kind.startsWith('work')) {
        return `<button type="button" class="tl-item ${i.kind}${short}" style="${style}" data-action="block" data-id="${i.id}" data-date="${i.date}" data-start="${i.start}">${inner}</button>`;
      }
      if (i.kind === 'exam') return `<button type="button" class="tl-item exam${short}" style="${style}" data-action="open" data-id="${i.id}">${inner}</button>`;
      return `<div class="tl-item ${i.kind}${short}" style="${style}">${inner}</div>`;
    })
    .join('');

  const dueMarks = deadlines
    .filter((x) => x.m >= lo && x.m <= hi)
    .map(
      ({ t, m }) => `<button type="button" class="tl-due${t.status === 'done' ? ' is-done' : ''}" style="top:${y(m)}px;--c:${esc(courseById(t.course_id)?.color || 'var(--accent)')}" data-action="open" data-id="${t.id}">
        <span>Due ${esc(fmtTime(at(d, m)))} · ${esc(t.title)}</span></button>`,
    )
    .join('');
  const nowLine = isToday && minsOf(now) >= lo && minsOf(now) <= hi ? `<div class="tl-now" style="top:${y(minsOf(now))}px"><span>${esc(fmtTime(now))}</span></div>` : '';

  const label = isToday ? 'Today' : relDay(date, now);
  const brk = breakOn(d, state.settings);
  const summary = [
    planned ? `${fmtMinutes(planned)} of work planned` : 'No work planned',
    deadlines.length ? `${deadlines.length} due` : '',
    freeLeft >= 30 ? `${fmtMinutes(freeLeft)} still free` : '',
  ].filter(Boolean).join(' · ');

  return `<div class="page-head">
    <div><p class="eyebrow">${esc(label)}${brk ? ` · ${esc(brk.label)}` : ''}</p><h1>${esc(DOW_LONG[date.getDay()])}, ${esc(MON_LONG[date.getMonth()])} ${date.getDate()}</h1></div>
    <div class="head-actions">
      <div class="seg pills" role="group" aria-label="View"><a class="active" href="#day" aria-current="page">Day</a><a href="#week">Week</a></div>
      <div class="seg">
        <button class="btn icon" type="button" data-action="day-prev" aria-label="Previous day">${ICON.left}</button>
        <button class="btn" type="button" data-action="day-today">Today</button>
        <button class="btn icon" type="button" data-action="day-next" aria-label="Next day">${ICON.right}</button>
      </div>
      <button class="btn btn-primary" type="button" data-action="replan" title="Re-plan everything you haven't placed yourself">Re-plan</button>
    </div>
  </div>
  <p class="hint">${esc(summary)}. Work is fitted around your classes and Outlook events. Tap a block to move it.</p>
  ${
    unscheduled.length
      ? `<section class="card tone-warn day-unplaced"><header class="card-head"><h2>Doesn't fit in this day's free time</h2></header>
          <div class="unplaced">${unscheduled
            .map(
              ({ t, s }) => `<button type="button" class="session" style="--c:${esc(courseById(t.course_id)?.color || 'var(--accent)')}" data-action="session" data-id="${t.id}" data-date="${d}">
                <span>${esc(t.type === 'exam' ? `Study: ${t.title}` : t.title)}</span><small>${esc(fmtMinutes(s.minutes))} · tap to move it</small></button>`,
            )
            .join('')}</div></section>`
      : ''
  }
  ${allDay.length ? `<div class="allday">${allDay.map((b) => `<span class="tag">${esc(b.title)}</span>`).join('')}</div>` : ''}
  <section class="card timeline" style="--h:${(hi - lo) * PX}px;--hour:${60 * PX}px" aria-label="Schedule for ${esc(DOW_LONG[date.getDay()])}">
    <div class="tl-hours">${hours.join('')}</div>
    <div class="tl-lanes">${blocks}${dueMarks}${nowLine}</div>
  </section>`;
}

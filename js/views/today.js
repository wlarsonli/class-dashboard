import { aiCard } from '../assistant.js';
import { askResult, byDue, chip, empty, ICON, section, taskRow } from '../components.js';
import { addDays, countdown, DOW_LONG, fmtDate, fmtMinutes, fmtRange, MON_LONG, parseYmd, relDay, startOfDay, ymd } from '../dates.js';
import { estimateOf, workloadWarnings } from '../planner.js';
import { courseById, openTasks, state } from '../state.js';
import { termInfo } from '../term.js';
import { esc } from '../util.js';
import { dayItems } from './day.js';

function welcome() {
  return `<div class="page-head"><div><p class="eyebrow">Welcome</p><h1>Let's set up your dashboard</h1></div></div>
  <section class="card welcome">
    <p>Import a starter or backup file, or add your classes yourself.</p>
    <div class="row-gap">
      <label class="btn btn-primary">Import a file<input type="file" accept="application/json,.json" data-import hidden></label>
      <button class="btn" type="button" data-action="new-course" data-kind="class">Add a class</button>
      <button class="btn" type="button" data-action="new-task">Add a task</button>
    </div>
  </section>`;
}

export function renderToday() {
  if (!state.courses.length && !state.tasks.length) return welcome();
  const now = new Date();
  const todayStr = ymd(now);
  const open = openTasks();
  const term = termInfo(state.settings, now);

  const overdue = open.filter((t) => t.due_at && new Date(t.due_at) < now && t.type !== 'event').sort(byDue);
  const dueToday = open.filter((t) => t.due_at && new Date(t.due_at) >= now && ymd(new Date(t.due_at)) === todayStr).sort(byDue);
  const shown = new Set([...overdue, ...dueToday].map((t) => t.id));
  const planned = open
    .map((t) => {
      const blocks = (t.plan || []).filter((s) => s.date === todayStr);
      return { t, minutes: blocks.reduce((a, s) => a + s.minutes, 0), starts: blocks.filter((s) => s.start && !s.unscheduled).map((s) => s.start).sort() };
    })
    .filter((x) => x.minutes && !shown.has(x.t.id))
    .sort((a, b) => (a.starts[0] || '99').localeCompare(b.starts[0] || '99') || byDue(a.t, b.t));
  const horizon = addDays(startOfDay(now), 8);
  const week = open.filter((t) => t.due_at && ymd(new Date(t.due_at)) > todayStr && new Date(t.due_at) < horizon).sort(byDue);
  const noDate = open.filter((t) => !t.due_at && t.type !== 'exam');
  const doneToday = state.tasks.filter((t) => !t.hidden && t.status === 'done' && t.done_at && ymd(new Date(t.done_at)) === todayStr);
  const plannedMin = planned.reduce((a, x) => a + x.minutes, 0);
  const list = (arr) => `<div class="task-list">${arr.map((t) => taskRow(t, { now })).join('')}</div>`;

  const head = `<div class="page-head">
    <div><p class="eyebrow">${esc(term ? term.label : '')}</p><h1>${esc(DOW_LONG[now.getDay()])}, ${esc(MON_LONG[now.getMonth()])} ${now.getDate()}</h1></div>
  </div>`;

  const quick = `<form class="quick card o-0" data-form="quick" autocomplete="off">
    <label class="sr-only" for="quick-input">Add a task or change your plan</label>
    <input id="quick-input" name="text" type="text" placeholder="Add a task (“cs hw7 fri 6pm”) or change your plan (“basketball 5-7pm”)" enterkeyhint="done">
    <button class="btn btn-primary" type="submit">Add</button>
    <div class="quick-preview" id="quick-preview" aria-live="polite"></div>
  </form>`;

  const warns = workloadWarnings(state, { now, days: 14 });
  const headsUp = warns.length
    ? section(
        'Heads-up',
        `<ul class="warn-list">${warns
          .slice(0, 4)
          .map((w) => `<li>${ICON.warn}<span><strong>${esc(relDay(parseYmd(w.date), now))}:</strong> ${esc(w.reasons.join(' · '))}</span></li>`)
          .join('')}</ul>`,
        { cls: 'o-1 tone-warn' },
      )
    : '';

  const overdueCard = overdue.length ? section('Overdue', list(overdue), { count: overdue.length, cls: 'o-2 tone-overdue' }) : '';
  const todayCard = section('Due today', dueToday.length ? list(dueToday) : empty('Nothing due today.'), {
    count: dueToday.length || null,
    cls: 'o-3',
  });
  const plannedCard = section(
    'Planned for today',
    planned.length
      ? `<div class="task-list">${planned.map(({ t, minutes, starts }) => taskRow(t, { now, planned: minutes, at: starts })).join('')}</div>
         <p class="foot">${esc(fmtMinutes(plannedMin))} of work planned. See or move it in <a href="#day">Plan</a>.</p>`
      : empty('No work sessions planned for today.'),
    { count: planned.length || null, cls: 'o-5' },
  );
  const weekCard = section('Next 7 days', week.length ? list(week) : empty('Nothing else due in the next week.'), {
    count: week.length || null,
    cls: 'o-6',
  });
  const doneCard = doneToday.length ? section('Done today', list(doneToday), { count: doneToday.length, cls: 'o-9 tone-done' }) : '';
  const noDateCard = noDate.length ? section('No due date', list(noDate), { count: noDate.length, cls: 'o-10' }) : '';

  // Schedule: classes, Outlook events, exams, and the work blocks the planner scheduled.
  const at = (m) => {
    const d = startOfDay(now);
    d.setMinutes(m);
    return d;
  };
  const items = dayItems(todayStr, now)
    .items.sort((a, b) => a.s - b.s)
    .map((i) => {
      const c = i.id ? courseById(openTasks().find((t) => t.id === i.id)?.course_id) : null;
      let html;
      if (i.kind === 'class') html = `<span class="ev-title">${esc(i.title)}</span>`;
      else if (i.kind.startsWith('work')) html = `${chip(c, { small: true })}<span class="ev-title">${esc(i.title)}</span><span class="tag">work</span>`;
      else if (i.kind === 'exam') html = `<span class="ev-title">${esc(i.title)}</span><span class="tag exam-tag">exam</span>`;
      else if (i.kind === 'mine' || i.kind === 'tevent') html = `<span class="ev-dot mine"></span><span class="ev-title">${esc(i.title)}</span>`;
      else html = `<span class="ev-dot${i.kind.includes('study') ? ' study' : ''}"></span><span class="ev-title">${esc(i.title)}</span>`;
      const where = i.kind === 'class' || i.kind === 'exam' ? i.sub : i.kind.includes('study') ? i.sub : '';
      const action = i.kind.startsWith('work')
        ? ` data-action="block" data-id="${i.id}" data-date="${i.date}" data-start="${i.start}"`
        : i.kind === 'mine'
          ? ` data-action="event" data-ev="${i.ev}" data-date="${i.date}"`
          : i.kind === 'tevent' || i.kind === 'exam'
            ? ` data-action="open" data-id="${i.id}"`
            : '';
      return { start: at(i.s), end: at(i.e), html, where, action, cls: i.kind.split(' ')[0], color: i.color };
    });
  const schedule = items.length
    ? `<ol class="schedule">${items
        .map(
          (it) => `<li class="${it.end < now ? 'past' : it.start <= now ? 'now' : ''} sched-${it.cls}"${it.color ? ` style="--c:${esc(it.color)}"` : ''}${it.action}>
            <span class="ev-time">${esc(fmtRange(it.start, it.end))}</span>
            <span class="ev-main">${it.html}${it.where ? `<span class="ev-where">${esc(it.where)}</span>` : ''}</span>
          </li>`,
        )
        .join('')}</ol><p class="foot"><a href="#day">Open the full day</a></p>`
    : empty(term?.phase === 'break' ? `Nothing scheduled: ${term.label}.` : 'Nothing scheduled today.');
  const scheduleCard = section("Today's schedule", schedule, { cls: 'o-4' });

  const big = open
    .filter((t) => t.type === 'exam' || t.type === 'essay' || estimateOf(t, state.settings) >= 240)
    .filter((t) => !t.due_at || (new Date(t.due_at) >= now && new Date(t.due_at) < addDays(now, 45)))
    .sort(byDue)
    .slice(0, 10);
  const coming = big.length
    ? `<ul class="countdowns">${big
        .map((t) => {
          const d = t.due_at ? new Date(t.due_at) : null;
          return `<li><button type="button" data-action="open" data-id="${t.id}">
            ${chip(courseById(t.course_id), { small: true })}
            <span class="cd-title">${esc(t.title)}</span>
            <span class="cd-when">${d ? esc(countdown(d, now)) : 'date TBA'}</span>
          </button></li>`;
        })
        .join('')}</ul>`
    : empty('No exams or big deadlines in the next few weeks.');
  const comingCard = section('Coming up', coming, { cls: 'o-7' });

  const termCard = term
    ? section(
        'Term',
        `<div class="term-bar" role="progressbar" aria-label="Term progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(term.progress * 100)}"><span style="width:${(term.progress * 100).toFixed(1)}%"></span></div>
        <ul class="term-facts">
          ${term.classesEndIn >= 0 ? `<li>Classes end <strong>${esc(fmtDate(term.classesEnd))}</strong> (${esc(countdown(term.classesEnd, now))})</li>` : ''}
          ${term.upcomingBreak ? `<li>${esc(term.upcomingBreak.label)} starts ${esc(countdown(parseYmd(term.upcomingBreak.start), now))}</li>` : ''}
          ${term.finalsStart && term.finalsIn >= 0 ? `<li>Finals ${esc(fmtDate(term.finalsStart, { weekday: false }))}${term.finalsEnd ? `–${term.finalsEnd.getDate()}` : ''} (${esc(countdown(term.finalsStart, now))})</li>` : ''}
          ${term.next?.start ? `<li>${esc(term.next.label || 'Next term')} starts ${esc(fmtDate(parseYmd(term.next.start), { weekday: false }))}</li>` : ''}
        </ul>`,
        { cls: 'o-8' },
      )
    : '';

  return `${head}
  <div class="today-grid">
    <div class="col">${aiCard()}${quick}${state.ask ? `<div class="o-0">${askResult()}</div>` : ''}${headsUp}${overdueCard}${todayCard}${plannedCard}${weekCard}${doneCard}${noDateCard}</div>
    <div class="col">${scheduleCard}${comingCard}${termCard}</div>
  </div>`;
}

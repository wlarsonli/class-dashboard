// Term progress, class meetings on a given day, and busy time from Outlook.
import { addDays, atTime, dayDiff, parseYmd, startOfDay, toMinutes, weekStart, ymd } from './dates.js';

export function breakOn(dateStr, settings) {
  for (const b of settings?.term?.breaks || []) {
    if (b.start && b.end && dateStr >= b.start && dateStr <= b.end) return b;
  }
  return null;
}

/** Week number, phase, and countdowns for the current term. */
export function termInfo(settings, now = new Date()) {
  const t = settings?.term;
  if (!t?.start || !(t.end || t.classes_end)) return null;
  const start = parseYmd(t.start);
  const classesEnd = parseYmd(t.classes_end || t.end);
  const end = parseYmd(t.end || t.classes_end);
  const today = startOfDay(now);

  // Week-long breaks that start on a Monday (like Thanksgiving) don't get a week number.
  const breakWeeks = (t.breaks || [])
    .filter((b) => b.start && b.end && parseYmd(b.start).getDay() === 1 && dayDiff(parseYmd(b.start), parseYmd(b.end)) >= 4)
    .map((b) => weekStart(parseYmd(b.start)));
  const rawWeek = (d) => Math.floor(dayDiff(weekStart(start), weekStart(d)) / 7) + 1;
  const week = (d) => rawWeek(d) - breakWeeks.filter((w) => w < weekStart(d)).length;
  const totalWeeks = week(classesEnd);

  const todayStr = ymd(today);
  const brk = breakOn(todayStr, settings);
  let phase;
  let label;
  if (today < start) {
    phase = 'before';
    label = `Starts in ${dayDiff(today, start)} days`;
  } else if (today > end) {
    phase = 'after';
    label = 'Term is over';
  } else if (t.finals_start && todayStr >= t.finals_start && todayStr <= (t.finals_end || t.end)) {
    phase = 'finals';
    label = 'Finals week';
  } else if (brk) {
    phase = 'break';
    label = brk.label || 'Break';
  } else if (today > classesEnd) {
    phase = 'reading';
    label = 'Classes are over';
  } else {
    phase = 'classes';
    label = `Week ${week(today)} of ${totalWeeks}`;
  }

  const upcomingBreak = (t.breaks || [])
    .filter((b) => b.start && b.start > todayStr)
    .sort((a, b) => (a.start < b.start ? -1 : 1))[0];

  return {
    phase,
    label,
    week: week(today),
    totalWeeks,
    progress: Math.min(1, Math.max(0, dayDiff(start, today) / Math.max(1, dayDiff(start, end)))),
    classesEnd,
    classesEndIn: dayDiff(today, classesEnd),
    finalsStart: t.finals_start ? parseYmd(t.finals_start) : null,
    finalsEnd: t.finals_end ? parseYmd(t.finals_end) : null,
    finalsIn: t.finals_start ? dayDiff(today, parseYmd(t.finals_start)) : null,
    end,
    endIn: dayDiff(today, end),
    upcomingBreak: upcomingBreak ? { ...upcomingBreak, in: dayDiff(today, parseYmd(upcomingBreak.start)) } : null,
    next: t.next_term || null,
  };
}

/** Class meetings on a date, with one-day changes (room moves, cancellations) applied. */
export function meetingsOn(dateStr, state) {
  if (breakOn(dateStr, state.settings)) return [];
  const dow = parseYmd(dateStr).getDay();
  const out = [];
  for (const m of state.meetings || []) {
    if (!m.days?.includes(dow)) continue;
    if (m.start_date && dateStr < m.start_date) continue;
    if (m.end_date && dateStr > m.end_date) continue;
    const ex = (m.exceptions || []).find((e) => e.date === dateStr);
    if (ex?.cancelled) continue;
    const course = (state.courses || []).find((c) => c.id === m.course_id);
    if (!course || course.archived) continue;
    out.push({
      meeting: m,
      course,
      start: atTime(dateStr, m.start_time),
      end: atTime(dateStr, m.end_time),
      location: ex?.location || m.location,
      note: ex?.note || '',
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Your own events on a date (weekly ones included), with one-day changes applied.
 * Each: { ev, date, start, end ('HH:MM'), s, e (minutes after midnight), title, weekly }
 */
export function eventsOn(dateStr, state) {
  const dow = parseYmd(dateStr).getDay();
  const out = [];
  for (const ev of state.events || []) {
    const weekly = (ev.days || []).length > 0;
    if (weekly) {
      if (dateStr < ev.date || (ev.until && dateStr > ev.until) || !ev.days.includes(dow) || (ev.skip || []).includes(dateStr)) continue;
    } else if (ev.date !== dateStr) continue;
    const change = ev.moved?.[dateStr];
    const start = change?.start || ev.start_time;
    const end = change?.end || ev.end_time;
    const s = toMinutes(start);
    let e = toMinutes(end);
    if (e <= s) e = 1440;
    out.push({ ev, date: dateStr, start, end, s, e, title: ev.title || 'Busy', weekly });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Outlook events overlapping a date. */
export function busyOn(dateStr, state) {
  const ds = parseYmd(dateStr);
  const de = addDays(ds, 1);
  return (state.busy || [])
    .filter((b) => new Date(b.starts_at) < de && new Date(b.ends_at) > ds)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
}

export function inClass(at, state) {
  return meetingsOn(ymd(at), state).some((x) => at >= x.start && at < x.end);
}

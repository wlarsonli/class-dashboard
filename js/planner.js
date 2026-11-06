// Suggests which days to work on each task ("do dates") and flags overloaded days.
//
// Each task gets a plan: [{ date: 'YYYY-MM-DD', minutes, pinned }]. Sessions you drag
// somewhere yourself are pinned, and re-planning leaves them alone.
import { addDays, dayDiff, fmtMinutes, parseYmd, startOfDay, ymd } from './dates.js';

export const DEFAULT_EST = { assignment: 120, essay: 120, reading: 60, exam: 180, task: 30, admin: 15, event: 0 };

// Outlook events that look like your own study blocks ("Math P-Set") don't count as busy time.
const STUDY = /\b(read|reading|pset|p-set|hw|homework|essay|paper|draft|study|prep|review|research|write|writing|problem|assignment|edfinity|annotation)\b/i;
export const isStudyBlock = (b) => STUDY.test(b.title || '');

export function estimateOf(t, settings) {
  if (t.estimate_minutes !== null && t.estimate_minutes !== undefined && t.estimate_minutes !== '') {
    return Number(t.estimate_minutes);
  }
  const d = { ...DEFAULT_EST, ...(settings?.default_estimates || {}) };
  return d[t.type] ?? 30;
}

/** Minutes of study time available on a day: your daily budget minus Outlook events (8 am–10 pm). */
export function makeCapacity(state, now = new Date()) {
  const cache = new Map();
  const todayStr = ymd(now);
  const cap = { weekday: 240, weekend: 300, ...(state.settings?.capacity || {}) };
  return (dateStr) => {
    if (cache.has(dateStr)) return cache.get(dateStr);
    const d = parseYmd(dateStr);
    let minutes = d.getDay() === 0 || d.getDay() === 6 ? cap.weekend : cap.weekday;
    const winStart = new Date(d);
    winStart.setHours(8, 0, 0, 0);
    const winEnd = new Date(d);
    winEnd.setHours(22, 0, 0, 0);
    for (const b of state.busy || []) {
      if (b.all_day || isStudyBlock(b)) continue;
      const s = Math.max(+new Date(b.starts_at), +winStart);
      const e = Math.min(+new Date(b.ends_at), +winEnd);
      if (e > s) minutes -= (e - s) / 60000;
    }
    if (dateStr === todayStr) minutes *= Math.min(1, Math.max(0, (+winEnd - +now) / (+winEnd - +winStart)));
    if (dateStr < todayStr) minutes = 0;
    const v = Math.max(0, Math.round(minutes));
    cache.set(dateStr, v);
    return v;
  };
}

export function loadByDay(tasks) {
  const map = {};
  for (const t of tasks) {
    if (t.hidden || t.status === 'done') continue;
    for (const s of t.plan || []) map[s.date] = (map[s.date] || 0) + (Number(s.minutes) || 0);
  }
  return map;
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const mins = (list) => list.reduce((a, s) => a + (Number(s.minutes) || 0), 0);

/**
 * mode 'fill': plan tasks that have nothing planned from today on.
 * mode 'rebalance': re-plan every upcoming task (or just `only`), keeping only pinned sessions.
 * Returns Map(taskId -> new plan).
 */
export function planTasks(state, { mode = 'fill', now = new Date(), horizon = 28, only = null } = {}) {
  const today = ymd(now);
  const todayDate = startOfDay(now);
  const capacity = makeCapacity(state, now);
  const load = {};
  const addLoad = (d, m) => {
    load[d] = (load[d] || 0) + m;
  };
  const changes = new Map();
  const work = [];

  for (const t of state.tasks || []) {
    if (t.hidden || t.status === 'done') continue;
    const plan = t.plan || [];
    const due = t.due_at ? new Date(t.due_at) : null;
    const plannable = !!due && t.type !== 'event' && due >= now && dayDiff(todayDate, due) <= horizon;
    const past = plan.filter((s) => s.date < today);
    const future = plan.filter((s) => s.date >= today);
    const target = !only || t.id === only; // `only`: re-plan one task, treat the rest as fixed
    const keep = mode === 'rebalance' && plannable && target ? future.filter((s) => s.pinned) : future;
    keep.forEach((s) => addLoad(s.date, Number(s.minutes) || 0));
    if (!plannable || !target) continue;
    if (mode === 'fill' && future.length) continue;
    const est = estimateOf(t, state.settings);
    if (est <= 0) continue;
    const subs = t.subtasks || [];
    const doneFrac = subs.length ? subs.filter((s) => s.done).length / subs.length : 0;
    let remaining = Math.round(est * (1 - doneFrac)) - mins(past) - mins(keep);
    if (remaining <= 0) {
      if (keep.length) {
        if (mode === 'rebalance') changes.set(t.id, [...past, ...keep].sort(byDate));
        continue;
      }
      remaining = 30; // the planned time is used up but it isn't done: one finishing session
    }
    work.push({ t, due, past, keep, remaining: Math.max(15, Math.round(remaining / 15) * 15) });
  }

  work.sort((a, b) => a.due - b.due || (b.t.priority || 0) - (a.t.priority || 0));

  for (const w of work) {
    const { t, due } = w;
    const dueMin = due.getHours() * 60 + due.getMinutes();
    const isExam = t.type === 'exam';
    let last = ymd(due);
    // Morning deadlines and daytime exams: finish the day before. Bigger work also gets a buffer day.
    if (isExam ? dueMin < 17 * 60 : dueMin <= 12 * 60) last = ymd(addDays(due, -1));
    else if (!isExam && w.remaining >= 150 && dayDiff(todayDate, due) >= 2) last = ymd(addDays(due, -1));
    if (last < today) last = today;
    const span = isExam ? 5 : w.remaining <= 60 ? 3 : w.remaining <= 180 ? 5 : w.remaining <= 300 ? 8 : 12;
    let first = ymd(addDays(parseYmd(last), -(span - 1)));
    if (first < today) first = today;
    const days = [];
    for (let d = parseYmd(first); ymd(d) <= last; d = addDays(d, 1)) days.push(ymd(d));

    const maxSession = t.type === 'reading' ? 90 : 120;
    const n = Math.min(days.length * 2, Math.max(1, Math.ceil(w.remaining / maxSession)));
    const size = Math.max(15, Math.ceil(w.remaining / n / 15) * 15);
    const used = new Set(w.keep.map((s) => s.date));
    const added = [];
    for (let k = 0; k < n; k++) {
      const pool = days.filter((d) => !used.has(d));
      const candidates = pool.length ? pool : days;
      // Earliest day in the window that still has room, so work gets done ahead of the deadline.
      let best = candidates.find((d) => (load[d] || 0) + size <= capacity(d));
      if (!best) {
        // Nothing has room: use the least-overloaded day (this shows up as a heads-up warning).
        let bestFree = -Infinity;
        for (const d of candidates) {
          const free = capacity(d) - (load[d] || 0) - size;
          if (free > bestFree) {
            best = d;
            bestFree = free;
          }
        }
      }
      const existing = added.find((s) => s.date === best);
      if (existing) existing.minutes += size;
      else added.push({ date: best, minutes: size, pinned: false });
      used.add(best);
      addLoad(best, size);
    }
    changes.set(t.id, [...w.past, ...w.keep, ...added].sort(byDate));
  }
  return changes;
}

/**
 * Days in the next two weeks that need a heads-up: too many deadlines at once,
 * or more planned work than that day's study time (after Outlook events).
 */
export function workloadWarnings(state, { now = new Date(), days = 14 } = {}) {
  const wl = { deadlines: 3, ...(state.settings?.workload || {}) };
  const load = loadByDay(state.tasks || []);
  const fullDay = makeCapacity(state, startOfDay(now)); // today's whole-day budget, not what's left of it
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = ymd(addDays(now, i));
    const due = (state.tasks || []).filter(
      (t) => !t.hidden && t.status !== 'done' && t.due_at && t.type !== 'reading' && t.type !== 'event' && ymd(new Date(t.due_at)) === d,
    );
    const planned = load[d] || 0;
    const cap = fullDay(d);
    const reasons = [];
    if (due.length >= wl.deadlines) reasons.push(`${due.length} deadlines`);
    if (planned > cap + 30) reasons.push(`${fmtMinutes(planned)} of work planned, about ${fmtMinutes(cap)} free`);
    if (reasons.length) out.push({ date: d, reasons, planned, due });
  }
  return out;
}

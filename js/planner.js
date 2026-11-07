// The planner: decides when to work on each task.
//
// Step 1 picks the days. Each task's time is spread over the days before its deadline,
// within your study time per day.
// Step 2 picks the times. Each day's work is fitted into free time around your classes, exams,
// and Outlook events, with short breaks between blocks.
//
// A task's plan is a list of work blocks: { date, minutes, start?, pinned?, fixed?, unscheduled? }
//   pinned:      you chose the day, so re-planning keeps the block on that day
//   fixed:       you chose the time too
//   unscheduled: it didn't fit into that day's free time
// Exams get a study plan instead of one estimate: a set amount every day until the exam.
import { addDays, dayDiff, fmtMinutes, parseYmd, startOfDay, toMinutes, ymd } from './dates.js';
import { courseAliases } from './quickadd.js';
import { eventsOn, meetingsOn } from './term.js';

export const DEFAULT_EST = { assignment: 120, essay: 120, reading: 60, exam: 180, task: 30, admin: 15, event: 0 };
export const DEFAULT_PREP = { final: { daily: 120, days: 7 }, midterm: { daily: 120, days: 5 }, quiz: { daily: 60, days: 3 } };
export const DEFAULT_WINDOW = { start: '08:00', end: '23:00', weekend_start: '10:00' };

const BREAK = 15; // minutes between work blocks
const LONG_BREAK = 30; // after a block of 90 minutes or more
const breakAfter = (len) => (len >= 90 ? LONG_BREAK : BREAK);
const CLASS_BUFFER = 10; // time to get to and from class
const EXAM_BUFFER = 15;
const MAX_BLOCK = 120;
const MIN_BLOCK = 30;

const pad = (n) => String(n).padStart(2, '0');
export const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const minsOf = (d) => d.getHours() * 60 + d.getMinutes();
const total = (list) => list.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
export const byBlock = (a, b) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start || '99') < (b.start || '99') ? -1 : (a.start || '99') > (b.start || '99') ? 1 : 0;
const byDue = (a, b) =>
  (a.due_at || '9999') < (b.due_at || '9999') ? -1 : (a.due_at || '9999') > (b.due_at || '9999') ? 1 : (b.priority || 0) - (a.priority || 0);

// Outlook events that look like study time ("Math P-Set", "Huma reading").
const STUDY = /\b(read|reading|pset|p-set|hw|homework|essay|paper|draft|study|prep|review|research|write|writing|problem|assignment|edfinity|annotation)\b/i;
export const isStudyBlock = (b) => STUDY.test(b.title || '');

/** The most work you want on a day, if you set one ("only 2 hours tomorrow"). 0 means a day off. */
export function dayLimit(state, dateStr) {
  const v = state.settings?.day_limits?.[dateStr];
  return v === undefined || v === null || v === '' ? null : Number(v);
}

// ---------- Estimates and exam study plans ----------

export function examKind(t) {
  if (/\bfinal\b/i.test(t.title || '') || (t.duration_minutes || 0) >= 100) return 'final';
  if (/\bmidterm\b/i.test(t.title || '')) return 'midterm';
  return 'quiz';
}

/** For an exam: how much to study per day, and from which day through which day. */
export function studyPlanOf(t, settings) {
  if (t.type !== 'exam' || !t.due_at) return null;
  const due = new Date(t.due_at);
  // Daytime exams: last study day is the day before. Evening exams: you can study that day.
  const last = minsOf(due) < 17 * 60 ? ymd(addDays(due, -1)) : ymd(due);
  const prep = { ...DEFAULT_PREP, ...(settings?.exam_prep || {}) }[examKind(t)] || DEFAULT_PREP.quiz;
  const daily = Number(t.study?.daily ?? prep.daily) || 0;
  let start = t.study?.start || ymd(addDays(parseYmd(last), -((prep.days || 1) - 1)));
  if (start > last) start = last;
  return { daily, start, last, skip: t.study?.skip || [], custom: !!t.study };
}

export function studyDays(plan, from) {
  const out = [];
  for (let d = parseYmd(plan.start > from ? plan.start : from); ymd(d) <= plan.last; d = addDays(d, 1)) {
    if (!plan.skip.includes(ymd(d))) out.push(ymd(d));
  }
  return out;
}

export function estimateOf(t, settings) {
  const study = studyPlanOf(t, settings);
  if (study) return study.daily * studyDays(study, study.start).length;
  if (t.estimate_minutes !== null && t.estimate_minutes !== undefined && t.estimate_minutes !== '') return Number(t.estimate_minutes);
  const d = { ...DEFAULT_EST, ...(settings?.default_estimates || {}) };
  return d[t.type] ?? 30;
}

// ---------- Free time ----------

/** Busy stretches of a day in minutes after midnight: classes, your events, Outlook events, exams. */
export function busyIntervals(dateStr, state) {
  const out = [];
  for (const m of meetingsOn(dateStr, state)) out.push({ s: minsOf(m.start) - CLASS_BUFFER, e: minsOf(m.end) + CLASS_BUFFER });
  for (const o of eventsOn(dateStr, state)) out.push({ s: o.s, e: o.e });
  const d0 = parseYmd(dateStr);
  const d1 = addDays(d0, 1);
  for (const b of state.busy || []) {
    if (b.all_day) continue;
    const s = new Date(b.starts_at);
    const e = new Date(b.ends_at);
    if (s >= d1 || e <= d0) continue;
    out.push({ s: s < d0 ? 0 : minsOf(s), e: e >= d1 ? 1440 : minsOf(e) });
  }
  for (const t of state.tasks || []) {
    if (t.hidden || !t.due_at || (t.type !== 'exam' && t.type !== 'event')) continue;
    const s = new Date(t.due_at);
    if (ymd(s) !== dateStr) continue;
    out.push({ s: minsOf(s) - EXAM_BUFFER, e: minsOf(s) + (t.duration_minutes || 60) + EXAM_BUFFER });
  }
  return out;
}

/** Free stretches [start, end] (minutes) inside your study hours, after now if it's today. */
export function freeGaps(dateStr, state, { now = new Date(), extra = [] } = {}) {
  const today = ymd(now);
  if (dateStr < today) return [];
  const win = { ...DEFAULT_WINDOW, ...(state.settings?.study_window || {}) };
  const dow = parseYmd(dateStr).getDay();
  let ws = toMinutes((dow === 0 || dow === 6) && win.weekend_start ? win.weekend_start : win.start);
  let we = toMinutes(win.end);
  if (we <= ws) we = 1440;
  if (dateStr === today) ws = Math.max(ws, Math.ceil((minsOf(now) + 5) / 15) * 15);
  const busy = [...busyIntervals(dateStr, state), ...extra]
    .map((b) => ({ s: Math.max(ws, b.s), e: Math.min(we, b.e) }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
  const gaps = [];
  let cur = ws;
  for (const b of busy) {
    if (b.s > cur) gaps.push([cur, b.s]);
    cur = Math.max(cur, b.e);
  }
  if (we > cur) gaps.push([cur, we]);
  return gaps;
}

/**
 * Minutes of work a day can take: your study time for that day (minus study blocks you put in
 * Outlook yourself), but never more than the free time that's actually left.
 */
export function makeCapacity(state, now = new Date()) {
  const cache = new Map();
  const today = ymd(now);
  const cap = { weekday: 240, weekend: 300, ...(state.settings?.capacity || {}) };
  const ownStudy = new Map();
  for (const b of state.busy || []) {
    if (b.all_day || !isStudyBlock(b)) continue;
    const s = new Date(b.starts_at);
    ownStudy.set(ymd(s), (ownStudy.get(ymd(s)) || 0) + (new Date(b.ends_at) - s) / 60000);
  }
  return (dateStr) => {
    if (cache.has(dateStr)) return cache.get(dateStr);
    let v = 0;
    if (dateStr >= today) {
      const dow = parseYmd(dateStr).getDay();
      const limit = dayLimit(state, dateStr);
      const budget = (limit ?? (dow === 0 || dow === 6 ? cap.weekend : cap.weekday)) - (ownStudy.get(dateStr) || 0);
      const usable = freeGaps(dateStr, state, { now }).reduce((a, [s, e]) => a + (e - s >= MIN_BLOCK ? e - s - BREAK : 0), 0);
      v = Math.max(0, Math.round(Math.min(budget, usable)));
    }
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

// ---------- Outlook study blocks ----------

/**
 * Study blocks you made in Outlook ("Math P-Set", "Huma reading") count as work on that class's
 * next task, so the planner doesn't book the same work twice. Returns Map(taskId -> blocks).
 */
export function outlookStudy(state, now = new Date()) {
  const out = new Map();
  const from = startOfDay(now);
  const courses = (state.courses || []).filter((c) => !c.archived).map((c) => [c, courseAliases(c)]);
  const open = (state.tasks || []).filter((t) => !t.hidden && t.status !== 'done' && t.due_at);
  for (const b of state.busy || []) {
    if (b.all_day || !isStudyBlock(b)) continue;
    const s = new Date(b.starts_at);
    if (s < from) continue;
    const words = (b.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hit = courses.find(([, al]) => words.some((w) => al.has(w)));
    if (!hit) continue;
    const mine = open.filter((t) => t.course_id === hit[0].id && new Date(t.due_at) > s).sort(byDue);
    const examish = /\b(prep|study|review|exam|midterm|final|quiz)\b/i.test(b.title || '');
    const task =
      (examish && mine.find((t) => t.type === 'exam' && dayDiff(s, new Date(t.due_at)) <= 14)) ||
      mine.find((t) => t.type !== 'exam' && t.type !== 'event') ||
      mine[0];
    if (!task) continue;
    const list = out.get(task.id) || [];
    list.push({ date: ymd(s), minutes: Math.round((new Date(b.ends_at) - s) / 60000), start: hm(minsOf(s)), title: b.title, uid: b.uid || String(b.id) });
    out.set(task.id, list);
  }
  return out;
}

// ---------- Step 1: which days ----------

/**
 * mode 'fill': add work wherever a task has less planned than it needs.
 * mode 'rebalance': re-plan every upcoming task (or just `only`), keeping only pinned blocks.
 * Returns Map(taskId -> new plan).
 */
export function planTasks(state, { mode = 'fill', now = new Date(), horizon = 28, only = null } = {}) {
  const today = ymd(now);
  const todayDate = startOfDay(now);
  const capacity = makeCapacity(state, now);
  const fromOutlook = outlookStudy(state, now);
  const load = {};
  const addLoad = (d, m) => {
    load[d] = (load[d] || 0) + (Number(m) || 0);
  };
  const changes = new Map();
  const work = [];
  const exams = [];

  for (const t of state.tasks || []) {
    if (t.hidden || t.status === 'done') continue;
    const plan = t.plan || [];
    const due = t.due_at ? new Date(t.due_at) : null;
    const study = studyPlanOf(t, state.settings);
    const plannable = !!due && t.type !== 'event' && due >= now && (study ? true : dayDiff(todayDate, due) <= horizon);
    const target = !only || t.id === only; // `only`: re-plan one task, treat the rest as fixed
    const past = plan.filter((s) => s.date < today);
    const future = plan.filter((s) => s.date >= today);
    if (study && plannable && target) {
      exams.push({ t, study, past, future });
      continue;
    }
    const keep = mode === 'rebalance' && plannable && target ? future.filter((s) => s.pinned) : future;
    keep.forEach((s) => addLoad(s.date, s.minutes));
    if (!plannable || !target) continue;
    const est = estimateOf(t, state.settings);
    if (est <= 0) continue;
    const subs = t.subtasks || [];
    const doneFrac = subs.length ? subs.filter((s) => s.done).length / subs.length : 0;
    const outlookMin = total(fromOutlook.get(t.id) || []);
    const needed = Math.round(est * (1 - doneFrac)) - total(past) - outlookMin;
    let deficit = needed - total(keep);
    if (deficit < 15) {
      const usedUp = needed <= 0 && !keep.length && past.length > 0 && !outlookMin;
      if (!usedUp) {
        if (mode === 'rebalance') changes.set(t.id, [...past, ...keep].sort(byBlock));
        continue;
      }
      deficit = 30; // the planned time is used up but it isn't done: one finishing session
    }
    work.push({ t, due, past, keep, remaining: Math.max(15, Math.round(deficit / 15) * 15) });
  }

  // Exams: the same amount every study day. Blocks you placed yourself stay; the rest follow the plan.
  // On a day with a limit ("only 2 hours"), the nearest exam gets its study first.
  const limitLeft = {};
  const roomOn = (d) => {
    const limit = dayLimit(state, d);
    return limit === null ? Infinity : (limitLeft[d] ??= limit);
  };
  exams.sort((a, b) => new Date(a.t.due_at) - new Date(b.t.due_at));
  for (const { t, study, past, future } of exams) {
    const days = studyDays(study, today);
    const pinned = future.filter((s) => s.pinned);
    const out = [...past];
    for (const d of days) {
      const mine = pinned.filter((s) => s.date === d);
      if (mine.length) {
        out.push(...mine);
        if (roomOn(d) !== Infinity) limitLeft[d] -= total(mine);
        continue;
      }
      const room = roomOn(d); // a day off or a light day you asked for
      if (room <= 0) continue;
      const minutes = Math.min(room, study.daily) - total((fromOutlook.get(t.id) || []).filter((v) => v.date === d));
      if (minutes < 15) continue;
      if (room !== Infinity) limitLeft[d] -= minutes;
      const existing = future.filter((s) => s.date === d && !s.pinned);
      if (existing.length && total(existing) === minutes) out.push(...existing); // keeps their times stable
      else out.push({ date: d, minutes, pinned: false });
    }
    for (const s of pinned) if (!days.includes(s.date)) out.push(s);
    out.filter((s) => s.date >= today).forEach((s) => addLoad(s.date, s.minutes));
    changes.set(t.id, out.sort(byBlock));
  }

  work.sort((a, b) => a.due - b.due || (b.t.priority || 0) - (a.t.priority || 0));

  for (const w of work) {
    const { t, due } = w;
    const dueMin = minsOf(due);
    let last = ymd(due);
    // Morning deadlines: finish the day before. Bigger work also gets a buffer day.
    if (dueMin <= 12 * 60) last = ymd(addDays(due, -1));
    else if (w.remaining >= 150 && dayDiff(todayDate, due) >= 2) last = ymd(addDays(due, -1));
    if (last < today) last = today;
    const span = w.remaining <= 60 ? 3 : w.remaining <= 180 ? 5 : w.remaining <= 300 ? 8 : 12;
    let first = ymd(addDays(parseYmd(last), -(span - 1)));
    if (first < today) first = today;
    const days = [];
    for (let d = parseYmd(first); ymd(d) <= last; d = addDays(d, 1)) days.push(ymd(d));

    const maxSession = t.type === 'reading' ? 90 : MAX_BLOCK;
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
        // Nothing has room: use the least-overloaded day (this shows up as a heads-up).
        let bestFree = -Infinity;
        for (const d of candidates) {
          const free = capacity(d) - (load[d] || 0) - size;
          if (free > bestFree) {
            best = d;
            bestFree = free;
          }
        }
      }
      const same = added.find((s) => s.date === best);
      if (same) same.minutes += size;
      else added.push({ date: best, minutes: size, pinned: false });
      used.add(best);
      addLoad(best, size);
    }
    changes.set(t.id, [...w.past, ...w.keep, ...added].sort(byBlock));
  }
  return changes;
}

// ---------- Step 2: which times ----------

/**
 * Gives each day's work blocks start times inside the free gaps (earliest first, the most urgent
 * task first). Blocks you fixed yourself, and blocks already under way today, don't move.
 * Returns the minutes that didn't fit (dropped when dropOverflow, so step 1 can move them).
 */
export function scheduleDays(state, plans, now = new Date(), { dropOverflow = true } = {}) {
  const today = ymd(now);
  const nowMin = minsOf(now);
  const tasks = new Map((state.tasks || []).map((t) => [t.id, t]));
  const live = (id) => {
    const t = tasks.get(id);
    return t && !t.hidden && t.status !== 'done' ? t : null;
  };
  const days = new Set();
  for (const [id, plan] of plans) if (live(id)) for (const s of plan) if (s.date >= today) days.add(s.date);
  let overflow = 0;

  for (const d of [...days].sort()) {
    const isFixed = (s) => !!s.start && !s.unscheduled && (s.fixed || (d === today && toMinutes(s.start) <= nowMin + 5));
    const entries = [];
    for (const [id, plan] of plans) if (live(id)) for (const s of plan) if (s.date === d) entries.push({ id, s });
    const movable = entries.filter((e) => !isFixed(e.s));
    if (!movable.length) continue;
    const fixed = entries
      .filter((e) => isFixed(e.s))
      .map((e) => ({ s: toMinutes(e.s.start), e: toMinutes(e.s.start) + Number(e.s.minutes) + breakAfter(Number(e.s.minutes)) }));
    let gaps = dayLimit(state, d) === 0 ? [] : freeGaps(d, state, { now, extra: fixed }); // nothing goes on a day off

    const pools = new Map();
    for (const e of movable) {
      const p = pools.get(e.id) || { t: tasks.get(e.id), minutes: 0, pinned: false };
      p.minutes += Number(e.s.minutes) || 0;
      p.pinned = p.pinned || !!e.s.pinned;
      pools.set(e.id, p);
    }
    for (const id of pools.keys()) plans.set(id, plans.get(id).filter((s) => !(s.date === d && !isFixed(s))));

    for (const [id, p] of [...pools.entries()].sort((a, b) => byDue(a[1].t, b[1].t))) {
      // Work has to finish before a deadline (or exam) that falls on this day.
      const due = p.t.due_at ? new Date(p.t.due_at) : null;
      const limit = due && ymd(due) === d ? minsOf(due) - 15 : 1440;
      const room = (g) => Math.min(g[1], limit) - g[0];
      let need = p.minutes;
      while (need >= 15) {
        const want = Math.min(need, MAX_BLOCK);
        const g = gaps.find((x) => room(x) >= want) || gaps.find((x) => room(x) >= Math.min(MIN_BLOCK, want));
        if (!g) break;
        const len = Math.min(want, room(g));
        plans.get(id).push({ date: d, minutes: len, start: hm(g[0]), pinned: p.pinned });
        g[0] += len + breakAfter(len);
        gaps = gaps.filter((x) => x[1] - x[0] >= 15);
        need -= len;
      }
      if (need >= 15) {
        if (dropOverflow && !p.pinned) overflow += need;
        else plans.get(id).push({ date: d, minutes: need, pinned: p.pinned, unscheduled: true });
      }
    }
  }
  for (const plan of plans.values()) plan.sort(byBlock);
  return overflow;
}

/** Steps 1 and 2 together. Returns Map(taskId -> new plan) for the tasks whose plan changed. */
export function planAndSchedule(state, { mode = 'fill', now = new Date(), only = null } = {}) {
  const plans = new Map((state.tasks || []).map((t) => [t.id, (t.plan || []).map((s) => ({ ...s }))]));
  const view = () => ({ ...state, tasks: (state.tasks || []).map((t) => ({ ...t, plan: plans.get(t.id) })) });
  // Blocks that didn't fit last time get another chance.
  for (const [id, plan] of plans) plans.set(id, plan.map((s) => (s.unscheduled ? { date: s.date, minutes: s.minutes, pinned: s.pinned } : s)));
  for (const [id, p] of planTasks(view(), { mode, now, only })) plans.set(id, p);
  for (let round = 0; round < 3; round++) {
    if (!scheduleDays(view(), plans, now)) break;
    for (const [id, p] of planTasks(view(), { mode: 'fill', now })) plans.set(id, p);
  }
  scheduleDays(view(), plans, now, { dropOverflow: false });
  const changes = new Map();
  for (const t of state.tasks || []) {
    const p = plans.get(t.id);
    if (JSON.stringify(p) !== JSON.stringify(t.plan || [])) changes.set(t.id, p);
  }
  return changes;
}

// ---------- Warnings ----------

/**
 * Days in the next two weeks that need a heads-up: too many deadlines at once,
 * more planned work than that day's study time, or work that didn't fit.
 */
export function workloadWarnings(state, { now = new Date(), days = 14 } = {}) {
  const wl = { deadlines: 3, ...(state.settings?.workload || {}) };
  const load = loadByDay(state.tasks || []);
  const fullDay = makeCapacity(state, startOfDay(now)); // today's whole-day budget, not what's left of it
  const unscheduled = {};
  for (const t of state.tasks || []) {
    if (t.hidden || t.status === 'done') continue;
    for (const s of t.plan || []) if (s.unscheduled) unscheduled[s.date] = (unscheduled[s.date] || 0) + s.minutes;
  }
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
    if (unscheduled[d]) reasons.push(`${fmtMinutes(unscheduled[d])} of work doesn't fit`);
    else if (planned > cap + 30) reasons.push(`${fmtMinutes(planned)} of work planned, about ${fmtMinutes(cap)} free`);
    if (reasons.length) out.push({ date: d, reasons, planned, due });
  }
  return out;
}

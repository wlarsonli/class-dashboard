// App state and every action that changes data.
import { freeTimeOn } from './command.js';
import { addDays, atTime, fmtDate, fmtHM, fmtMinutes, fmtRange, hhmm, parseYmd, relDay, toMinutes, ymd } from './dates.js';
import { byBlock, planAndSchedule } from './planner.js';
import { parseQuickAdd } from './quickadd.js';
import { createStore, defaultSettings, mergeSettings, row } from './store.js';
import { busyOn, eventsOn, meetingsOn } from './term.js';
import { clone, download, toast, uid } from './util.js';

export const store = createStore();

export const state = {
  courses: [],
  meetings: [],
  tasks: [],
  busy: [],
  events: [],
  settings: defaultSettings(),
  integrations: {},
  ready: false,
  offline: false,
  view: 'today',
  weekOffset: 0,
  dayOffset: 0,
  filter: { q: '', course: '', status: 'open', type: '' },
  ask: null, // what the last typed plan change did: { ok, title, lines, moved, snap }
};

let renderFn = () => {};
export const onRender = (fn) => {
  renderFn = fn;
};
export const rerender = () => renderFn();

export const courseById = (id) => state.courses.find((c) => c.id === id) || null;
export const taskById = (id) => state.tasks.find((t) => t.id === id) || null;
export const eventById = (id) => state.events.find((e) => e.id === id) || null;
export const liveTasks = () => state.tasks.filter((t) => !t.hidden);
export const openTasks = () => state.tasks.filter((t) => !t.hidden && t.status !== 'done');

const upsertLocal = (arr, item) => {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item;
  else arr.push(item);
};
const SNAP_KEY = 'class-dashboard:snapshot:v1';
const PLANNER_VERSION = 2; // bump to re-plan everything once after the planner changes

export async function refresh({ silent = false } = {}) {
  try {
    const data = await store.load();
    Object.assign(state, data, { offline: false });
    if (store.mode === 'cloud') {
      try {
        localStorage.setItem(SNAP_KEY, JSON.stringify(data));
      } catch {
        /* storage full: skip the offline copy */
      }
    }
  } catch (err) {
    console.error(err);
    const snap = store.mode === 'cloud' ? localStorage.getItem(SNAP_KEY) : null;
    if (snap) Object.assign(state, JSON.parse(snap), { offline: true });
    if (!silent) toast(snap ? "You're offline. Showing your last saved copy." : `Couldn't load your data: ${err.message || err}`);
  }
  state.ready = true;
  if (!state.offline && (state.settings.planner_version || 0) < PLANNER_VERSION && state.tasks.length) {
    // The planner changed: re-plan everything once (blocks you placed yourself stay put).
    await autoPlan('rebalance');
    state.settings = mergeSettings({ ...state.settings, planner_version: PLANNER_VERSION });
    await persist(() => store.saveSettings(state.settings));
  } else {
    await autoPlan();
  }
  rerender();
}

/** Pulls fresh Canvas and Outlook data if the last sync is more than 15 minutes old. */
export async function syncIfStale() {
  if (store.mode !== 'cloud' || state.offline) return;
  const last = state.integrations?.last_sync_at ? new Date(state.integrations.last_sync_at) : null;
  if (!(state.integrations?.canvas_feed_url || state.integrations?.outlook_feed_url)) return;
  if (last && Date.now() - last < 15 * 60000) return;
  try {
    await store.invoke('sync', {});
    await refresh({ silent: true });
  } catch (err) {
    console.warn('Background sync failed', err);
  }
}

async function persist(fn) {
  if (state.offline) {
    toast("You're offline, so this change wasn't saved.");
    return false;
  }
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(err);
    toast(`Couldn't save: ${err.message || err}`);
    return false;
  }
}

/**
 * Picks days and times for work ('fill' adds what's missing and re-fits the times around
 * anything new; 'rebalance' re-plans everything that isn't pinned).
 */
export async function autoPlan(mode = 'fill', { only = null } = {}) {
  const changes = planAndSchedule(state, { mode, only });
  const updated = [];
  for (const [id, plan] of changes) {
    const t = taskById(id);
    if (t && JSON.stringify(t.plan || []) !== JSON.stringify(plan)) {
      t.plan = plan;
      updated.push(t);
    }
  }
  if (updated.length && !state.offline) {
    try {
      await store.saveTasks(updated);
    } catch (err) {
      console.error(err);
    }
  }
  return updated.length;
}

export const newTask = (fields = {}) => row('tasks', { id: uid(), ...fields });

export async function saveTask(task) {
  const prev = task.id ? taskById(task.id) : null;
  const t = row('tasks', { ...task, id: task.id || uid(), title: (task.title || '').trim() || 'Untitled task' });
  // A new due date, estimate, or study plan means the old suggested plan is stale (your own pinned blocks stay).
  if (prev && (prev.due_at !== t.due_at || prev.estimate_minutes !== t.estimate_minutes || JSON.stringify(prev.study) !== JSON.stringify(t.study))) {
    const today = ymd(new Date());
    t.plan = (t.plan || []).filter((s) => s.pinned || s.date < today);
  }
  upsertLocal(state.tasks, t);
  await persist(() => store.saveTasks([t]));
  await autoPlan();
  rerender();
  return t;
}

export async function saveTasks(tasks) {
  const rows = tasks.map((t) => row('tasks', t));
  rows.forEach((t) => upsertLocal(state.tasks, t));
  await persist(() => store.saveTasks(rows));
  await autoPlan();
  rerender();
}

export async function toggleDone(id) {
  const t = taskById(id);
  if (!t) return;
  const wasDone = t.status === 'done';
  t.status = wasDone ? 'todo' : 'done';
  t.done_at = wasDone ? null : new Date().toISOString();
  await persist(() => store.saveTasks([t]));
  await autoPlan();
  rerender();
  if (!wasDone) toast(`Done: ${t.title}`, { action: 'Undo', onAction: () => toggleDone(id) });
}

export async function deleteTask(id, { series = false } = {}) {
  const t = taskById(id);
  if (!t) return;
  let victims = [t];
  if (series && t.series_id) {
    victims = state.tasks.filter(
      (x) => x.series_id === t.series_id && x.status !== 'done' && (x.id === t.id || (x.due_at || '') >= (t.due_at || '')),
    );
  }
  // Canvas items are hidden rather than deleted, so the next Canvas sync doesn't bring them back.
  const hide = victims.filter((x) => x.external_uid);
  const del = victims.filter((x) => !x.external_uid);
  hide.forEach((x) => {
    x.hidden = true;
  });
  state.tasks = state.tasks.filter((x) => !del.includes(x));
  await persist(async () => {
    if (hide.length) await store.saveTasks(hide);
    if (del.length) await store.deleteTasks(del.map((x) => x.id));
  });
  rerender();
  toast(victims.length > 1 ? `Deleted ${victims.length} tasks` : `Deleted: ${t.title}`);
}

/** Creates one task per matching weekday from the first due date through `until`. */
export async function createSeries(base, { days, until }) {
  const first = new Date(base.due_at);
  const time = hhmm(first);
  const series_id = base.series_id || uid();
  const repeat = { freq: 'weekly', days, until, time };
  const out = [];
  for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); ymd(d) <= until; d = addDays(d, 1)) {
    if (!days.includes(d.getDay())) continue;
    const due = atTime(ymd(d), time);
    if (due < first) continue;
    out.push(
      row('tasks', {
        ...clone(base),
        id: !out.length && base.id ? base.id : uid(),
        due_at: due.toISOString(),
        series_id,
        repeat,
        plan: [],
        status: 'todo',
        done_at: null,
        subtasks: (base.subtasks || []).map((s) => ({ ...s, id: uid(), done: false })),
      }),
    );
  }
  if (!out.length) out.push(row('tasks', { ...base, id: base.id || uid(), series_id, repeat }));
  out.forEach((t) => upsertLocal(state.tasks, t));
  await persist(() => store.saveTasks(out));
  await autoPlan();
  rerender();
  toast(out.length > 1 ? `Added ${out.length} repeating tasks` : 'Task saved');
}

const SERIES_FIELDS = ['title', 'course_id', 'type', 'estimate_minutes', 'priority', 'notes', 'links', 'location', 'duration_minutes'];

/** Saves a task and copies its details (and time of day) to the later tasks in its series. */
export async function saveSeriesFrom(task) {
  const t = await saveTask(task);
  if (!t.series_id || !t.due_at) return t;
  const time = hhmm(new Date(t.due_at));
  const later = state.tasks.filter(
    (x) => x.series_id === t.series_id && x.id !== t.id && x.status !== 'done' && x.due_at && x.due_at > t.due_at,
  );
  for (const s of later) {
    for (const k of SERIES_FIELDS) s[k] = clone(t[k]);
    s.due_at = atTime(ymd(new Date(s.due_at)), time).toISOString();
  }
  await persist(() => store.saveTasks(later));
  await autoPlan();
  rerender();
  return t;
}

export async function quickAdd(text) {
  const p = parseQuickAdd(text, state.courses);
  if (!p.title && !p.due_at) return null;
  return saveTask({
    title: p.title || 'New task',
    course_id: p.course_id,
    due_at: p.due_at,
    estimate_minutes: p.estimate_minutes,
    priority: p.priority,
    type: p.type,
    duration_minutes: p.type === 'exam' ? 60 : null,
    source: 'quickadd',
  });
}

async function savePlan(t, plan) {
  t.plan = plan.sort(byBlock);
  await persist(() => store.saveTasks([t]));
  await autoPlan(); // re-fits the times around the change
  rerender();
}

/** Week view: moves a task's work on one day to another day (the planner picks the time). */
export async function moveSession(taskId, fromDate, toDate) {
  const t = taskById(taskId);
  if (!t || fromDate === toDate) return;
  const moving = (t.plan || []).filter((s) => s.date === fromDate);
  if (!moving.length) return;
  const rest = (t.plan || []).filter((s) => s.date !== fromDate);
  const minutes = moving.reduce((a, s) => a + s.minutes, 0);
  await savePlan(t, [...rest, { date: toDate, minutes, pinned: true }]);
}

/** Day view: moves one block to another time and/or day. With a time it's fixed there. */
export async function moveBlock(taskId, date, start, { toDate = date, toStart = null } = {}) {
  const t = taskById(taskId);
  if (!t) return;
  const plan = (t.plan || []).map((s) => ({ ...s }));
  const b = plan.find((s) => s.date === date && (s.start || null) === (start || null));
  if (!b) return;
  b.date = toDate;
  b.pinned = true;
  b.unscheduled = false;
  if (toStart) {
    b.start = toStart;
    b.fixed = true;
  } else {
    delete b.start;
    b.fixed = false;
  }
  await savePlan(t, plan);
}

/** Lets the planner choose this block's time again (undoes a time you set yourself). */
export async function unfixBlock(taskId, date, start) {
  const t = taskById(taskId);
  if (!t) return;
  const plan = (t.plan || []).map((s) => (s.date === date && s.start === start ? { date: s.date, minutes: s.minutes, pinned: s.pinned } : { ...s }));
  await savePlan(t, plan);
}

/**
 * Removes one block (start '*': all of that day's blocks for the task). For exam study,
 * that day is skipped instead of being planned again.
 */
export async function removeBlock(taskId, date, start) {
  const t = taskById(taskId);
  if (!t) return;
  const hit = (s) => s.date === date && (start === '*' || (s.start || null) === (start || null));
  const plan = (t.plan || []).filter((s) => !hit(s));
  if (t.type === 'exam') {
    const skip = [...new Set([...(t.study?.skip || []), date])];
    t.study = { ...(t.study || {}), skip };
  } else {
    // Keep the rest where they are so the planner doesn't simply put it back.
    plan.forEach((s) => {
      if (s.date >= ymd(new Date())) s.pinned = true;
    });
  }
  await savePlan(t, plan);
}

export async function replan() {
  const n = await autoPlan('rebalance');
  rerender();
  toast(n ? `Re-planned ${n} task${n === 1 ? '' : 's'}. Sessions you moved yourself stayed put.` : 'Your plan is already balanced.');
}

// ---------- Your events, day limits, and typed plan changes ----------

const workName = (t) => {
  const c = courseById(t.course_id);
  const title = t.type === 'exam' ? `Study: ${t.title}` : t.title;
  return c && c.kind === 'class' ? `${c.short} ${title}` : title;
};
const dayLabel = (d) => {
  const r = relDay(parseYmd(d));
  return r === 'Today' || r === 'Tomorrow' ? r.toLowerCase() : r.length > 9 ? r : `${r.slice(0, 3)} ${fmtDate(parseYmd(d), { weekday: false })}`;
};
const minutesOf = (list) => list.reduce((a, b) => a + (Number(b.minutes) || 0), 0);

/** Days an event happens on, starting from `from` (at most `limit` days ahead). */
function eventDates(ev, from = ymd(new Date()), limit = 21) {
  const out = [];
  for (let i = 0, d = parseYmd(from); i < limit; i++, d = addDays(d, 1)) if (eventsOn(ymd(d), { events: [ev] }).length) out.push(ymd(d));
  return out;
}

/**
 * Work you set at a time that now clashes with one of your events goes back to the planner.
 * It stays on its day and gets a new time. Returns the tasks it changed.
 */
function releaseClashes(dates) {
  const changed = [];
  for (const t of state.tasks) {
    if (t.hidden || t.status === 'done') continue;
    let hit = false;
    const plan = (t.plan || []).map((b) => {
      if (!dates.includes(b.date) || !b.fixed || !b.start) return b;
      const s = toMinutes(b.start);
      const e = s + Number(b.minutes);
      if (!eventsOn(b.date, state).some((o) => o.s < e && o.e > s)) return b;
      hit = true;
      return { date: b.date, minutes: b.minutes, pinned: !!b.pinned };
    });
    if (hit) {
      t.plan = plan;
      changed.push(t);
    }
  }
  return changed;
}

/** A day off moves everything planned that day elsewhere. A lighter day re-plans what you didn't place yourself. */
function releaseDays(dates, off) {
  const changed = [];
  for (const t of state.tasks) {
    if (t.hidden || t.status === 'done') continue;
    const drop = (b) => dates.includes(b.date) && (off || !b.pinned);
    if (!(t.plan || []).some(drop)) continue;
    t.plan = t.plan.filter((b) => !drop(b));
    changed.push(t);
  }
  return changed;
}

const pruneLimits = (lim) => {
  const today = ymd(new Date());
  return Object.fromEntries(Object.entries(lim).filter(([d, v]) => d >= today && v !== null && v !== undefined));
};

function snapshot() {
  return {
    events: clone(state.events),
    limits: clone(state.settings.day_limits || {}),
    tasks: new Map(state.tasks.map((t) => [t.id, clone({ plan: t.plan || [], study: t.study ?? null, due_at: t.due_at, duration_minutes: t.duration_minutes })])),
    meetings: new Map(state.meetings.map((m) => [m.id, clone(m.exceptions || [])])),
  };
}

/** Puts things back the way they were in `snap`. Returns what to save. */
function restoreLocal(snap) {
  const keep = new Set(snap.events.map((e) => e.id));
  const ch = { deleteEvents: state.events.filter((e) => !keep.has(e.id)).map((e) => e.id), events: [], tasks: [], meetings: [], settings: false };
  ch.events = snap.events.filter((e) => JSON.stringify(e) !== JSON.stringify(eventById(e.id)));
  state.events = clone(snap.events);
  if (JSON.stringify(snap.limits) !== JSON.stringify(state.settings.day_limits || {})) {
    state.settings = mergeSettings({ ...state.settings, day_limits: snap.limits });
    ch.settings = true;
  }
  for (const t of state.tasks) {
    const p = snap.tasks.get(t.id);
    if (!p) continue;
    const cur = { plan: t.plan || [], study: t.study ?? null, due_at: t.due_at, duration_minutes: t.duration_minutes };
    if (JSON.stringify(cur) !== JSON.stringify(p)) {
      Object.assign(t, clone(p));
      ch.tasks.push(t);
    }
  }
  for (const m of state.meetings) {
    const ex = snap.meetings.get(m.id);
    if (ex && JSON.stringify(ex) !== JSON.stringify(m.exceptions || [])) {
      m.exceptions = clone(ex);
      ch.meetings.push(m);
    }
  }
  return ch;
}

function commit({ events = [], deleteEvents = [], tasks = [], meetings = [], settings = false } = {}) {
  return persist(async () => {
    if (events.length) await store.saveEvents(events);
    if (deleteEvents.length) await store.deleteEvents(deleteEvents);
    if (tasks.length) await store.saveTasks([...new Set(tasks)]);
    if (meetings.length) await store.saveMeetings([...new Set(meetings)]);
    if (settings) await store.saveSettings(state.settings);
  });
}

async function restore(snap) {
  await commit(restoreLocal(snap));
  if (state.ask?.snap === snap) state.ask = null;
  rerender();
  toast('Undone.');
}

/** Runs a change and offers Undo in the toast. */
export async function withUndo(message, fn, { action = 'Undo', onAction = null } = {}) {
  const snap = snapshot();
  const ok = await fn();
  if (ok === false) return;
  toast(message, { action, onAction: onAction || (() => restore(snap)) });
}

/** What moved because of a change, on the days it touched ("CS Homework 6 → today 7:30 pm"). */
function planDiff(snap, focus) {
  const today = ymd(new Date());
  const at = (b) => (b.start && !b.unscheduled ? fmtHM(b.start) : null);
  const on = (list, d) => list.filter((b) => b.date === d);
  const out = [];
  for (const t of state.tasks) {
    if (t.hidden || t.status === 'done') continue;
    const before = (snap.tasks.get(t.id)?.plan || []).filter((b) => b.date >= today);
    const after = (t.plan || []).filter((b) => b.date >= today);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const when = (d) => {
      const list = on(after, d);
      const times = list.map(at).filter(Boolean).join(', ');
      return `${dayLabel(d)}${times ? ` ${times}` : list.length ? ' (doesn’t fit)' : ''}`;
    };
    // Days that gained time: where moved work went.
    const gained = [...new Set(after.map((b) => b.date))].filter((d) => minutesOf(on(after, d)) > minutesOf(on(before, d)));
    for (const d of focus) {
      const b0 = on(before, d);
      const b1 = on(after, d);
      if (!b0.length && !b1.length) continue;
      if (b0.length && b1.length) {
        if (b0.map(at).join() !== b1.map(at).join() || minutesOf(b0) !== minutesOf(b1)) out.push(`${workName(t)} → ${when(d)}`);
      } else if (b0.length) {
        const to = gained.filter((x) => x !== d);
        out.push(`${workName(t)} → ${to.length ? to.map(when).join(', ') : `skipped ${dayLabel(d)}`}`);
      } else out.push(`${workName(t)} → ${when(d)}`);
    }
  }
  return [...new Set(out)];
}

/** "Added Basketball, Tomorrow 2–4 pm" reads better as "…, tomorrow 2–4 pm". */
const sentence = (text) => text.replace(/(.)\b(Today|Tomorrow)\b/g, (_m, before, w) => `${before}${w.toLowerCase()}`);

/** Makes a change you typed into the planner box (see command.js), then reports what moved. */
export async function applyCommand(cmd, text = '') {
  if (cmd.kind === 'undo') {
    if (state.ask?.snap) await restore(state.ask.snap);
    else toast('Nothing to undo.');
    return;
  }
  if (cmd.kind === 'free') {
    const gaps = freeTimeOn(cmd.date, state);
    const total = gaps.reduce((a, [s, e]) => a + e - s, 0);
    const fmt = ([s, e]) => fmtRange(atTime(cmd.date, hm(s)), atTime(cmd.date, hm(Math.min(e, 1439))));
    state.ask = {
      ok: true, text,
      title: gaps.length ? `Free ${dayLabel(cmd.date)}: ${fmtMinutes(total)}` : `No free time left ${dayLabel(cmd.date)}`,
      lines: gaps.length ? [gaps.map(fmt).join(' · ')] : ['Classes, events, and planned work fill your work hours.'],
      moved: [],
    };
    rerender();
    return;
  }
  const snap = snapshot();
  const ch = { events: [], deleteEvents: [], tasks: [], meetings: [], settings: false };
  const focus = new Set();
  const only = [];
  const today = ymd(new Date());
  let mode = 'fill';
  let title = '';
  switch (cmd.kind) {
    case 'event': {
      for (const spec of cmd.events) {
        const ev = row('events', { ...spec, id: uid() });
        state.events.push(ev);
        ch.events.push(ev);
        eventDates(ev, today, 15).forEach((d) => focus.add(d));
      }
      ch.tasks.push(...releaseClashes([...focus]));
      title = `Added ${cmd.chips.slice(1).join(', ')}`;
      break;
    }
    case 'cancel-event': {
      const ev = eventById(cmd.ev.id);
      if (!ev) return;
      if (cmd.all) {
        eventDates(ev, today, 15).forEach((d) => focus.add(d));
        state.events = state.events.filter((e) => e.id !== ev.id);
        ch.deleteEvents.push(ev.id);
        title = `Deleted ${ev.title}${(ev.days || []).length ? ' (every week)' : ''}`;
      } else {
        ev.skip = [...new Set([...(ev.skip || []), cmd.date])];
        ch.events.push(ev);
        focus.add(cmd.date);
        title = `Skipped ${ev.title} ${dayLabel(cmd.date)}`;
      }
      break;
    }
    case 'move-event': {
      const ev = eventById(cmd.ev.id);
      if (!ev) return;
      Object.assign(ch, moveEventLocal(ev, cmd.date, { toDate: cmd.toDate, start: cmd.start, end: cmd.end, series: cmd.all }, ch));
      focus.add(cmd.date);
      focus.add(cmd.toDate);
      ch.tasks.push(...releaseClashes([...focus]));
      title = `Moved ${cmd.chips.slice(1).join(', ')}${(ev.days || []).length && !cmd.all ? ' (just that day)' : ''}`;
      break;
    }
    case 'limit': {
      const lim = { ...(state.settings.day_limits || {}) };
      for (const d of cmd.dates) {
        if (cmd.minutes === null) delete lim[d];
        else lim[d] = cmd.minutes;
        focus.add(d);
      }
      state.settings = mergeSettings({ ...state.settings, day_limits: pruneLimits(lim) });
      ch.settings = true;
      if (cmd.minutes !== null) ch.tasks.push(...releaseDays(cmd.dates, cmd.minutes === 0));
      title = cmd.minutes === null ? `Back to normal: ${cmd.chips[1]}` : cmd.minutes === 0 ? `Day off: ${cmd.chips[1]}` : `At most ${fmtMinutes(cmd.minutes)} of work: ${cmd.chips[1]}`;
      break;
    }
    case 'move-work':
    case 'schedule-work': {
      const t = taskById(cmd.t.id);
      if (!t) return;
      const from = cmd.kind === 'move-work' ? cmd.from : cmd.date;
      const to = cmd.kind === 'move-work' ? cmd.toDate : cmd.date;
      const before = minutesOf((t.plan || []).filter((b) => b.date === from));
      const block = { date: to, minutes: cmd.minutes, pinned: true, ...(cmd.start ? { start: cmd.start, fixed: true } : {}) };
      t.plan = [...(t.plan || []).filter((b) => b.date !== from && !(b.date === to && cmd.start)), block].sort(byBlock);
      if (t.type === 'exam' && t.study?.skip?.includes(to)) t.study = { ...t.study, skip: t.study.skip.filter((d) => d !== to) };
      ch.tasks.push(t);
      focus.add(from);
      focus.add(to);
      if (t.type !== 'exam' && cmd.minutes !== before) only.push(t.id); // the rest of its work adjusts around this
      title = `${cmd.kind === 'move-work' ? 'Moved' : 'Planned'} ${cmd.chips.slice(1).join(', ')}`;
      break;
    }
    case 'skip-work': {
      const t = taskById(cmd.t.id);
      if (!t) return;
      const moving = (t.plan || []).filter((b) => b.date === cmd.date);
      t.plan = (t.plan || []).filter((b) => b.date !== cmd.date);
      focus.add(cmd.date);
      if (t.type === 'exam') {
        t.study = { ...(t.study || {}), skip: [...new Set([...(t.study?.skip || []), cmd.date])] };
        title = `Skipped studying for ${t.title} ${dayLabel(cmd.date)}`;
      } else {
        // It still has to get done: the next day before it's due takes it.
        const next = ymd(addDays(parseYmd(cmd.date), 1));
        const due = t.due_at ? ymd(new Date(t.due_at)) : null;
        if (!due || next <= due) {
          t.plan.push({ date: next, minutes: minutesOf(moving), pinned: true });
          focus.add(next);
          title = `Moved ${workName(t)} from ${dayLabel(cmd.date)} to ${dayLabel(next)}`;
        } else {
          t.plan.forEach((b) => {
            if (b.date >= today) b.pinned = true;
          });
          title = `Took ${workName(t)} off ${dayLabel(cmd.date)}. It's due before another day is free.`;
        }
      }
      t.plan.sort(byBlock);
      ch.tasks.push(t);
      break;
    }
    case 'study': {
      const t = taskById(cmd.t.id);
      if (!t) return;
      const study = { ...(t.study || {}) };
      if (cmd.daily !== undefined) study.daily = cmd.daily;
      if (cmd.start) study.start = cmd.start;
      t.study = study;
      t.plan = (t.plan || []).filter((b) => b.pinned || b.date < today);
      ch.tasks.push(t);
      title = `Study plan for ${t.title}: ${cmd.chips.slice(2).join(', ')}`;
      break;
    }
    case 'cancel-class': {
      for (const id of cmd.meetings) {
        const m = state.meetings.find((x) => x.id === id);
        if (!m) continue;
        m.exceptions = [...(m.exceptions || []).filter((e) => e.date !== cmd.date), { date: cmd.date, cancelled: true }];
        ch.meetings.push(m);
      }
      focus.add(cmd.date);
      title = `No ${cmd.chips[1]} ${dayLabel(cmd.date)}`;
      break;
    }
    case 'replan':
      mode = 'rebalance';
      title = 'Re-planned everything you haven’t placed yourself';
      for (let i = 0; i < 7; i++) focus.add(ymd(addDays(new Date(), i)));
      break;
    default:
      return;
  }
  const ok = await commit(ch);
  if (!ok) {
    restoreLocal(snap);
    rerender();
    return;
  }
  for (const id of only) await autoPlan('rebalance', { only: id });
  await autoPlan(mode);
  const moved = planDiff(snap, [...focus].sort());
  state.ask = { ok: true, text, title: sentence(title), lines: [], moved, snap };
  rerender();
}

/** Moves one day of an event (a weekly event changes just that day, unless `series`). */
function moveEventLocal(ev, date, { toDate = date, start, end, series = false }, ch = { events: [], deleteEvents: [] }) {
  const weekly = (ev.days || []).length > 0;
  if (!weekly) {
    Object.assign(ev, { date: toDate, start_time: start, end_time: end });
  } else if (series) {
    Object.assign(ev, { start_time: start, end_time: end });
    const moved = { ...(ev.moved || {}) };
    delete moved[date];
    ev.moved = moved;
  } else if (toDate === date) {
    ev.moved = { ...(ev.moved || {}), [date]: { start, end } };
  } else {
    // A weekly event moved to another day: skip it here and add a one-day copy there.
    ev.skip = [...new Set([...(ev.skip || []), date])];
    const copy = row('events', { id: uid(), title: ev.title, date: toDate, start_time: start, end_time: end });
    state.events.push(copy);
    ch.events.push(copy);
  }
  ch.events.push(ev);
  return ch;
}

export const clearAsk = () => {
  state.ask = null;
  rerender();
};

/** From the editor: saves an event (new or changed). */
export async function saveEvent(ev) {
  const e = row('events', { ...ev, id: ev.id || uid(), title: (ev.title || '').trim() || 'Busy' });
  const isNew = !eventById(e.id);
  await withUndo(isNew ? `Added ${e.title}` : `Saved ${e.title}`, async () => {
    upsertLocal(state.events, e);
    const tasks = releaseClashes(eventDates(e, ymd(new Date()), 15));
    if (!(await commit({ events: [e], tasks }))) return false;
    await autoPlan();
    rerender();
  });
  return e;
}

export async function deleteEvent(id) {
  const ev = eventById(id);
  if (!ev) return;
  await withUndo(`Deleted ${ev.title}`, async () => {
    state.events = state.events.filter((e) => e.id !== id);
    if (!(await commit({ deleteEvents: [id] }))) return false;
    await autoPlan();
    rerender();
  });
}

export async function skipEventDay(id, date) {
  const ev = eventById(id);
  if (!ev) return;
  await withUndo(`Skipped ${ev.title} ${dayLabel(date)}`, async () => {
    ev.skip = [...new Set([...(ev.skip || []), date])];
    if (!(await commit({ events: [ev] }))) return false;
    await autoPlan();
    rerender();
  });
}

/** Drag or edit one day of an event. Weekly events change just that day unless `series`. */
export async function moveEventDay(id, date, { toDate = date, start, end, series = false } = {}) {
  const ev = eventById(id);
  if (!ev) return;
  const weekly = (ev.days || []).length > 0;
  const range = fmtRange(atTime(toDate, start), atTime(toDate, end));
  const snapBefore = snapshot();
  await withUndo(
    weekly && !series ? `Moved ${ev.title} to ${range}, just ${dayLabel(date)}` : `Moved ${ev.title} to ${range}`,
    async () => {
      const ch = moveEventLocal(ev, date, { toDate, start, end, series });
      ch.tasks = releaseClashes([date, toDate]);
      if (!(await commit(ch))) return false;
      await autoPlan();
      rerender();
    },
    weekly && !series
      ? { action: 'Every week', onAction: () => restoreThen(snapBefore, () => moveEventDay(id, date, { start, end, series: true })) }
      : {},
  );
}

async function restoreThen(snap, fn) {
  await commit(restoreLocal(snap));
  await fn();
}

/** Drag the bottom edge of a work block: it keeps its start and gets a new length. */
export async function resizeBlock(taskId, date, start, minutes) {
  const t = taskById(taskId);
  if (!t) return;
  await withUndo(`${workName(t)}: ${fmtMinutes(minutes)}.${clashWith(date, toMinutes(start), toMinutes(start) + minutes)}`, async () => {
    const plan = (t.plan || []).map((b) => ({ ...b }));
    const b = plan.find((x) => x.date === date && x.start === start);
    if (!b) return false;
    Object.assign(b, { minutes, pinned: true, fixed: true, unscheduled: false });
    t.plan = plan.sort(byBlock);
    if (!(await persist(() => store.saveTasks([t])))) return false;
    if (t.type !== 'exam') await autoPlan('rebalance', { only: t.id });
    await autoPlan();
    rerender();
  });
}

/** Drag an event you added as a task (type "event") to a new time. */
export async function moveTaskEvent(taskId, date, start, minutes) {
  const t = taskById(taskId);
  if (!t) return;
  await withUndo(`Moved ${t.title} to ${fmtRange(atTime(date, start), new Date(+atTime(date, start) + minutes * 60000))}`, async () => {
    await saveTask({ ...t, due_at: atTime(date, start).toISOString(), duration_minutes: minutes });
  });
}

/** The class or event a time on a day runs into, if any ("Heads-up: it overlaps Basketball"). */
function clashWith(date, s, e) {
  const mins = (d) => d.getHours() * 60 + d.getMinutes();
  const hit = [
    ...meetingsOn(date, state).map((m) => ({ s: mins(m.start), e: mins(m.end), title: `${m.course.short} ${m.meeting.kind.toLowerCase()}` })),
    ...eventsOn(date, state).map((o) => ({ s: o.s, e: o.e, title: o.title })),
    ...busyOn(date, state).filter((b) => !b.all_day).map((b) => ({ s: mins(new Date(b.starts_at)), e: mins(new Date(b.ends_at)) || 1440, title: b.title })),
  ].find((x) => x.s < e && x.e > s);
  return hit ? ` Heads-up: it overlaps ${hit.title}.` : '';
}

/** Drag a work block to a new time (Day view). */
export async function dragBlock(taskId, date, start, toStart) {
  const t = taskById(taskId);
  const b = (t?.plan || []).find((x) => x.date === date && x.start === start);
  if (!b) return;
  const s0 = toMinutes(toStart);
  await withUndo(`${workName(t)} moved to ${fmtHM(toStart)}.${clashWith(date, s0, s0 + Number(b.minutes))}`, () => moveBlock(taskId, date, start, { toStart }));
}

/** Drag a day's work to another day (Week view). */
export async function dragSession(taskId, fromDate, toDate) {
  const t = taskById(taskId);
  if (!t || fromDate === toDate) return;
  const due = t.due_at ? ymd(new Date(t.due_at)) : null;
  if (due && toDate > due) {
    toast(`${workName(t)} is due ${dayLabel(due)}, so its work can't go after that.`);
    return;
  }
  if (state.settings.day_limits?.[toDate] === 0) {
    toast(`${cap(dayLabel(toDate))} is a day off. To plan work there, tell the planner “plan work again ${dayLabel(toDate)}”.`);
    return;
  }
  const snap = snapshot();
  await moveSession(taskId, fromDate, toDate);
  const stuck = (taskById(taskId)?.plan || []).some((b) => b.date === toDate && b.unscheduled);
  toast(stuck ? `${workName(t)} moved to ${dayLabel(toDate)}, but it doesn’t fit in that day’s free time.` : `${workName(t)} moved to ${dayLabel(toDate)}`, {
    action: 'Undo',
    onAction: () => restore(snap),
  });
}

const cap = (x) => x[0].toUpperCase() + x.slice(1);

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export async function saveCourse(course, meetings) {
  const c = row('courses', { ...course, id: course.id || uid() });
  upsertLocal(state.courses, c);
  await persist(async () => {
    await store.saveCourses([c]);
    if (meetings) {
      const keep = meetings.map((m) => row('meetings', { ...m, id: m.id || uid(), course_id: c.id }));
      const removed = state.meetings.filter((m) => m.course_id === c.id && !keep.some((k) => k.id === m.id)).map((m) => m.id);
      await store.deleteMeetings(removed);
      await store.saveMeetings(keep);
      state.meetings = [...state.meetings.filter((m) => m.course_id !== c.id), ...keep];
    }
  });
  rerender();
  return c;
}

export async function deleteCourse(id) {
  state.courses = state.courses.filter((c) => c.id !== id);
  state.meetings = state.meetings.filter((m) => m.course_id !== id);
  state.tasks.forEach((t) => {
    if (t.course_id === id) t.course_id = null;
  });
  await persist(() => store.deleteCourse(id));
  rerender();
}

export async function saveSettings(patch) {
  state.settings = mergeSettings({ ...state.settings, ...patch });
  await persist(() => store.saveSettings(state.settings));
  await autoPlan();
  rerender();
}

export async function saveIntegrations(patch) {
  state.integrations = { ...state.integrations, ...patch };
  await persist(() => store.saveIntegrations(patch));
  rerender();
}

export function exportData() {
  const data = {
    app: 'class-dashboard',
    version: 1,
    exported_at: new Date().toISOString(),
    courses: state.courses.map((c) => row('courses', c)),
    meetings: state.meetings.map((m) => row('meetings', m)),
    tasks: state.tasks.map((t) => row('tasks', t)),
    events: state.events.map((e) => row('events', e)),
    settings: state.settings,
    integrations: {
      canvas_feed_url: state.integrations.canvas_feed_url || '',
      outlook_feed_url: state.integrations.outlook_feed_url || '',
    },
  };
  download(`class-dashboard-backup-${ymd(new Date())}.json`, JSON.stringify(data, null, 2));
}

/** Accepts a backup file, or a starter file that links things with `key` / `course_key` / `series_key`. */
export function normalizeImport(json) {
  if (!json || !Array.isArray(json.courses) || !Array.isArray(json.tasks)) {
    throw new Error("That file doesn't look like a dashboard backup.");
  }
  const keyToId = {};
  const courses = json.courses.map((c, i) => {
    const id = c.id || uid();
    if (c.key) keyToId[c.key] = id;
    return row('courses', { sort_order: i, ...c, id });
  });
  const courseId = (o) => o.course_id || (o.course_key ? keyToId[o.course_key] : null) || null;
  const meetings = (json.meetings || [])
    .map((m) => row('meetings', { ...m, id: m.id || uid(), course_id: courseId(m) }))
    .filter((m) => m.course_id);
  const series = {};
  const tasks = json.tasks.map((t) =>
    row('tasks', {
      ...t,
      id: t.id || uid(),
      course_id: courseId(t),
      due_at: t.due_at || (t.due ? new Date(t.due).toISOString() : null),
      series_id: t.series_id || (t.series_key ? (series[t.series_key] ||= uid()) : null),
    }),
  );
  const busy = (json.busy || []).map((b, i) => ({
    id: b.id || i + 1,
    uid: b.uid || `import-${i}`,
    title: b.title || '',
    location: b.location || '',
    all_day: !!b.all_day,
    starts_at: new Date(b.starts_at).toISOString(),
    ends_at: new Date(b.ends_at).toISOString(),
  }));
  const events = (json.events || []).map((e) => row('events', { ...e, id: e.id || uid() })).filter((e) => e.date && e.start_time && e.end_time);
  return { courses, meetings, tasks, busy, events, settings: mergeSettings(json.settings || {}), integrations: json.integrations || {} };
}

export async function importData(json) {
  const data = normalizeImport(json);
  const ok = await persist(() => store.replaceAll(data));
  if (!ok) return;
  await refresh();
  toast(`Imported ${data.courses.length} classes and categories and ${data.tasks.length} tasks.`);
}

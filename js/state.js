// App state and every action that changes data.
import { addDays, atTime, hhmm, ymd } from './dates.js';
import { planTasks } from './planner.js';
import { parseQuickAdd } from './quickadd.js';
import { createStore, defaultSettings, mergeSettings, row } from './store.js';
import { clone, download, toast, uid } from './util.js';

export const store = createStore();

export const state = {
  courses: [],
  meetings: [],
  tasks: [],
  busy: [],
  settings: defaultSettings(),
  integrations: {},
  ready: false,
  offline: false,
  view: 'today',
  weekOffset: 0,
  filter: { q: '', course: '', status: 'open', type: '' },
};

let renderFn = () => {};
export const onRender = (fn) => {
  renderFn = fn;
};
export const rerender = () => renderFn();

export const courseById = (id) => state.courses.find((c) => c.id === id) || null;
export const taskById = (id) => state.tasks.find((t) => t.id === id) || null;
export const liveTasks = () => state.tasks.filter((t) => !t.hidden);
export const openTasks = () => state.tasks.filter((t) => !t.hidden && t.status !== 'done');

const upsertLocal = (arr, item) => {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item;
  else arr.push(item);
};
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

const SNAP_KEY = 'class-dashboard:snapshot:v1';

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
  await autoPlan();
  rerender();
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

/** Plans anything that has no upcoming work sessions ('fill') or re-plans everything ('rebalance'). */
export async function autoPlan(mode = 'fill') {
  const changes = planTasks(state, { mode });
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
  // A new due date or estimate means the old suggested plan is stale (your own pinned sessions stay).
  if (prev && (prev.due_at !== t.due_at || prev.estimate_minutes !== t.estimate_minutes)) {
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

/** Moves one planned session to another day and pins it there. */
export async function moveSession(taskId, fromDate, toDate) {
  const t = taskById(taskId);
  if (!t || fromDate === toDate) return;
  const plan = (t.plan || []).map((s) => ({ ...s }));
  const s = plan.find((x) => x.date === fromDate);
  if (!s) return;
  const target = plan.find((x) => x.date === toDate);
  if (target) {
    target.minutes += s.minutes;
    target.pinned = true;
    plan.splice(plan.indexOf(s), 1);
  } else {
    s.date = toDate;
    s.pinned = true;
  }
  t.plan = plan.sort(byDate);
  await persist(() => store.saveTasks([t]));
  rerender();
}

export async function replan() {
  const n = await autoPlan('rebalance');
  rerender();
  toast(n ? `Re-planned ${n} task${n === 1 ? '' : 's'}. Sessions you moved yourself stayed put.` : 'Your plan is already balanced.');
}

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
  return { courses, meetings, tasks, busy, settings: mergeSettings(json.settings || {}), integrations: json.integrations || {} };
}

export async function importData(json) {
  const data = normalizeImport(json);
  const ok = await persist(() => store.replaceAll(data));
  if (!ok) return;
  await refresh();
  toast(`Imported ${data.courses.length} classes and categories and ${data.tasks.length} tasks.`);
}

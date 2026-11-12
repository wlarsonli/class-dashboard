// Where data lives. LocalStore keeps everything in this browser; SupabaseStore syncs
// through your Supabase project. Both have the same methods.
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';

export function defaultSettings() {
  return {
    term: { name: '', start: '', classes_end: '', finals_start: '', finals_end: '', end: '', breaks: [], next_term: null },
    rundown_time: '07:30',
    nudge_time: '15:00',
    quiet_during_classes: true,
    alerts: { rundown: true, nudges: true },
    workload: { hours: 4, deadlines: 3 },
    capacity: { weekday: 240, weekend: 300 },
    default_estimates: { assignment: 120, essay: 120, reading: 60, exam: 180, task: 30, admin: 15, event: 0 },
    study_window: { start: '08:00', end: '23:00', weekend_start: '10:00' },
    exam_prep: { final: { daily: 120, days: 7 }, midterm: { daily: 120, days: 5 }, quiz: { daily: 60, days: 3 } },
    day_limits: {}, // { 'YYYY-MM-DD': most minutes of work that day } (0 = day off)
    feed: { events: true, work: true }, // what the Outlook calendar link shows besides deadlines
    planner_version: 0,
    theme: 'auto',
    timezone: 'America/Chicago',
  };
}

export function mergeSettings(s = {}) {
  const d = defaultSettings();
  return {
    ...d,
    ...s,
    term: { ...d.term, ...(s.term || {}) },
    alerts: { ...d.alerts, ...(s.alerts || {}) },
    workload: { ...d.workload, ...(s.workload || {}) },
    capacity: { ...d.capacity, ...(s.capacity || {}) },
    default_estimates: { ...d.default_estimates, ...(s.default_estimates || {}) },
    study_window: { ...d.study_window, ...(s.study_window || {}) },
    exam_prep: {
      final: { ...d.exam_prep.final, ...(s.exam_prep?.final || {}) },
      midterm: { ...d.exam_prep.midterm, ...(s.exam_prep?.midterm || {}) },
      quiz: { ...d.exam_prep.quiz, ...(s.exam_prep?.quiz || {}) },
    },
    day_limits: { ...(s.day_limits || {}) },
    feed: { ...d.feed, ...(s.feed || {}) },
  };
}

// Every row sent to the database has exactly these columns (user_id and timestamps are set by the server).
export const COLS = {
  courses: {
    id: null, kind: 'class', code: '', name: '', short: '', color: '#C9B8F0', instructor: '', email: '',
    office_hours: [], links: [], policies: '', canvas_course_id: null, aliases: [], sort_order: 0, archived: false,
  },
  meetings: {
    id: null, course_id: null, kind: 'Lecture', days: [], start_time: '09:00', end_time: '10:00', location: '',
    start_date: null, end_date: null, exceptions: [],
  },
  tasks: {
    id: null, course_id: null, title: '', type: 'task', due_at: null, duration_minutes: null, estimate_minutes: null,
    priority: 0, status: 'todo', done_at: null, notes: '', links: [], subtasks: [], plan: [], series_id: null,
    repeat: null, source: 'manual', external_uid: null, estimated_date: false, location: '', hidden: false, study: null,
  },
  // Events you add in the app. Weekly ones repeat on `days` from `date` through `until`.
  events: {
    id: null, title: '', date: null, start_time: '17:00', end_time: '18:00', days: [], until: null, skip: [], moved: {},
  },
};

export function row(table, obj) {
  const out = {};
  for (const [k, def] of Object.entries(COLS[table])) {
    out[k] = obj[k] === undefined ? (def && typeof def === 'object' ? structuredClone(def) : def) : obj[k];
  }
  return out;
}

const upsertInto = (arr, r) => {
  const i = arr.findIndex((x) => x.id === r.id);
  if (i >= 0) arr[i] = r;
  else arr.push(r);
};

const LS_KEY = 'class-dashboard:data:v1';

class LocalStore {
  mode = 'local';

  async init() {
    return { signedIn: true };
  }

  read() {
    try {
      const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (d) return d;
    } catch {
      /* fall through */
    }
    return { courses: [], meetings: [], tasks: [], busy: [], events: [], settings: {}, integrations: {} };
  }

  write(d) {
    localStorage.setItem(LS_KEY, JSON.stringify(d));
  }

  mutate(fn) {
    const d = this.read();
    fn(d);
    this.write(d);
  }

  async load() {
    const d = this.read();
    return {
      courses: (d.courses || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
      meetings: d.meetings || [],
      tasks: (d.tasks || []).filter((t) => !t.hidden),
      busy: d.busy || [],
      events: d.events || [],
      settings: mergeSettings(d.settings),
      integrations: d.integrations || {},
    };
  }

  async saveTasks(rows) {
    this.mutate((d) => {
      d.tasks ||= [];
      rows.forEach((r) => upsertInto(d.tasks, row('tasks', r)));
    });
  }

  async deleteTasks(ids) {
    this.mutate((d) => {
      d.tasks = (d.tasks || []).filter((t) => !ids.includes(t.id));
    });
  }

  async saveEvents(rows) {
    this.mutate((d) => {
      d.events ||= [];
      rows.forEach((r) => upsertInto(d.events, row('events', r)));
    });
  }

  async deleteEvents(ids) {
    this.mutate((d) => {
      d.events = (d.events || []).filter((e) => !ids.includes(e.id));
    });
  }

  async saveCourses(rows) {
    this.mutate((d) => {
      d.courses ||= [];
      rows.forEach((r) => upsertInto(d.courses, row('courses', r)));
    });
  }

  async deleteCourse(id) {
    this.mutate((d) => {
      d.courses = (d.courses || []).filter((c) => c.id !== id);
      d.meetings = (d.meetings || []).filter((m) => m.course_id !== id);
      (d.tasks || []).forEach((t) => {
        if (t.course_id === id) t.course_id = null;
      });
    });
  }

  async saveMeetings(rows) {
    this.mutate((d) => {
      d.meetings ||= [];
      rows.forEach((r) => upsertInto(d.meetings, row('meetings', r)));
    });
  }

  async deleteMeetings(ids) {
    this.mutate((d) => {
      d.meetings = (d.meetings || []).filter((m) => !ids.includes(m.id));
    });
  }

  async saveSettings(settings) {
    this.mutate((d) => {
      d.settings = settings;
    });
  }

  async saveIntegrations(patch) {
    this.mutate((d) => {
      d.integrations = { ...(d.integrations || {}), ...patch };
    });
  }

  async replaceAll(data) {
    this.write({
      courses: data.courses.map((c) => row('courses', c)),
      meetings: data.meetings.map((m) => row('meetings', m)),
      tasks: data.tasks.map((t) => row('tasks', t)),
      busy: data.busy || [],
      events: (data.events || []).map((e) => row('events', e)),
      settings: data.settings,
      integrations: data.integrations || {},
    });
  }

  async savePushSubscription() {
    throw new Error('Notifications start working once the dashboard is connected to Supabase.');
  }

  async invoke() {
    throw new Error('This needs the online version of the dashboard.');
  }

  calendarUrl() {
    return '';
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(s);
  });
}

class SupabaseStore {
  mode = 'cloud';

  async init() {
    if (!window.supabase) await loadScript('vendor/supabase.js');
    this.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    const { data } = await this.sb.auth.getSession();
    this.user = data.session?.user || null;
    return { signedIn: !!this.user };
  }

  get email() {
    return this.user?.email || '';
  }

  async signIn(email, password) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
  }

  async signUp(email, password) {
    const { data, error } = await this.sb.auth.signUp({ email, password });
    if (error) throw error;
    if (!data.session) throw new Error('Account created. Confirm it from the email Supabase sent you, then sign in.');
    this.user = data.user;
  }

  async signOut() {
    await this.sb.auth.signOut();
    this.user = null;
  }

  ok({ data, error }) {
    if (error) throw error;
    return data;
  }

  async load() {
    const since = new Date(Date.now() - 2 * 86400000).toISOString();
    const db = this.sb;
    const [courses, meetings, tasks, busy, events, settings, integrations] = await Promise.all([
      db.from('courses').select('*').order('sort_order').then((r) => this.ok(r)),
      db.from('meetings').select('*').then((r) => this.ok(r)),
      db.from('tasks').select('*').eq('hidden', false).then((r) => this.ok(r)),
      db.from('busy_blocks').select('*').gte('ends_at', since).order('starts_at').then((r) => this.ok(r)),
      // Your own events. If the table isn't there yet, the rest of the app still loads.
      db.from('events').select('*').then((r) => {
        if (r.error) console.warn("Couldn't load your events", r.error);
        return r.data || [];
      }),
      db.from('settings').select('data').maybeSingle().then((r) => this.ok(r)),
      db.from('integrations').select('*').maybeSingle().then((r) => this.ok(r)),
    ]);
    return { courses, meetings, tasks, busy, events, settings: mergeSettings(settings?.data || {}), integrations: integrations || {} };
  }

  async upsert(table, rows) {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => row(table, r));
      this.ok(await this.sb.from(table).upsert(chunk, { onConflict: 'id', defaultToNull: false }));
    }
  }

  saveTasks(rows) {
    return this.upsert('tasks', rows);
  }

  async deleteTasks(ids) {
    if (ids.length) this.ok(await this.sb.from('tasks').delete().in('id', ids));
  }

  saveEvents(rows) {
    return this.upsert('events', rows);
  }

  async deleteEvents(ids) {
    if (ids.length) this.ok(await this.sb.from('events').delete().in('id', ids));
  }

  saveCourses(rows) {
    return this.upsert('courses', rows);
  }

  async deleteCourse(id) {
    this.ok(await this.sb.from('courses').delete().eq('id', id));
  }

  saveMeetings(rows) {
    return this.upsert('meetings', rows);
  }

  async deleteMeetings(ids) {
    if (ids.length) this.ok(await this.sb.from('meetings').delete().in('id', ids));
  }

  async saveSettings(settings) {
    this.ok(await this.sb.from('settings').upsert({ user_id: this.user.id, data: settings }));
  }

  async saveIntegrations(patch) {
    const body = { user_id: this.user.id };
    for (const k of ['canvas_feed_url', 'outlook_feed_url']) if (patch[k] !== undefined) body[k] = patch[k];
    this.ok(await this.sb.from('integrations').upsert(body));
  }

  async replaceAll(data) {
    const none = '00000000-0000-0000-0000-000000000000';
    this.ok(await this.sb.from('tasks').delete().neq('id', none));
    this.ok(await this.sb.from('meetings').delete().neq('id', none));
    this.ok(await this.sb.from('courses').delete().neq('id', none));
    this.ok(await this.sb.from('events').delete().neq('id', none));
    await this.saveCourses(data.courses);
    await this.saveMeetings(data.meetings);
    await this.saveTasks(data.tasks);
    await this.saveEvents(data.events || []);
    await this.saveSettings(data.settings);
    if (data.integrations) await this.saveIntegrations(data.integrations);
  }

  async savePushSubscription(sub) {
    const j = sub.toJSON();
    this.ok(
      await this.sb
        .from('push_subscriptions')
        .upsert(
          { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) },
          { onConflict: 'endpoint' },
        ),
    );
  }

  async invoke(name, body = {}) {
    const { data, error } = await this.sb.functions.invoke(name, { body });
    if (error) {
      // The function's own explanation is in the response body ({ error, message }).
      let info = null;
      try {
        info = await error.context?.json?.();
      } catch {
        /* not JSON */
      }
      const err = new Error(info?.message || error.message);
      err.code = info?.error || '';
      err.name = error.name;
      throw err;
    }
    return data;
  }

  calendarUrl(integrations) {
    return integrations?.calendar_token ? `${SUPABASE_URL}/functions/v1/calendar?token=${integrations.calendar_token}` : '';
  }
}

export function createStore() {
  return SUPABASE_URL && SUPABASE_ANON_KEY ? new SupabaseStore() : new LocalStore();
}

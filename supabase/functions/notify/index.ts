// Runs every 15 minutes and sends phone notifications:
//  - the morning rundown (classes, what's due, what you planned for today)
//  - the planned-work reminder later in the day (only if something planned isn't done yet)
// Alerts that would land during a class wait until it's over. "Send a test" in Settings calls this too.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { meetingsOn, type Course, type Meeting, type Settings } from '../_shared/schedule.ts';
import { admin, caller, cors, json } from '../_shared/server.ts';
import { DOW_LONG, dowOfYmd, fmtMinutes, fmtTime, minutesIn, toMinutes, TZ, ymdIn } from '../_shared/time.ts';

interface Task {
  id: string; title: string; type: string; due_at: string | null; status: string; course_id: string | null;
  plan: { date: string; minutes: number }[];
}
interface Payload { title: string; body: string; tag?: string; url?: string }

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'https://example.com',
  Deno.env.get('VAPID_PUBLIC_KEY') || '',
  Deno.env.get('VAPID_PRIVATE_KEY') || '',
);

async function send(db: SupabaseClient, userId: string, payload: Payload) {
  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId);
  let delivered = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 4 * 3600 });
      delivered++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id); // device unsubscribed
      else console.error('push failed', code, (e as { body?: string }).body);
    }
  }
  return delivered;
}

async function once(db: SupabaseClient, userId: string, kind: string, ref: string) {
  // Claims the slot; returns false if this alert already went out.
  const { error } = await db.from('notification_log').insert({ user_id: userId, kind, ref });
  return !error;
}

const list = (items: string[], max = 3) => (items.length > max ? `${items.slice(0, max).join(', ')} +${items.length - max} more` : items.join(', '));

function rundown(today: string, tasks: Task[], meetings: Meeting[], courses: Course[], settings: Settings, tz: string): Payload {
  const now = new Date();
  const short = (id: string | null) => courses.find((c) => c.id === id)?.short;
  const name = (t: Task) => (short(t.course_id) ? `${short(t.course_id)} ${t.title}` : t.title);
  const open = tasks.filter((t) => t.status !== 'done');
  const classes = meetingsOn(today, meetings, courses, settings, tz);
  const due = open.filter((t) => t.due_at && ymdIn(new Date(t.due_at), tz) === today);
  const overdue = open.filter((t) => t.due_at && new Date(t.due_at) < now && ymdIn(new Date(t.due_at), tz) !== today && t.type !== 'event');
  const planned = open.flatMap((t) => (t.plan || []).filter((s) => s.date === today).map((s) => ({ t, minutes: s.minutes })));
  const plannedMin = planned.reduce((a, p) => a + p.minutes, 0);

  const lines: string[] = [];
  if (classes.length) lines.push(`Classes: ${list(classes.map((c) => `${c.course.short} ${fmtTime(c.start, tz)}${c.note ? ` (${c.note})` : ''}`), 4)}`);
  if (due.length) lines.push(`Due: ${list(due.map((t) => `${name(t)} (${fmtTime(new Date(t.due_at!), tz)})`))}`);
  if (planned.length) lines.push(`Plan: ${list(planned.map((p) => `${p.t.title} (${fmtMinutes(p.minutes)})`))}`);
  if (overdue.length) lines.push(`Overdue: ${list(overdue.map(name), 2)}`);
  if (!lines.length) lines.push('Nothing due and nothing planned. Enjoy it.');

  const bits = [];
  if (due.length) bits.push(`${due.length} due`);
  if (plannedMin) bits.push(`${fmtMinutes(plannedMin)} planned`);
  return {
    title: `${DOW_LONG[dowOfYmd(today)]}${bits.length ? `: ${bits.join(', ')}` : ''}`,
    body: lines.join('\n'),
    tag: `rundown-${today}`,
    url: './#today',
  };
}

function nudge(today: string, tasks: Task[]): Payload | null {
  const planned = tasks
    .filter((t) => t.status !== 'done')
    .flatMap((t) => (t.plan || []).filter((s) => s.date === today).map((s) => ({ t, minutes: s.minutes })));
  if (!planned.length) return null;
  const total = planned.reduce((a, p) => a + p.minutes, 0);
  return {
    title: `Still planned for today: ${fmtMinutes(total)}`,
    body: list(planned.map((p) => `${p.t.title} (${fmtMinutes(p.minutes)})`), 4),
    tag: `nudge-${today}`,
    url: './#today',
  };
}

async function runUser(db: SupabaseClient, userId: string) {
  const [s, t, m, c] = await Promise.all([
    db.from('settings').select('data').eq('user_id', userId).maybeSingle(),
    db.from('tasks').select('id, title, type, due_at, status, course_id, plan').eq('user_id', userId).eq('hidden', false),
    db.from('meetings').select('*').eq('user_id', userId),
    db.from('courses').select('id, short, name, archived').eq('user_id', userId),
  ]);
  const settings = (s.data?.data || {}) as Settings & {
    timezone?: string; rundown_time?: string; nudge_time?: string; quiet_during_classes?: boolean; alerts?: { rundown?: boolean; nudges?: boolean };
  };
  const tz = settings.timezone || TZ;
  const now = new Date();
  const today = ymdIn(now, tz);
  const nowMin = minutesIn(now, tz);
  const tasks = (t.data || []) as Task[];
  const meetings = (m.data || []) as Meeting[];
  const courses = (c.data || []) as Course[];

  if (settings.quiet_during_classes !== false) {
    const inClass = meetingsOn(today, meetings, courses, settings, tz).some((x) => now >= x.start && now < x.end);
    if (inClass) return 'waiting for class to end';
  }
  const sent: string[] = [];
  const rundownAt = toMinutes(settings.rundown_time || '07:30');
  if (settings.alerts?.rundown !== false && nowMin >= rundownAt && nowMin < rundownAt + 180 && (await once(db, userId, 'rundown', today))) {
    await send(db, userId, rundown(today, tasks, meetings, courses, settings, tz));
    sent.push('rundown');
  }
  const nudgeAt = toMinutes(settings.nudge_time || '15:00');
  if (settings.alerts?.nudges !== false && nowMin >= nudgeAt && nowMin < nudgeAt + 240) {
    const msg = nudge(today, tasks);
    if (msg && (await once(db, userId, 'nudge', today))) {
      await send(db, userId, msg);
      sent.push('nudge');
    }
  }
  return sent.join(', ') || 'nothing due now';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const db = admin();
    const who = await caller(req, db);
    if (!who) return json({ error: 'Not signed in' }, 401);
    const body = await req.json().catch(() => ({}));
    if (!who.cron) {
      if (!body.test) return json({ error: 'Only the scheduled job can do that' }, 403);
      const n = await send(db, who.userId!, { title: 'Test notification', body: 'Notifications are working on this device.', tag: 'test' });
      return json({ delivered: n });
    }
    const { data } = await db.from('push_subscriptions').select('user_id');
    const users = [...new Set((data || []).map((r) => r.user_id as string))];
    const results: Record<string, string> = {};
    for (const u of users) results[u] = await runUser(db, u);
    return json({ users: users.length, results });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});

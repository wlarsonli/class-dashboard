// Runs every hour (and when you tap "Sync now"):
//  - Canvas: adds new assignments, updates changed due dates, links syllabus tasks to their Canvas versions.
//  - Outlook: refreshes the busy times the planner works around.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { canvasItems, findPlaceholder, guessType, similarity } from '../_shared/canvas.ts';
import { busyFromIcs, CLASS_TITLE } from '../_shared/outlook.ts';
import { admin, caller, cors, json } from '../_shared/server.ts';
import { TZ, ymdIn } from '../_shared/time.ts';

const DAY = 86400000;
const TASK_FIELDS = 'id, course_id, title, due_at, external_uid, hidden, estimated_date, links, plan, estimate_minutes, status';

interface Integration { user_id: string; canvas_feed_url: string; outlook_feed_url: string }
interface Link { label: string; url: string }
interface Session { date: string; minutes: number; pinned?: boolean }

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'class-dashboard-sync' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function syncCanvas(db: SupabaseClient, userId: string, url: string, tz: string) {
  const text = await fetchText(url);
  const host = new URL(url).host;
  const now = Date.now();
  const items = canvasItems(text, tz).filter((i) => +i.due > now - 14 * DAY);
  const [courses, tasks] = await Promise.all([
    db.from('courses').select('id, code, canvas_course_id').eq('user_id', userId),
    db.from('tasks').select(TASK_FIELDS).eq('user_id', userId),
  ]);
  if (courses.error) throw courses.error;
  if (tasks.error) throw tasks.error;
  const allTasks = tasks.data!;
  const today = ymdIn(new Date(), tz);
  let added = 0;
  let updated = 0;

  for (const it of items) {
    const course =
      courses.data!.find((c) => c.canvas_course_id && c.canvas_course_id === it.courseNumber) ||
      courses.data!.find((c) => c.code && it.context.toUpperCase().startsWith(c.code.toUpperCase())) ||
      null;
    const link =
      it.kind === 'assignment' && it.courseNumber
        ? `https://${host}/courses/${it.courseNumber}/assignments/${it.uid.replace('event-assignment-', '')}`
        : it.url;
    const existing = allTasks.find((t) => t.external_uid === it.uid) || (course ? findPlaceholder(it, allTasks, course.id) : null);

    if (existing) {
      if (existing.hidden) continue; // you deleted it; keep it gone
      const patch: Record<string, unknown> = {};
      if (!existing.due_at || Math.abs(+new Date(existing.due_at) - +it.due) > 60000) {
        patch.due_at = it.due.toISOString();
        // The date moved, so let the planner redo its suggestions (sessions you placed yourself stay).
        patch.plan = ((existing.plan || []) as Session[]).filter((s) => s.pinned || s.date < today);
      }
      if (existing.external_uid !== it.uid) patch.external_uid = it.uid;
      if (existing.estimated_date) patch.estimated_date = false;
      const links = (existing.links || []) as Link[];
      if (link && !links.some((l) => l.url === link)) patch.links = [...links, { label: 'Canvas', url: link }];
      if (Object.keys(patch).length) {
        const { error } = await db.from('tasks').update(patch).eq('id', existing.id);
        if (error) throw error;
        Object.assign(existing, patch);
        updated++;
      }
      continue;
    }

    if (+it.due < now) continue; // don't add things that were already due
    // Reuse the time estimate from a similar task in the same class ("Homework 6" → "Homework 7").
    const similar = course
      ? allTasks
          .filter((t) => t.course_id === course.id && t.estimate_minutes != null)
          .map((t) => ({ t, s: similarity(t.title, it.title) }))
          .filter((x) => x.s >= 0.6)
          .sort((a, b) => b.s - a.s)[0]?.t
      : null;
    const row = {
      user_id: userId,
      course_id: course?.id ?? null,
      title: it.title,
      type: guessType(it.title, it.kind, it.allDay),
      due_at: it.due.toISOString(),
      duration_minutes: it.end ? Math.round((+it.end - +it.due) / 60000) : null,
      estimate_minutes: similar?.estimate_minutes ?? null,
      source: 'canvas',
      external_uid: it.uid,
      links: link ? [{ label: 'Canvas', url: link }] : [],
      location: it.location,
    };
    const { data, error } = await db.from('tasks').insert(row).select(TASK_FIELDS).single();
    if (error) {
      if (error.code === '23505') continue; // already there
      throw error;
    }
    allTasks.push(data);
    added++;
  }
  return `Canvas: ${added} new, ${updated} updated`;
}

async function syncOutlook(db: SupabaseClient, userId: string, url: string, tz: string) {
  const text = await fetchText(url);
  const from = new Date(Date.now() - DAY);
  const to = new Date(Date.now() + 35 * DAY);
  const blocks = busyFromIcs(text, from, to, tz).filter((b) => !CLASS_TITLE.test(b.title));
  const del = await db.from('busy_blocks').delete().eq('user_id', userId).eq('source', 'outlook');
  if (del.error) throw del.error;
  for (let i = 0; i < blocks.length; i += 500) {
    const { error } = await db.from('busy_blocks').insert(blocks.slice(i, i + 500).map((b) => ({ ...b, user_id: userId, source: 'outlook' })));
    if (error) throw error;
  }
  return `Outlook: ${blocks.length} events`;
}

async function syncUser(db: SupabaseClient, integ: Integration) {
  const { data: s } = await db.from('settings').select('data').eq('user_id', integ.user_id).maybeSingle();
  const tz = (s?.data?.timezone as string) || TZ;
  const notes: string[] = [];
  if (integ.canvas_feed_url) {
    try {
      notes.push(await syncCanvas(db, integ.user_id, integ.canvas_feed_url, tz));
    } catch (e) {
      console.error('canvas', e);
      notes.push(`Canvas failed (${(e as Error).message})`);
    }
  }
  if (integ.outlook_feed_url) {
    try {
      notes.push(await syncOutlook(db, integ.user_id, integ.outlook_feed_url, tz));
    } catch (e) {
      console.error('outlook', e);
      notes.push(`Outlook failed (${(e as Error).message})`);
    }
  }
  const summary = notes.join(' · ') || 'No links to sync yet';
  await db.from('integrations').update({ last_sync_at: new Date().toISOString(), last_sync_status: summary }).eq('user_id', integ.user_id);
  return summary;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const db = admin();
    const who = await caller(req, db);
    if (!who) return json({ error: 'Not signed in' }, 401);
    let q = db.from('integrations').select('user_id, canvas_feed_url, outlook_feed_url');
    if (!who.cron) q = q.eq('user_id', who.userId!);
    const { data, error } = await q;
    if (error) throw error;
    const results: string[] = [];
    for (const integ of data || []) results.push(await syncUser(db, integ as Integration));
    return json({ summary: results.join('\n') || 'Add your Canvas and Outlook links in Settings first.' });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});

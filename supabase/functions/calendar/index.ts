// Your dashboard as a calendar feed. Subscribe to its link in Outlook ("Subscribe from web").
// It has your deadlines and exams, your own events (like basketball), and your planned work blocks.
// The last two can be turned off in Settings. The link contains a long random token; anyone without it gets "Not found".
import { escapeText, fold, stampUtc } from '../_shared/ics.ts';
import { admin } from '../_shared/server.ts';
import { addDaysYmd, dowOfYmd, fmtTime, parts, toMinutes, TZ, ymdIn, zoned } from '../_shared/time.ts';

interface Ev {
  id: string; title: string; date: string; start_time: string; end_time: string;
  days: number[] | null; until: string | null; skip: string[] | null; moved: Record<string, { start: string; end: string }> | null;
}
interface Block { date: string; minutes: number; start?: string; unscheduled?: boolean }

/** One day of an event as [start, end] instants, the same way the app works it out. */
function eventOn(ev: Ev, date: string, tz: string): [Date, Date] | null {
  const weekly = (ev.days || []).length > 0;
  if (weekly) {
    if (date < ev.date || (ev.until && date > ev.until) || !ev.days!.includes(dowOfYmd(date)) || (ev.skip || []).includes(date)) return null;
  } else if (ev.date !== date) return null;
  const change = ev.moved?.[date];
  const start = change?.start || ev.start_time;
  const end = change?.end || ev.end_time;
  const s = zoned(date, start, tz);
  const e = toMinutes(end) <= toMinutes(start) ? zoned(addDaysYmd(date, 1), '00:00', tz) : zoned(date, end, tz);
  return [s, e];
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') || '';
  if (token.length < 32) return new Response('Not found', { status: 404 });
  try {
    const db = admin();
    const { data: integ } = await db.from('integrations').select('user_id').eq('calendar_token', token).maybeSingle();
    if (!integ) return new Response('Not found', { status: 404 });
    const userId = integ.user_id as string;
    const since = Date.now() - 30 * 86400000;
    const [tasks, courses, settings, events] = await Promise.all([
      db.from('tasks').select('id, title, type, due_at, duration_minutes, location, status, course_id, plan').eq('user_id', userId).eq('hidden', false),
      db.from('courses').select('id, short').eq('user_id', userId),
      db.from('settings').select('data').eq('user_id', userId).maybeSingle(),
      db.from('events').select('id, title, date, start_time, end_time, days, until, skip, moved').eq('user_id', userId),
    ]);
    const prefs = settings.data?.data || {};
    const tz = (prefs.timezone as string) || TZ;
    const showEvents = prefs.feed?.events !== false;
    const showWork = prefs.feed?.work !== false;
    const short = (id: string | null) => (courses.data || []).find((c) => c.id === id)?.short || '';
    const now = stampUtc(new Date());
    const today = ymdIn(new Date(), tz);

    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Class Dashboard//Deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:Class deadlines', `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ];
    const timed = (uid: string, s: Date, e: Date, summary: string, extra: string[] = []) => {
      lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${now}`, `DTSTART:${stampUtc(s)}`, `DTEND:${stampUtc(e)}`, `SUMMARY:${escapeText(summary)}`, ...extra, 'END:VEVENT');
    };

    // Deadlines and exams
    const dated = (tasks.data || [])
      .filter((t) => t.due_at && +new Date(t.due_at) >= since)
      .sort((a, b) => +new Date(a.due_at) - +new Date(b.due_at));
    for (const t of dated) {
      const due = new Date(t.due_at as string);
      const done = t.status === 'done' ? '✓ ' : '';
      const label = `${short(t.course_id) ? `${short(t.course_id)} · ` : ''}${t.title}`;
      lines.push('BEGIN:VEVENT', `UID:${t.id}@class-dashboard`, `DTSTAMP:${now}`);
      const p = parts(due, tz);
      if (t.type === 'exam' || t.type === 'event') {
        const end = new Date(+due + (t.duration_minutes || 60) * 60000);
        lines.push(`DTSTART:${stampUtc(due)}`, `DTEND:${stampUtc(end)}`, `SUMMARY:${escapeText(done + label)}`);
        if (t.location) lines.push(`LOCATION:${escapeText(t.location)}`);
      } else if (p.h === 23 && p.min === 59) {
        // Due at the end of the day: show it as an all-day item instead of a block at midnight.
        const day = ymdIn(due, tz);
        lines.push(`DTSTART;VALUE=DATE:${day.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDaysYmd(day, 1).replace(/-/g, '')}`, `SUMMARY:${escapeText(`${done}Due 11:59 pm · ${label}`)}`);
      } else {
        lines.push(`DTSTART:${stampUtc(new Date(+due - 15 * 60000))}`, `DTEND:${stampUtc(due)}`, `SUMMARY:${escapeText(`${done}Due ${fmtTime(due, tz)} · ${label}`)}`);
      }
      lines.push('TRANSP:TRANSPARENT', 'END:VEVENT'); // deadlines don't make you look busy to others
    }

    // Your own events, two weeks back to two months ahead
    if (showEvents) {
      for (const ev of (events.data || []) as Ev[]) {
        for (let i = -14; i <= 60; i++) {
          const date = addDaysYmd(today, i);
          const at = eventOn(ev, date, tz);
          if (at) timed(`${ev.id}-${date}@class-dashboard-event`, at[0], at[1], ev.title || 'Busy', ['DESCRIPTION:From your class dashboard.']);
        }
      }
    }

    // Planned work blocks, as of the last time the dashboard planned your week
    if (showWork) {
      const from = addDaysYmd(today, -7);
      const to = addDaysYmd(today, 28);
      for (const t of tasks.data || []) {
        if (t.status === 'done') continue;
        const name = t.type === 'exam' ? `Study: ${t.title}` : t.title;
        const label = `${short(t.course_id) ? `${short(t.course_id)} · ` : ''}${name}`;
        for (const b of (t.plan || []) as Block[]) {
          if (!b.start || b.unscheduled || b.date < from || b.date > to || !(b.minutes > 0)) continue;
          const s = zoned(b.date, b.start, tz);
          timed(`${t.id}-${b.date}-${b.start.replace(':', '')}@class-dashboard-work`, s, new Date(+s + b.minutes * 60000), `Work: ${label}`, [
            'DESCRIPTION:Planned by your class dashboard. Move it there and this updates.',
            'TRANSP:TRANSPARENT',
          ]);
        }
      }
    }

    lines.push('END:VCALENDAR');
    return new Response(lines.map(fold).join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  } catch (e) {
    console.error(e);
    return new Response('Something went wrong', { status: 500 });
  }
});

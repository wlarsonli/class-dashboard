// Your deadlines as a calendar feed. Subscribe to its link in Outlook ("Subscribe from web").
// The link contains a long random token; anyone without it gets "Not found".
import { escapeText, fold, stampUtc } from '../_shared/ics.ts';
import { admin } from '../_shared/server.ts';
import { addDaysYmd, fmtTime, parts, TZ, ymdIn } from '../_shared/time.ts';

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') || '';
  if (token.length < 32) return new Response('Not found', { status: 404 });
  try {
    const db = admin();
    const { data: integ } = await db.from('integrations').select('user_id').eq('calendar_token', token).maybeSingle();
    if (!integ) return new Response('Not found', { status: 404 });
    const userId = integ.user_id as string;
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [tasks, courses, settings] = await Promise.all([
      db.from('tasks').select('id, title, type, due_at, duration_minutes, location, status, course_id').eq('user_id', userId)
        .eq('hidden', false).not('due_at', 'is', null).gte('due_at', since).order('due_at'),
      db.from('courses').select('id, short').eq('user_id', userId),
      db.from('settings').select('data').eq('user_id', userId).maybeSingle(),
    ]);
    const tz = (settings.data?.data?.timezone as string) || TZ;
    const short = (id: string | null) => (courses.data || []).find((c) => c.id === id)?.short || '';
    const now = stampUtc(new Date());

    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Class Dashboard//Deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:Class deadlines', `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ];
    for (const t of tasks.data || []) {
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
    lines.push('END:VCALENDAR');
    return new Response(lines.map(fold).join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  } catch (e) {
    console.error(e);
    return new Response('Something went wrong', { status: 500 });
  }
});

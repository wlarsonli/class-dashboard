// Server copy of the app's class-schedule logic (see js/term.js).
import { dowOfYmd, TZ, zoned } from './time.ts';

export interface Meeting {
  id: string; course_id: string; kind: string; days: number[]; start_time: string; end_time: string; location: string;
  start_date: string | null; end_date: string | null; exceptions: { date: string; cancelled?: boolean; location?: string; note?: string }[];
}
export interface Course { id: string; short: string; name: string; archived: boolean }
export interface Settings { term?: { breaks?: { label?: string; start: string; end: string }[] }; [k: string]: unknown }

export function breakOn(dateStr: string, settings: Settings) {
  return (settings.term?.breaks || []).find((b) => b.start && b.end && dateStr >= b.start && dateStr <= b.end) || null;
}

export function meetingsOn(dateStr: string, meetings: Meeting[], courses: Course[], settings: Settings, tz = TZ) {
  if (breakOn(dateStr, settings)) return [];
  const dow = dowOfYmd(dateStr);
  const out: { course: Course; kind: string; start: Date; end: Date; location: string; note: string }[] = [];
  for (const m of meetings) {
    if (!m.days?.includes(dow)) continue;
    if (m.start_date && dateStr < m.start_date) continue;
    if (m.end_date && dateStr > m.end_date) continue;
    const ex = (m.exceptions || []).find((e) => e.date === dateStr);
    if (ex?.cancelled) continue;
    const course = courses.find((c) => c.id === m.course_id);
    if (!course || course.archived) continue;
    out.push({
      course,
      kind: m.kind,
      start: zoned(dateStr, m.start_time, tz),
      end: zoned(dateStr, m.end_time, tz),
      location: ex?.location || m.location,
      note: ex?.note || '',
    });
  }
  return out.sort((a, b) => +a.start - +b.start);
}

// Turns the Canvas calendar feed into tasks, and matches Canvas items to tasks that
// already came from a syllabus ("Homework 7" from the syllabus = "Homework 7" on Canvas).
import { icsTime, parseIcs, unescapeText } from './ics.ts';
import { TZ, zoned } from './time.ts';

export interface CanvasItem {
  uid: string;
  kind: 'assignment' | 'event';
  title: string;
  context: string; // the "[CMSC 14100 …]" part of the title
  courseNumber: string | null;
  due: Date;
  allDay: boolean;
  end: Date | null;
  url: string;
  location: string;
}

export function canvasItems(text: string, tz = TZ): CanvasItem[] {
  const out: CanvasItem[] = [];
  for (const ev of parseIcs(text)) {
    const uid = ev.UID?.value?.trim();
    if (!uid) continue;
    const kind = uid.startsWith('event-assignment-') ? 'assignment' : uid.startsWith('event-calendar-event-') ? 'event' : null;
    if (!kind) continue;
    const s = icsTime(ev.DTSTART, tz);
    if (!s) continue;
    const e = icsTime(ev.DTEND, tz);
    const summary = unescapeText(ev.SUMMARY?.value || '').trim();
    const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(summary);
    const url = ev.URL?.value?.trim() || '';
    out.push({
      uid,
      kind,
      title: (m ? m[1] : summary).trim(),
      context: m ? m[2] : '',
      courseNumber: /course_(\d+)/.exec(url)?.[1] || null,
      // Canvas shows things due at 11:59 pm as all-day items.
      due: s.allDay ? zoned(s.ymd, '23:59', tz) : s.date,
      allDay: s.allDay,
      end: e && !e.allDay && +e.date > +s.date ? e.date : null,
      url,
      location: unescapeText(ev.LOCATION?.value || '').trim(),
    });
  }
  return out;
}

const WORD_NUM: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  first: '1', second: '2', third: '3',
};
const SYNONYM: Record<string, string> = { hw: 'homework', pset: 'problem', psets: 'problem', assignments: 'assignment', rd: 'draft' };
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'due', 'read']);

export const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean).map((w) => SYNONYM[w] || w).filter((w) => !STOP.has(w));

export function numbers(s: string) {
  const set = new Set<string>();
  for (const w of tokens(s)) {
    if (WORD_NUM[w]) set.add(WORD_NUM[w]);
    for (const d of w.match(/\d+/g) || []) set.add(String(+d));
  }
  return set;
}

/** Share of the shorter title's words that also appear in the other title (numbers ignored). */
export function similarity(a: string, b: string) {
  const words = (s: string) => new Set(tokens(s).filter((w) => !/^\d+$/.test(w) && !WORD_NUM[w]));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** "Assignment 7" and "Assignment 8" are different things even though the words match. */
export function sameNumbers(a: string, b: string) {
  const A = numbers(a);
  const B = numbers(b);
  if (!A.size && !B.size) return true;
  if (!A.size || !B.size) return false;
  return [...A].every((x) => B.has(x)) || [...B].every((x) => A.has(x));
}

export interface TaskLite {
  id: string; course_id: string | null; title: string; due_at: string | null; external_uid: string | null; hidden: boolean;
}

const DAY = 86400000;

/** A syllabus task that this Canvas item is the real version of, if there is one. */
export function findPlaceholder<T extends TaskLite>(item: CanvasItem, tasks: T[], courseId: string): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const t of tasks) {
    if (t.external_uid || t.hidden || t.course_id !== courseId) continue;
    if (t.due_at && Math.abs(+new Date(t.due_at) - +item.due) > 10 * DAY) continue;
    if (!sameNumbers(t.title, item.title)) continue;
    const score = similarity(t.title, item.title);
    if (score >= 0.6 && score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

export function guessType(title: string, kind: 'assignment' | 'event', allDay: boolean) {
  const t = title.toLowerCase();
  if (/\b(exam|midterm|quiz|test|assessment)\b/.test(t)) return 'exam';
  if (/\b(essay|paper|draft|prospectus|framework|tae)\b/.test(t)) return 'essay';
  if (/\b(reading|read)\b/.test(t)) return 'reading';
  if (kind === 'event') return allDay ? 'admin' : 'event';
  return 'assignment';
}

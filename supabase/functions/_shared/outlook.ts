// Turns your published Outlook calendar into "busy" blocks for the planner.
import { icsTime, occurrences, parseIcs, unescapeText, type VEvent } from './ics.ts';
import { TZ } from './time.ts';

export interface Busy { uid: string; title: string; location: string; starts_at: string; ends_at: string; all_day: boolean }

/** Class meetings from the registrar look like "CMSC 14100 Lecture - …". The app already knows those. */
export const CLASS_TITLE = /^[A-Z]{4}\s?\d{5}\b/;

const isSkipped = (ev: VEvent) =>
  (ev.STATUS?.value || '').toUpperCase() === 'CANCELLED' ||
  (ev['X-MICROSOFT-CDO-BUSYSTATUS']?.value || '').toUpperCase() === 'FREE' ||
  (ev.TRANSP?.value || '').toUpperCase() === 'TRANSPARENT';

export function busyFromIcs(text: string, from: Date, to: Date, tz = TZ): Busy[] {
  const masters: VEvent[] = [];
  const overrides = new Map<string, VEvent[]>();
  for (const ev of parseIcs(text)) {
    if (ev['RECURRENCE-ID']) {
      const k = ev.UID?.value || '';
      overrides.set(k, [...(overrides.get(k) || []), ev]);
    } else masters.push(ev);
  }
  const out: Busy[] = [];
  const add = (ev: VEvent, start: Date, end: Date, allDay: boolean, key: string) =>
    out.push({
      uid: `${ev.UID?.value || 'event'}|${key}`,
      title: unescapeText(ev.SUMMARY?.value || '').trim() || 'Busy',
      location: unescapeText(ev.LOCATION?.value || '').trim(),
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      all_day: allDay,
    });

  for (const ev of masters) {
    if (isSkipped(ev)) continue;
    // Single occurrences that were moved or changed are listed separately (RECURRENCE-ID).
    const changed = new Set((overrides.get(ev.UID?.value || '') || []).map((o) => +(icsTime(o['RECURRENCE-ID'], tz)?.date ?? 0)));
    for (const o of occurrences(ev, from, to, tz)) if (!changed.has(+o.start)) add(ev, o.start, o.end, o.allDay, o.key);
  }
  for (const list of overrides.values()) {
    for (const ev of list) {
      if (isSkipped(ev)) continue;
      const single = { ...ev };
      delete single.RRULE;
      for (const o of occurrences(single, from, to, tz)) add(ev, o.start, o.end, o.allDay, o.key);
    }
  }
  return out.sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
}

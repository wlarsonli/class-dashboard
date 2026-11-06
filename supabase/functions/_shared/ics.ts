// Reading and writing iCalendar (.ics) files: the Canvas feed, your published Outlook
// calendar, and the deadline calendar the dashboard publishes for Outlook.
import { parts, TZ, ymdIn, zoned } from './time.ts';

export interface Prop { params: Record<string, string>; value: string }
export type VEvent = Record<string, Prop>;

/** VEVENTs from an .ics file (nested blocks like VALARM are skipped). */
export function parseIcs(text: string): VEvent[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  const out: VEvent[] = [];
  let cur: VEvent | null = null;
  let depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      depth = 0;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) {
      depth++;
      continue;
    }
    if (line.startsWith('END:')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...rest] = line.slice(0, i).split(';');
    const params: Record<string, string> = {};
    for (const p of rest) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    const key = name.toUpperCase();
    const value = line.slice(i + 1);
    if (key === 'EXDATE' && cur.EXDATE) cur.EXDATE.value += `,${value}`;
    else if (!cur[key]) cur[key] = { params, value };
  }
  return out;
}

export const unescapeText = (s = '') => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// Outlook writes Windows time-zone names; these are the common ones.
const WINDOWS_TZ: Record<string, string> = {
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Central America Standard Time': 'America/Guatemala',
  'Mexico Standard Time': 'America/Mexico_City',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'E. Europe Standard Time': 'Europe/Bucharest',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

export function tzOf(tzid?: string, fallback = TZ): string {
  if (!tzid) return fallback;
  if (WINDOWS_TZ[tzid]) return WINDOWS_TZ[tzid];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return tzid;
  } catch {
    return fallback;
  }
}

export interface When { date: Date; allDay: boolean; ymd: string }

/** DTSTART / DTEND / EXDATE / RECURRENCE-ID values as instants. */
export function icsTime(prop: Prop | undefined, fallbackTz = TZ): When | null {
  if (!prop) return null;
  const v = prop.value.trim();
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const ymd = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    return { date: zoned(ymd, '00:00', fallbackTz), allDay: true, ymd };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[7]) {
    const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return { date, allDay: false, ymd: ymdIn(date, fallbackTz) };
  }
  return { date: zoned(ymd, `${m[4]}:${m[5]}`, tzOf(prop.params.TZID, fallbackTz)), allDay: false, ymd };
}

function durationMs(v: string) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = (((+(w || 0) * 7 + +(d || 0)) * 24 + +(h || 0)) * 60 + +(mi || 0)) * 60000 + +(s || 0) * 1000;
  return sign === '-' ? -ms : ms;
}

export interface Occurrence { start: Date; end: Date; allDay: boolean; key: string }

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY = 86400000;

/**
 * Occurrences of an event between `from` and `to`, following its RRULE (daily, weekly,
 * monthly, yearly with the usual options) minus EXDATEs. Times stay at the same wall-clock
 * time across daylight-saving changes.
 */
export function occurrences(ev: VEvent, from: Date, to: Date, fallbackTz = TZ): Occurrence[] {
  const s = icsTime(ev.DTSTART, fallbackTz);
  if (!s) return [];
  const e = icsTime(ev.DTEND, fallbackTz);
  const len = e ? +e.date - +s.date : ev.DURATION ? durationMs(ev.DURATION.value) : s.allDay ? DAY : 0;
  const rule = ev.RRULE?.value;
  if (!rule) {
    const end = new Date(+s.date + len);
    return +end > +from && +s.date < +to ? [{ start: s.date, end, allDay: s.allDay, key: String(+s.date) }] : [];
  }

  const r: Record<string, string> = {};
  for (const kv of rule.split(';')) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) r[k.toUpperCase()] = v;
  }
  const freq = r.FREQ;
  const interval = Math.max(1, +(r.INTERVAL || 1));
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? icsTime({ params: {}, value: r.UNTIL }, fallbackTz)?.date ?? null : null;
  const tz = s.allDay ? fallbackTz : ev.DTSTART.value.trim().endsWith('Z') ? 'UTC' : tzOf(ev.DTSTART.params.TZID, fallbackTz);
  const p0 = parts(s.date, tz);
  const hm = `${String(p0.h).padStart(2, '0')}:${String(p0.min).padStart(2, '0')}`;
  const start = Date.UTC(p0.y, p0.m - 1, p0.d);
  const startDow = new Date(start).getUTCDay();
  const mondayOf = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;

  const byDay = r.BYDAY
    ? r.BYDAY.split(',').map((x) => {
        const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim());
        return m ? { n: m[1] ? +m[1] : 0, dow: DAY_CODES.indexOf(m[2]) } : { n: 0, dow: -1 };
      })
    : null;
  const byMonthDay = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
  const byMonth = r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null;

  const ex = new Set<number>();
  if (ev.EXDATE) {
    for (const v of ev.EXDATE.value.split(',')) {
      const t = icsTime({ params: ev.EXDATE.params, value: v }, fallbackTz);
      if (t) ex.add(+t.date);
    }
  }

  const matches = (t: number) => {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const dom = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), month, 0)).getUTCDate();
    const nthMatch = (b: { n: number; dow: number }) =>
      b.dow === dow && (b.n === 0 || (b.n > 0 ? Math.ceil(dom / 7) === b.n : Math.ceil((daysInMonth - dom + 1) / 7) === -b.n));
    switch (freq) {
      case 'DAILY':
        return Math.round((t - start) / DAY) % interval === 0 && (!byDay || byDay.some((b) => b.dow === dow));
      case 'WEEKLY':
        return Math.round((mondayOf(t) - mondayOf(start)) / (7 * DAY)) % interval === 0 && (byDay ? byDay.some((b) => b.dow === dow) : dow === startDow);
      case 'MONTHLY': {
        const months = (d.getUTCFullYear() - new Date(start).getUTCFullYear()) * 12 + d.getUTCMonth() - new Date(start).getUTCMonth();
        if (months % interval !== 0) return false;
        if (byMonthDay) return byMonthDay.some((x) => (x > 0 ? x === dom : daysInMonth + x + 1 === dom));
        if (byDay) return byDay.some(nthMatch);
        return dom === new Date(start).getUTCDate();
      }
      case 'YEARLY': {
        const years = d.getUTCFullYear() - new Date(start).getUTCFullYear();
        if (years % interval !== 0) return false;
        if (byMonth && !byMonth.includes(month)) return false;
        if (byDay) return byDay.some(nthMatch);
        return month === new Date(start).getUTCMonth() + 1 && dom === new Date(start).getUTCDate();
      }
      default:
        return false;
    }
  };

  const out: Occurrence[] = [];
  let n = 0;
  const last = +to + DAY;
  for (let t = start; t <= last && t - start < 3660 * DAY; t += DAY) {
    if (!matches(t)) continue;
    const d = new Date(t);
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const inst = s.allDay ? zoned(ymd, '00:00', fallbackTz) : zoned(ymd, hm, tz);
    if (+inst < +s.date) continue;
    if (until && +inst > +until) break;
    n++;
    if (n > count) break;
    if (ex.has(+inst)) continue;
    const end = new Date(+inst + len);
    if (+inst >= +to) break;
    if (+end > +from) out.push({ start: inst, end, allDay: s.allDay, key: String(+inst) });
  }
  return out;
}

// ---------- Writing ----------

export const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export const stampUtc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Folds a content line to 75-byte chunks, as the format requires. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

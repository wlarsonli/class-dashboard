// Time-zone helpers. The server runs in UTC, so anything about "today" or "8 am"
// has to be worked out in your time zone (America/Chicago by default).

export const TZ = 'America/Chicago';
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();
const pad = (n: number) => String(n).padStart(2, '0');

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface Parts { y: number; m: number; d: number; h: number; min: number; s: number; dow: number }

/** Wall-clock parts of an instant in a time zone. */
export function parts(date: Date, tz = TZ): Parts {
  const p: Record<string, string> = {};
  for (const x of formatter(tz).formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, dow: DOWS.indexOf(p.weekday) };
}

export const ymdIn = (date: Date, tz = TZ) => {
  const p = parts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};

export const minutesIn = (date: Date, tz = TZ) => {
  const p = parts(date, tz);
  return p.h * 60 + p.min;
};

export const toMinutes = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** The instant when the clock in `tz` reads `dateStr` `hm` (handles daylight saving). */
export function zoned(dateStr: string, hm = '00:00', tz = TZ): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    if (shown === want) break;
    guess += want - shown;
  }
  return new Date(guess);
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings. */
export function addDaysYmd(dateStr: string, n: number) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export const dowOfYmd = (dateStr: string) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export function fmtTime(date: Date, tz = TZ) {
  const p = parts(date, tz);
  const h = p.h % 12 || 12;
  const ap = p.h < 12 ? 'am' : 'pm';
  return p.min ? `${h}:${pad(p.min)} ${ap}` : `${h} ${ap}`;
}

export const fmtHM = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  const ap = h < 12 ? 'am' : 'pm';
  return m ? `${h % 12 || 12}:${pad(m)} ${ap}` : `${h % 12 || 12} ${ap}`;
};

export function fmtMinutes(min: number) {
  min = Math.round(min || 0);
  if (min < 60) return `${min} min`;
  if (min % 30 === 0) return `${min / 60} h`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

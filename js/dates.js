// Date helpers. Everything here works in the device's local time zone.

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for a Date, in local time. */
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local midnight for a 'YYYY-MM-DD' string. */
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Whole calendar days from a to b (DST-safe). */
export const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

/** Monday of the week containing d. */
export function weekStart(d) {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
}

/** Local Date for a day string plus 'HH:MM'. */
export function atTime(dateStr, hm) {
  const d = parseYmd(dateStr);
  const [h, m] = hm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

export const toMinutes = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function fmtTime(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return m ? `${h}:${pad(m)} ${ap}` : `${h} ${ap}`;
}

export const fmtHM = (hm) => fmtTime(atTime('2000-01-01', hm));

/** '9:30–10:20 am', '11 am–12:20 pm' */
export function fmtRange(a, b) {
  const ap = (d) => (d.getHours() < 12 ? 'am' : 'pm');
  const t = (d) => {
    const h = d.getHours() % 12 || 12;
    const m = d.getMinutes();
    return m ? `${h}:${pad(m)}` : `${h}`;
  };
  return ap(a) === ap(b) ? `${t(a)}–${t(b)} ${ap(b)}` : `${t(a)} ${ap(a)}–${t(b)} ${ap(b)}`;
}

export function fmtDate(d, { weekday = true, year = false, long = false } = {}) {
  const wd = weekday ? `${(long ? DOW_LONG : DOW)[d.getDay()]}${long ? ',' : ''} ` : '';
  const mo = (long ? MON_LONG : MON)[d.getMonth()];
  return `${wd}${mo} ${d.getDate()}${year ? `, ${d.getFullYear()}` : ''}`;
}

/** 'Today', 'Tomorrow', 'Friday' (within a week), otherwise 'Fri Nov 13'. */
export function relDay(d, now = new Date()) {
  const n = dayDiff(now, d);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return DOW_LONG[d.getDay()];
  return fmtDate(d);
}

export function fmtDue(iso, now = new Date()) {
  if (!iso) return 'No due date';
  const d = new Date(iso);
  return `${relDay(d, now)}, ${fmtTime(d)}`;
}

export function countdown(d, now = new Date()) {
  const n = dayDiff(now, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n < 0) return `${-n} days ago`;
  return `in ${n} days`;
}

/** 45 → '45 min', 90 → '1.5 h', 75 → '1 h 15 min' */
export function fmtMinutes(min) {
  min = Math.round(min || 0);
  if (min < 60) return `${min} min`;
  if (min % 30 === 0) return `${min / 60} h`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Days array (0 = Sunday) as 'MWF', 'TTh', or 'Wednesdays' for a single day. */
export function fmtDays(days = []) {
  if (days.length === 1) return `${DOW_LONG[days[0]]}s`;
  const L = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => L[d]).join('');
}

/** ISO string for a local date ('YYYY-MM-DD') and time ('HH:MM'). */
export const toIso = (dateStr, hm = '23:59') => atTime(dateStr, hm).toISOString();

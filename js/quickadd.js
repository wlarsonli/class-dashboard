// Turns "cs hw6 fri 5pm ~3h !" into a task: class, due date/time, estimate, priority.
import { addDays, fmtDate, fmtMinutes, fmtTime, startOfDay } from './dates.js';

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};
const FILLER = new Set(['due', 'by', 'on', 'at', 'before']);
const SUBJECT_ALIASES = {
  CMSC: ['cs', 'comp', 'compsci', 'cmsc'],
  MATH: ['math', 'calc', 'calculus'],
  WRIT: ['writ', 'writing', 'ica'],
  HUMA: ['huma', 'hum', 'phil', 'philosophy'],
};
const PRIORITY = { high: 3, hi: 3, h: 3, med: 2, medium: 2, m: 2, low: 1, lo: 1, l: 1 };

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

export function courseAliases(c) {
  const set = new Set();
  const add = (s) => {
    const n = norm(s);
    if (n) set.add(n);
  };
  add(c.short);
  add(c.code);
  if (c.kind === 'category') add(c.name);
  const m = /^([A-Za-z]+)\s*(\d+)/.exec(c.code || '');
  if (m) {
    add(m[1]);
    add(m[2]);
    (SUBJECT_ALIASES[m[1].toUpperCase()] || []).forEach(add);
  }
  (c.aliases || []).forEach(add);
  return set;
}

function to24(h, m, ap) {
  const p = ap[0];
  if (p === 'p' && h < 12) h += 12;
  if (p === 'a' && h === 12) h = 0;
  return { h, m };
}

export function parseQuickAdd(text, courses = [], now = new Date()) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase().replace(/[.,;:]+$/, ''));
  const used = tokens.map(() => false);
  const today = startOfDay(now);
  let course = null;
  let date = null;
  let time = null;
  let estimate = null;
  let priority = 0;

  const aliasList = courses.filter((c) => !c.archived).map((c) => [c, courseAliases(c)]);
  for (let i = 0; i < tokens.length && !course; i++) {
    const hit = aliasList.find(([, al]) => al.has(lower[i].replace(/^#/, '')));
    if (!hit) continue;
    course = hit[0];
    used[i] = true;
    const next = lower[i + 1]?.replace(/^#/, '');
    if (next && hit[1].has(next)) used[i + 1] = true; // "cmsc 14100"
  }

  const mkDate = (month, day, year) => {
    const y = year ? (year < 100 ? 2000 + year : year) : now.getFullYear();
    let d = new Date(y, month, day);
    if (!year && d < addDays(today, -60)) d = new Date(y + 1, month, day);
    return d;
  };

  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    const t = lower[i];
    const nx = lower[i + 1] || '';
    let m;
    if (/^!{1,3}$/.test(t)) {
      priority = 3;
      used[i] = true;
    } else if ((m = /^!(\w+)$/.exec(t)) && PRIORITY[m[1]]) {
      priority = PRIORITY[m[1]];
      used[i] = true;
    } else if ((m = /^~?(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours)$/.exec(t))) {
      estimate = Math.round(parseFloat(m[1]) * 60);
      used[i] = true;
    } else if ((m = /^~?(\d+)(m|min|mins|minute|minutes)$/.exec(t))) {
      estimate = parseInt(m[1], 10);
      used[i] = true;
    } else if ((m = /^~(\d+(?:\.\d+)?)$/.exec(t))) {
      estimate = Math.round(parseFloat(m[1]) * 60);
      used[i] = true;
    } else if (t === 'today') {
      date = today;
      used[i] = true;
    } else if (t === 'tonight') {
      date = today;
      time = time || { h: 23, m: 59 };
      used[i] = true;
    } else if (['tomorrow', 'tmrw', 'tmr', 'tomorow'].includes(t)) {
      date = addDays(today, 1);
      used[i] = true;
    } else if (t in WEEKDAYS) {
      let ahead = (WEEKDAYS[t] - today.getDay() + 7) % 7;
      if (i > 0 && lower[i - 1] === 'next' && !used[i - 1]) {
        ahead += 7;
        used[i - 1] = true;
      }
      date = addDays(today, ahead);
      used[i] = true;
    } else if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t))) {
      date = mkDate(+m[1] - 1, +m[2], m[3] ? +m[3] : 0);
      used[i] = true;
    } else if (t in MONTHS && /^\d{1,2}(st|nd|rd|th)?$/.test(nx)) {
      date = mkDate(MONTHS[t], parseInt(nx, 10));
      used[i] = used[i + 1] = true;
      i++;
    } else if (t === 'in' && /^\d+$/.test(nx) && /^(day|days|week|weeks)$/.test(lower[i + 2] || '')) {
      date = addDays(today, +nx * (lower[i + 2].startsWith('week') ? 7 : 1));
      used[i] = used[i + 1] = used[i + 2] = true;
      i += 2;
    } else if (t === 'noon') {
      time = { h: 12, m: 0 };
      used[i] = true;
    } else if (t === 'midnight' || t === 'eod') {
      time = { h: 23, m: 59 };
      used[i] = true;
    } else if ((m = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)$/.exec(t))) {
      time = to24(+m[1], +(m[2] || 0), m[3]);
      used[i] = true;
    } else if ((m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t)) && /^(am|pm)$/.test(nx)) {
      time = to24(+m[1], +(m[2] || 0), nx);
      used[i] = used[i + 1] = true;
      i++;
    } else if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) {
      let h = +m[1];
      const mi = +m[2];
      if (h < 8 || (h <= 11 && mi === 59)) h += 12; // "5:30" means pm, "11:59" means 11:59 pm
      time = { h: h % 24, m: mi };
      used[i] = true;
    } else if (t === 'at' && /^\d{1,2}$/.test(nx)) {
      let h = +nx;
      if (h < 8) h += 12;
      time = { h, m: 0 };
      used[i] = used[i + 1] = true;
      i++;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!used[i] && FILLER.has(lower[i]) && used[i + 1]) used[i] = true;
  }

  let due = null;
  if (date || time) {
    due = new Date(date || today);
    const tm = time || { h: 23, m: 59 };
    due.setHours(tm.h, tm.m, 0, 0);
    if (!date && due < now) due = addDays(due, 1);
  }

  let title = tokens.filter((_, i) => !used[i]).join(' ').trim();
  title = title.replace(/\bhw\s?(\d+)\b/gi, 'Homework $1').replace(/\bpset\s?(\d+)\b/gi, 'Problem set $1');
  if (title) title = title[0].toUpperCase() + title.slice(1);

  const lt = title.toLowerCase();
  let type = 'task';
  if (/\b(exam|midterm|final|quiz|test|assessment)\b/.test(lt)) type = 'exam';
  else if (/\b(read|reading|chapter|ch|book)\b/.test(lt)) type = 'reading';
  else if (/\b(essay|paper|draft|prospectus)\b/.test(lt)) type = 'essay';
  else if (/\b(homework|pset|problem set|assignment|lab|project|edfinity|exercise|worksheet)\b/.test(lt)) type = 'assignment';
  else if (course?.kind === 'class') type = 'assignment';

  return { title, course, course_id: course?.id || null, due, due_at: due ? due.toISOString() : null, estimate_minutes: estimate, priority, type };
}

/** Short labels for the live preview under the quick-add box. */
export function describeQuickAdd(p) {
  const bits = [];
  if (p.course) bits.push(p.course.short || p.course.name);
  if (p.due) bits.push(`${fmtDate(p.due)}, ${fmtTime(p.due)}`);
  if (p.estimate_minutes) bits.push(`~${fmtMinutes(p.estimate_minutes)}`);
  if (p.priority) bits.push(['', 'Low', 'Medium', 'High'][p.priority] + ' priority');
  return bits;
}

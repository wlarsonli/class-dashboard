// Understands plain-English changes to your plan, for example:
//   "clear up 5-7pm so I can play basketball"  → a new event, and work moves out of the way
//   "basketball every tue and thu 5-7"         → a weekly event
//   "lift for 1 hour after class"              → an event right after your last class
//   "take saturday off" · "only 2 hours of work tomorrow" · "no work after 9 tonight"
//   "move the essay to sunday" · "do cs homework tomorrow at 3" · "study math 2-4"
//   "skip math study today" · "cancel basketball tomorrow" · "math class is cancelled friday"
//   "study 3 hours a day for the midterm" · "when am I free tomorrow?" · "re-plan"
// interpret() only reads your data. state.applyCommand() makes the change.
import { addDays, atTime, DOW, DOW_LONG, fmtDate, fmtHM, fmtMinutes, fmtRange, parseYmd, relDay, startOfDay, toMinutes, ymd } from './dates.js';
import { DEFAULT_WINDOW, dayLimit, freeGaps, hm, studyPlanOf } from './planner.js';
import { courseAliases, describeQuickAdd, parseQuickAdd } from './quickadd.js';
import { busyOn, eventsOn, meetingsOn } from './term.js';

// ---------- Words ----------

const DAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, couple: 2, few: 3 };

const DAY = String.raw`(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)`;
const DAYS_PL = String.raw`(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)`;
const SEP = String.raw`\s*(?:,|/|&|\+|\band\b|\bor\b)\s*`;
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
// A clock time: "5", "5pm", "5:30 p.m.", "17:00", "noon".
const T = String.raw`(?:noon|midnight|(?<![\d:/.])\d{1,2}(?::[0-5]\d)?(?:\s?(?:a\.?m\.?|p\.?m\.?|a|p)(?![a-z]))?(?![\d/]))`;

const dayNum = (w) => {
  w = w.toLowerCase().replace(/\.$/, '');
  if (DAYS[w] !== undefined) return DAYS[w];
  if (w.endsWith('s') && DAYS[w.slice(0, -1)] !== undefined) return DAYS[w.slice(0, -1)];
  return null;
};

// Words that don't help find a task or event.
const STOP = new Set(
  `a an the my me i i'm im to for so that can could on at in of and or up off out from until till til please some time it its
  this next is am be will want wanna gonna going need like would let lets let's make get just also then with do doing does did
  work working session sessions block blocks plan planned today tomorrow tonight day days week all any everything anything about by
  after before around later earlier back again now more less hours hour minutes mins min h hr hrs am pm instead rest
  move moving push shift reschedule change switch bump put cancel delete remove drop skip scratch forget not no don't dont
  study studying finish start tackle focus knock write read reading's i've ive got have has had going there their our your one`
    .split(/\s+/)
    .filter(Boolean),
);
// Course nicknames that are also everyday words.
const COMMON_ALIAS = new Set(['me', 'i', 'a', 'an', 'to', 'for', 'my', 'admin']);

const TYPE_WORDS = [
  ['exam', /\b(stud(y|ying)|exam|midterm|final|quiz|test|assessment|review|prep)\b/],
  ['reading', /\b(read|reading|readings|chapters?|book)\b/],
  ['essay', /\b(essay|paper|draft|prospectus|writing|write)\b/],
  ['assignment', /\b(homework|hw|psets?|p-sets?|problem sets?|problems|assignment|edfinity|exercises?|lab|project|worksheet)\b/],
];

const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));

const minsOf = (d) => d.getHours() * 60 + d.getMinutes();
const roundUp = (m, step = 5) => Math.ceil(m / step) * step;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------- Scanning ----------

/** Text being read: each piece that's understood gets masked out, and what's left is the title. */
class Scan {
  constructor(s) {
    this.m = s;
  }

  take(re, fn = () => true) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let any = false;
    for (const x of [...this.m.matchAll(g)]) {
      if (x[0].includes('|') || fn(x) === false) continue;
      this.m = this.m.slice(0, x.index) + '|'.repeat(x[0].length) + this.m.slice(x.index + x[0].length);
      any = true;
    }
    return any;
  }

  rest() {
    return this.m.replace(/\|+/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/** "5" → { h: 5, mi: 0 } (am or pm unknown), "5pm" / "17:00" / "noon" → { m: 1020 }. */
function parseT(str) {
  const s = str.toLowerCase().replace(/\./g, '').trim();
  if (s === 'noon') return { m: 720 };
  if (s === 'midnight') return { m: 1440 };
  const x = /^(\d{1,2})(?::(\d{2}))?\s?([ap])?/.exec(s);
  if (!x) return null;
  const h = +x[1];
  const mi = +(x[2] || 0);
  if (h > 24 || mi > 59) return null;
  if (x[3]) {
    if (h > 12 || h === 0) return null;
    return { m: ((h % 12) + (x[3] === 'p' ? 12 : 0)) * 60 + mi };
  }
  if (h >= 13 || h === 0) return { m: Math.min(1440, h * 60 + mi) };
  return { h, mi };
}

const amOf = (t) => (t.h % 12) * 60 + t.mi;
const pmOf = (t) => ((t.h % 12) + 12) * 60 + t.mi;

/** Picks am or pm for a time like "7": evenings for 1–7, mornings for 8–11, unless that's already past today. */
function guess(t, { prefer = null, date, now }) {
  if (t.m !== undefined) return t.m;
  if (t.h === 12) return 720 + t.mi;
  if (prefer === 'am') return amOf(t);
  if (prefer === 'pm') return pmOf(t);
  let v = t.h <= 7 ? pmOf(t) : amOf(t);
  if (date === ymd(now) && v < 720 && v < minsOf(now)) v = pmOf(t);
  return v;
}

function resolveRange(a, b, opts) {
  const same = (t, ref) => (t.h === 12 ? 720 + t.mi : ref >= 720 ? pmOf(t) : amOf(t));
  let s;
  let e;
  if (a.m !== undefined && b.m !== undefined) [s, e] = [a.m, b.m];
  else if (b.m !== undefined) {
    e = b.m;
    s = same(a, e);
    if (s >= e) s = amOf(a); // "11-1pm" is 11 am to 1 pm
  } else if (a.m !== undefined) {
    s = a.m;
    e = same(b, s);
    if (e <= s) e += 720; // "11am-1" is 11 am to 1 pm
  } else {
    s = guess(a, opts);
    e = same(b, s);
    if (e <= s) e += 720;
  }
  if (e > 1440) e = 1440;
  return e > s ? [s, e] : null;
}

// ---------- Finding tasks and events ----------

function courseHits(text, courses) {
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  return courses.filter((c) => !c.archived && [...courseAliases(c)].some((a) => !COMMON_ALIAS.has(a) && words.has(a)));
}

/** The task you most likely mean ("math study", "the essay", "cs hw 7"), or null. */
function findTask(text, state, { dates = [], now }) {
  const words = tokens(text);
  const named = courseHits(text, state.courses || []);
  const types = TYPE_WORDS.filter(([, re]) => re.test(text)).map(([k]) => k);
  const nums = words.filter((w) => /^\d+$/.test(w));
  const today = ymd(now);
  let best = null;
  for (const t of state.tasks || []) {
    if (t.hidden || t.status === 'done' || t.type === 'event') continue;
    if (t.due_at && new Date(t.due_at) < startOfDay(now)) continue;
    const course = (state.courses || []).find((c) => c.id === t.course_id);
    if (named.length && !named.some((c) => c.id === t.course_id)) continue;
    const title = new Set(tokens(t.title));
    let score = 0;
    let why = 0;
    if (named.length) {
      score += 4;
      if (course?.kind === 'class') why++;
    }
    if (types.includes(t.type)) {
      score += 2.5;
      why++;
    } else if (types.length) score -= 2;
    for (const w of words) {
      if (title.has(w)) {
        score += /^\d+$/.test(w) ? 3 : 2;
        why += 2;
      }
    }
    for (const n of nums) if (!title.has(n) && !(course && courseAliases(course).has(n))) score -= 4;
    const plan = (t.plan || []).filter((s) => s.date >= today);
    if (dates.some((d) => plan.some((s) => s.date === d))) score += 1.5;
    if (plan.length) score += 0.5;
    if (t.due_at) score += 1 / (1 + Math.max(0, (new Date(t.due_at) - now) / 86400000));
    if (!why || score < 3) continue;
    if (!best || score > best.score) best = { t, score, strong: why >= 2 };
  }
  return best;
}

function findEvent(text, state, dates) {
  const words = tokens(text);
  let best = null;
  for (const ev of state.events || []) {
    const title = new Set(tokens(ev.title));
    const hits = words.filter((w) => title.has(w)).length;
    if (!hits) continue;
    const on = dates.some((d) => eventsOn(d, { events: [ev] }).length);
    const score = hits + (on ? 0.5 : 0);
    if (!best || score > best.score) best = { ev, score };
  }
  return best?.ev || null;
}

/** The next day (from `from`) this event happens. */
function nextOccurrence(ev, from, limit = 60) {
  for (let i = 0, d = parseYmd(from); i < limit; i++, d = addDays(d, 1)) {
    if (eventsOn(ymd(d), { events: [ev] }).length) return ymd(d);
  }
  return null;
}

const taskName = (t, state) => {
  const c = (state.courses || []).find((x) => x.id === t.course_id);
  const title = t.type === 'exam' ? `Study: ${t.title}` : t.title;
  return c && c.kind === 'class' ? `${c.short} ${title}` : title;
};

// ---------- Reading the text ----------

function readDates(scan, ctx) {
  const { now, state } = ctx;
  const today = startOfDay(now);
  const out = { dates: [], repeat: null, until: null, part: null, daily: false, weeklyWord: false, from: null };
  const add = (d, x) => out.dates.push({ d: ymd(d), at: x.index, to: /\bto\s*$/.test(scan.m.slice(Math.max(0, x.index - 4), x.index)), fromWord: /\bfrom\s*$/.test(scan.m.slice(Math.max(0, x.index - 6), x.index)) });
  const upcoming = (dow, next = false) => addDays(today, ((dow - today.getDay() + 7) % 7) + (next ? 7 : 0));
  const listDays = (s) => [...new Set(s.split(/[^a-z]+/).map(dayNum).filter((x) => x !== null))].sort();

  // Repeats: "every tue and thu", "tuesdays", "weekdays", "mwf", "on class days", "every day".
  scan.take(/\b(?:every|each)\s+(?:single\s+)?day\b|\beveryday\b|\bdaily\b/, () => {
    out.repeat = [0, 1, 2, 3, 4, 5, 6];
  });
  scan.take(/\b(?:every|on)\s+weekdays?\b|\bweekdays\b|\bmon(?:day)?\s*(?:-|to|thru|through)\s*fri(?:day)?\b/, () => {
    out.repeat = [1, 2, 3, 4, 5];
  });
  scan.take(/\b(?:every|on)\s+weekends?\b|\bweekends\b/, () => {
    out.repeat = [0, 6];
  });
  scan.take(/\b(?:on\s+)?(?:my\s+)?class\s+days\b|\bevery\s+class\s+day\b|\bdays\s+i\s+have\s+class(?:es)?\b/, () => {
    out.repeat = [...new Set((state.meetings || []).flatMap((m) => m.days || []))].sort();
  });
  scan.take(new RegExp(String.raw`\b(?:every|each)\s+(${DAY}(?:${SEP}${DAY})*)\b`), (x) => {
    out.repeat = listDays(x[1]);
  });
  scan.take(new RegExp(String.raw`\b(?:on\s+)?(${DAYS_PL}(?:${SEP}${DAYS_PL})*)\b`), (x) => {
    out.repeat = listDays(x[1]);
  });
  // Class-schedule shorthand: "mwf", "tth", "tuth"
  const CODES = { mwf: [1, 3, 5], mw: [1, 3], wf: [3, 5], mf: [1, 5], tth: [2, 4], tuth: [2, 4], tr: [2, 4], mtwthf: [1, 2, 3, 4, 5], mtwrf: [1, 2, 3, 4, 5] };
  scan.take(/\b(on\s+|every\s+)?(mwf|mw|wf|mf|tth|tuth|tr|mtwthf|mtwrf)\b/, (x) => {
    if (x[2] === 'tr' && !x[1]) return false;
    out.repeat = CODES[x[2]];
  });
  scan.take(/\b(?:every|each)\s+week\b|\bweekly\b|\bevery\s+other\s+week\b/, () => {
    out.weeklyWord = true;
  });

  // How long a weekly event lasts.
  const termEnd = state.settings?.term?.end || state.settings?.term?.classes_end || null;
  scan.take(/\b(?:until|till|til|through|thru)\s+(?:the\s+)?(?:end\s+of\s+(?:the\s+)?)?(?:quarter|term|semester|classes|finals)\b|\bfor\s+the\s+(?:rest\s+of\s+the\s+)?(?:quarter|term|semester)\b/, () => {
    out.until = termEnd;
  });
  scan.take(/\bfor\s+(\d+|two|three|four|five|six|seven|eight)\s+weeks\b/, (x) => {
    out.untilWeeks = NUM[x[1]] || +x[1];
  });
  scan.take(new RegExp(String.raw`\b(?:until|till|til|through|thru)\s+(?:(?:the\s+)?(${MONTH})\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})/(\d{1,2})|(?:next\s+)?(${DAY}))\b`), (x) => {
    if (x[1]) out.until = ymd(mkDate(MONTHS[x[1].slice(0, 3)] ?? MONTHS[x[1]], +x[2], today));
    else if (x[3]) out.until = ymd(mkDate(+x[3] - 1, +x[4], today));
    else out.until = ymd(upcoming(dayNum(x[5]), /next/.test(x[0])));
  });

  // Days: "today", "tomorrow night", "friday", "next tue", "nov 12", "11/12", "this weekend".
  scan.take(/\bday\s+after\s+tomorrow\b/, (x) => add(addDays(today, 2), x));
  const PART = String.raw`(?:\s+(morning|afternoon|evening|night)\b)?`;
  scan.take(new RegExp(String.raw`\b(?:tomorrow|tmrw|tmrrw|tmr|tmrow|tomm?or+o?w|tomm?or+ow|tomorro|tomrrow|tomrow)\b${PART}`), (x) => {
    add(addDays(today, 1), x);
    if (x[1]) out.part = x[1];
  });
  scan.take(/\btonight\b/, (x) => {
    add(today, x);
    out.part = 'night';
  });
  scan.take(/\bthis\s+(morning|afternoon|evening)\b/, (x) => {
    add(today, x);
    out.part = x[1];
  });
  scan.take(/\btoday\b/, (x) => add(today, x));
  scan.take(/\b(this|next|the|coming)?\s*weekend\b/, (x) => {
    const sat = upcoming(6, x[1] === 'next');
    if (today.getDay() === 0 && x[1] !== 'next') add(today, x);
    else {
      add(sat, x);
      add(addDays(sat, 1), x);
    }
  });
  scan.take(new RegExp(String.raw`\b(?:(this|next|coming|on)\s+)?(${DAY})\b(?!\s*(?:-|to)\s*${DAY})${PART}`), (x) => {
    const n = dayNum(x[2]);
    if (n === null) return false;
    add(upcoming(n, x[1] === 'next'), x);
    if (x[3]) out.part = x[3];
    if (!x[1] || x[1] === 'on') out.bareDays = (out.bareDays || 0) + 1;
  });
  scan.take(new RegExp(String.raw`\b(?:on\s+)?(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`), (x) => add(mkDate(MONTHS[x[1]] ?? MONTHS[x[1].slice(0, 3)], +x[2], today), x));
  scan.take(new RegExp(String.raw`\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH})\b`), (x) => add(mkDate(MONTHS[x[2]] ?? MONTHS[x[2].slice(0, 3)], +x[1], today), x));
  scan.take(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (x) => add(mkDate(+x[1] - 1, +x[2], today, x[3] ? +x[3] : 0), x));
  scan.take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/, (x) => {
    let d = new Date(today.getFullYear(), today.getMonth(), +x[1]);
    if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, +x[1]);
    add(d, x);
  });
  scan.take(/\bin\s+(\d+|a|one|two|three|four|five|six)\s+(days?|weeks?)\b/, (x) => add(addDays(today, (NUM[x[1]] || +x[1]) * (x[2].startsWith('week') ? 7 : 1)), x));

  return out;
}

/** "in the morning", "this afternoon", "my evening". Only read when there's no clock time ("movie night 8-11" keeps its name). */
function readPart(scan) {
  let part = null;
  scan.take(/\b(?:in\s+the\s+|at\s+|this\s+|my\s+|the\s+)?(morning|afternoon|evening|night|lunch(?:time)?)\b/, (x) => {
    part = x[1].startsWith('lunch') ? 'lunch' : x[1];
  });
  return part;
}

/** "every Tue & Thu", "every weekday". */
function fmtRepeat(days) {
  const k = [...days].sort().join('');
  if (k === '0123456') return 'every day';
  if (k === '12345') return 'every weekday';
  if (k === '06') return 'every weekend';
  if (days.length === 1) return `every ${DOW_LONG[days[0]]}`;
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW[d]);
  return `every ${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
}

function mkDate(month, day, today, year = 0) {
  const y = year ? (year < 100 ? 2000 + year : year) : today.getFullYear();
  let d = new Date(y, month, day);
  if (!year && d < addDays(today, -60)) d = new Date(y + 1, month, day);
  return d;
}

/** "for 2 hours", "90 min", "an hour and a half", "~3h", and "2 hours a day". */
function readDurations(scan) {
  const out = { minutes: null, daily: false };
  const tail = String.raw`(?:\s+(?:a|per|each|every)\s+day\b|\s+daily\b)?`;
  const set = (m, x) => {
    out.minutes = Math.round(m);
    if (/(?:\b(?:a|per|each|every)\s+day|\bdaily)$/.test(x[0])) out.daily = true;
  };
  scan.take(new RegExp(String.raw`\b(?:for\s+)?(?:an?\s+)?(?:hour\s+and\s+a\s+half|one\s+and\s+a\s+half\s+hours?)${tail}`), (x) => set(90, x));
  scan.take(new RegExp(String.raw`\b(?:for\s+)?half\s+(?:an\s+)?hour${tail}`), (x) => set(30, x));
  scan.take(
    new RegExp(String.raw`(?:\bfor\s+|~)?(?:(?<![\w.])(\d+(?:\.\d+)?)|\b(an?|one|two|three|four|five|six|seven|eight|(?:a\s+)?couple(?:\s+of)?|(?:a\s+)?few))\s?(?:(hours?|hrs?|h)|(minutes?|mins?|m))(\s+and\s+a\s+half)?(?![a-z])${tail}`),
    (x) => {
      const n = x[1] ? parseFloat(x[1]) : NUM[x[2].replace(/^a\s+/, '').replace(/\s+of$/, '')] || 1;
      const m = x[3] ? n * 60 + (x[5] ? 30 : 0) : n;
      if (!m || m > 16 * 60) return false;
      set(m, x);
    },
  );
  return out;
}

/** "push it back an hour", "30 minutes earlier" (read before durations, which would take "an hour"). */
function readShift(scan) {
  let shift = 0;
  const AMT = String.raw`(an?\s+hour|half\s+an\s+hour|\d+(?:\.\d+)?\s?(?:hours?|hrs?|h|minutes?|mins?|m))(?![a-z])`;
  const amount = (a) => (/half/.test(a) ? 30 : /^an?\s+hour/.test(a) ? 60 : /\d\s?(?:hours?|hrs?|h)$/.test(a) ? parseFloat(a) * 60 : parseFloat(a));
  scan.take(new RegExp(String.raw`\b(back|later|forward|earlier|up)\s+(?:by\s+)?${AMT}`), (x) => {
    shift = (/earlier|forward|up/.test(x[1]) ? -1 : 1) * amount(x[2]);
  });
  scan.take(new RegExp(String.raw`\b${AMT}\s+(later|earlier|back)\b`), (x) => {
    shift = (x[2] === 'earlier' ? -1 : 1) * amount(x[1]);
  });
  return shift;
}

function readTimes(scan, ctx, d0) {
  const { state, now } = ctx;
  const out = { range: null, from: null, to: null, point: null, toPoint: null, anchor: null };
  const opts = { prefer: ctx.prefer, date: d0, now };
  const num = String.raw`\b(hw|homework|pset|set|chapters?|ch|weeks?|lab|parts?|problems?|pages?|pp|ex|exercises?|assignment|unit|lectures?|section|ps|q|question|questions|room)\s*$`;
  const numbering = (x) => new RegExp(num).test(scan.m.slice(Math.max(0, x.index - 14), x.index));

  // Right after or before class.
  const aliasRe = (state.courses || [])
    .filter((c) => c.kind === 'class' && !c.archived)
    .flatMap((c) => [...courseAliases(c)].filter((a) => !/^\d+$/.test(a)).map((a) => [a, c]));
  const alias = aliasRe.map(([a]) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  scan.take(/\b(?:right\s+)?(after|before)\s+(?:(?:my|the)\s+)?(?:(?:last|first)\s+)?(?:class|classes|school|lecture)\b/, (x) => {
    out.anchor = { side: x[1], course: null };
  });
  if (alias) {
    scan.take(new RegExp(String.raw`\b(?:right\s+)?(after|before)\s+(?:my\s+)?(${alias})(?:\s+(?:class|lecture|section|seminar|discussion|lab))?\b`), (x) => {
      out.anchor = { side: x[1], course: aliasRe.find(([a]) => a === x[2])[1] };
    });
  }

  // Ranges: "5-7pm", "from 5 to 7", "between 2 and 4", "noon-2".
  scan.take(new RegExp(String.raw`\bbetween\s+(${T})\s+and\s+(${T})`), (x) => {
    const r = parseT(x[1]) && parseT(x[2]) && resolveRange(parseT(x[1]), parseT(x[2]), opts);
    if (!r) return false;
    out.range = r;
  });
  scan.take(new RegExp(String.raw`(?:\bfrom\s+)?(${T})\s*(?:-|–|\bto\b|\buntil\b|\btill\b|\btil\b|\bthru\b|\bthrough\b)\s*(${T})`), (x) => {
    if (numbering(x) || out.range) return false;
    const a = parseT(x[1]);
    const b = parseT(x[2]);
    const r = a && b && resolveRange(a, b, opts);
    if (!r) return false;
    out.range = r;
  });
  // Bounds: "after 9", "before 10", "until 11", "starting at 2".
  scan.take(new RegExp(String.raw`\b(?:after|past)\s+(${T})`), (x) => {
    const t = parseT(x[1]);
    if (!t) return false;
    out.from = guess(t, { ...opts, prefer: ctx.prefer || 'pm' });
  });
  scan.take(new RegExp(String.raw`\b(?:starting|beginning)\s+(?:at\s+)?(${T})|\bfrom\s+(${T})(?:\s+on(?:wards?)?)?`), (x) => {
    const t = parseT(x[1] || x[2]);
    if (!t) return false;
    out.from = guess(t, opts);
  });
  scan.take(new RegExp(String.raw`\b(before|until|till|til|by)\s+(${T})`), (x) => {
    if (x[1] === 'by' && !/\b(done|finish|finished|stop|home|back)\b/.test(scan.m)) return false;
    const t = parseT(x[2]);
    if (!t) return false;
    out.to = guess(t, opts);
  });
  scan.take(new RegExp(String.raw`\bto\s+(${T})`), (x) => {
    if (numbering(x)) return false;
    const t = parseT(x[1]);
    if (!t) return false;
    out.toPoint = guess(t, opts);
  });
  scan.take(new RegExp(String.raw`(?:\bat|@)\s*(${T})`), (x) => {
    const t = parseT(x[1]);
    if (!t) return false;
    out.point = guess(t, opts);
  });
  scan.take(/(?<![\d:/.])(\d{1,2}(?::[0-5]\d)?\s?(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:[0-5]\d)(?![\d/])|\bnoon\b/, (x) => {
    if (numbering(x)) return false;
    const t = parseT(x[0]);
    if (!t) return false;
    out.point ??= guess(t, opts);
  });
  return out;
}

// ---------- Interpreting ----------

const RX = {
  undo: /^(?:undo|undo (?:that|it|the last (?:one|change)))$/,
  replan: /\b(?:re-?plan|reshuffle|rebalance|reorganize|re-?organise|redo (?:my |the )?(?:plan|schedule|week|day)|start over)\b/,
  free: /\b(?:when am i free|when (?:am i|i'?m) not busy|when do i have (?:free )?time|what(?:'s| is) free|free time\?|how much (?:free )?time|am i free|what(?:'s| is) left|what does my (?:day|schedule) look like|any free time)\b/,
  clearLimit: /\b(?:work again|back to normal|normal day|regular day|undo (?:the |my )?day off|cancel (?:the |my )?day off|remove (?:the |my )?(?:limit|day off)|no limit|plan (?:work|stuff|things)(?: on)? again|not a day off|not taking (?:the day |it )?off)\b/,
  dayOff: /\b(?:day off|off day|free day|rest day|no work|no homework|no studying|no school ?work|nothing planned|don'?t (?:plan|schedule|put) (?:anything|any work|work|stuff)|do not (?:plan|schedule)|take (?:the (?:whole )?day |it )?off|taking (?:the (?:whole )?day |it )?off|(?:i'?m|i am) off|keep (?:it|the day|the whole day) free|clear (?:my |the )?(?:whole )?(?:day|schedule)|clear everything|cancel everything|nothing|(?:i'?m|i am|feeling) sick|sick day)\b/,
  limit: /\b(?:only|just|max(?:imum)?|at most|no more than|up to|cap(?: it)?(?: at)?|limit(?: it)?(?: to)?|i can (?:only )?(?:work|do|study)|i have (?:only )?)\b/,
  light: /\b(?:light|easy|chill|short|lighter|easier) day\b|\btake it easy\b/,
  cancel: /\b(?:cancel(?:l?ed)?|delete|remove|drop|skip|skipping|scratch|forget(?: about)?|not going(?: to)?|no longer|can'?t make(?: it)?|cannot make|won'?t (?:make it|go|be going)|not doing|don'?t do|do not do|not (?:playing|going|having|doing)|isn'?t happening|is off|got cancel(?:l?ed)?|called off|no(?= (?:\w+ )?(?:class|classes|lecture|seminar|section|discussion)\b))\b/,
  move: /\b(?:move|moved|push|pushed|shift|reschedule|change|switch|bump|put off|slide)\b/,
  work: /\b(?:study|studying|work on|working on|do|doing|finish|finishing|start|starting|get to|knock out|tackle|focus on|write|writing|read)\b/,
  block: /\b(?:clear(?: up| out)?|free(?: up)?|block(?: off| out)?|reserve|save|hold|keep|make time|set aside|add|schedule|put|book|i have|i'?ve got|i got|i'?ll be|i will be|i'?m going|i am going|going to|gonna|busy|leave|need time)\b/,
  freeWord: /\b(?:clear|free|open|off|no work|nothing)\b/,
  series: /\b(?:every|all|always|from now on|for good|anymore|any more|altogether|the whole series|each week|every week|permanently|for the rest)\b/,
  classWord: /\b(?:class|classes|lecture|seminar|section|discussion|lab)\b/,
  dinnerish: /\b(?:dinner|supper|party|game|movie|concert|drinks|bar|date night|show|tonight|evening|night|afternoon)\b/,
  morningish: /\b(?:breakfast|morning|sunrise)\b/,
  studyStart: /\bstart(?:ing)? (?:studying|to study|study(?:ing)? for)\b|\b(?:starting|beginning)\b(?=.*\b(?:stud(?:y|ying)|exam|midterm|final|quiz)\b)|\b(?:stud(?:y|ying)|exam|midterm|final|quiz)\b.*\b(?:starting|beginning)\b/,
};

const LEAD = new RegExp(
  String.raw`^(?:please|can you|could you|would you|i'?d like to|i would like to|i want to|i need to|i have to|i gotta|need to|want to|have to|let me|lets|let's|i'?m going to|i am going to|going to|gonna|i'?m|im|i am|i'?ll be|i will be|i'?ll|i will|i have|i'?ve got|i got|i can|so that i can|so i can|so that|so|in order to|because i have|because|cause|since|clear up|clear out|clear|free up|free|block off|block out|block|reserve|save|hold|keep|make time for|make time|make|set aside|add|schedule|put in|put|plan|book|leave|time to|time for|some time for|some time to|some time|time|for|to|and|then|also|my|the|a|an|me|some|need|new|event|an event|busy)\b[\s,]*`,
);
const LEAD_VERB = /^(?:play|playing|go to|going to|go|attend|attending|have|having|do|doing|get|grab|grabbing|hit|see|catch|visit|head to|be at)\b\s*/;
const TRAIL = /[\s,]*\b(?:free|and|&|on|at|for|to|from|in|of|with|every|this|that|the|please|time|then|too|so|up|off|out|is|be|it)\s*$/;

function eventTitle(rest, fallback) {
  let t = rest.replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 8 && LEAD.test(t); i++) t = t.replace(LEAD, '');
  if (LEAD_VERB.test(t) && t.replace(LEAD_VERB, '').trim()) t = t.replace(LEAD_VERB, '');
  for (let i = 0; i < 3 && LEAD.test(t); i++) t = t.replace(LEAD, '');
  for (let i = 0; i < 6 && TRAIL.test(t); i++) t = t.replace(TRAIL, '');
  t = t.replace(/^[\s,&-]+|[\s,&-]+$/g, '');
  return cap(t) || fallback;
}

const win = (state) => ({ ...DEFAULT_WINDOW, ...(state.settings?.study_window || {}) });
function dayStart(state, d) {
  const w = win(state);
  const dow = parseYmd(d).getDay();
  return toMinutes((dow === 0 || dow === 6) && w.weekend_start ? w.weekend_start : w.start);
}
const dayEnd = (state) => {
  const e = toMinutes(win(state).end);
  return e > 0 ? e : 1440;
};

function partRange(part, state, d) {
  const s0 = dayStart(state, d);
  const e0 = Math.max(dayEnd(state), 18 * 60 + 60);
  return {
    morning: [Math.min(s0, 9 * 60), 12 * 60],
    lunch: [12 * 60, 13 * 60],
    afternoon: [12 * 60, 17 * 60],
    evening: [17 * 60, e0],
    night: [18 * 60, e0],
  }[part];
}

/** Times you have no class, event, or planned work, for "when am I free". */
export function freeTimeOn(d, state, now = new Date()) {
  const work = (state.tasks || [])
    .filter((t) => !t.hidden && t.status !== 'done')
    .flatMap((t) => (t.plan || []).filter((s) => s.date === d && s.start && !s.unscheduled))
    .map((s) => ({ s: toMinutes(s.start), e: toMinutes(s.start) + Number(s.minutes) }));
  return freeGaps(d, state, { now, extra: work }).filter(([s, e]) => e - s >= 20);
}

/** First free stretch of `minutes` inside [lo, hi] on a day (planned work you fixed counts as busy). */
function findSlot(state, d, minutes, [lo, hi], now, ignore = null) {
  const fixed = (state.tasks || [])
    .filter((t) => !t.hidden && t.status !== 'done' && t.id !== ignore)
    .flatMap((t) => (t.plan || []).filter((s) => s.date === d && s.start && s.fixed))
    .map((s) => ({ s: toMinutes(s.start), e: toMinutes(s.start) + Number(s.minutes) + 15 }));
  for (const [s, e] of freeGaps(d, state, { now, extra: fixed })) {
    const a = Math.max(s, lo);
    if (Math.min(e, hi) - a >= minutes) return a;
  }
  return null;
}

const when = (d, now) => {
  const r = relDay(parseYmd(d), now);
  return ['Today', 'Tomorrow', 'Yesterday'].includes(r) || r.length > 9 ? r : `${r.slice(0, 3)} ${fmtDate(parseYmd(d), { weekday: false })}`;
};
/** "today", "tomorrow", "Sunday" for use inside a sentence. */
const dayWord = (d, now) => {
  const r = relDay(parseYmd(d), now);
  return r === 'Today' || r === 'Tomorrow' || r === 'Yesterday' ? r.toLowerCase() : r.length > 9 ? r : `${r} ${fmtDate(parseYmd(d), { weekday: false })}`;
};
const span = (d, s, e) => fmtRange(atTime(d, hm(s)), atTime(d, hm(Math.min(e, 1439))));
const err = (message) => ({ kind: 'error', message, chips: [] });

const TASK_MARKS = /(?:^|\s)~\s?\d|(?:^|\s)!{1,3}(?:\s|$)|(?:^|\s)!(?:high|hi|h|med|medium|m|low|lo|l)\b|\bdue\b/;
const NOWORK = /\b(?:no work|no homework|no studying|nothing(?: planned)?|don'?t (?:plan|schedule|put) (?:anything|any work|work|stuff)|do not (?:plan|schedule))\b/g;

/** "CS office hours" keeps the capitals you typed. */
function restoreCase(title, raw) {
  const flat = raw.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(title.toLowerCase());
  return cap(i >= 0 ? flat.slice(i, i + title.length) : title);
}

function repeatDates(days, from, until, max = 20) {
  const out = [];
  for (let d = parseYmd(from); out.length < max && (!until || ymd(d) <= until); d = addDays(d, 1)) if (days.includes(d.getDay())) out.push(ymd(d));
  return out;
}

/**
 * Reads a sentence. Returns a command, { kind: 'task' } when it reads like a new task, or
 * { kind: 'error', message } when it's a plan change it can't quite work out. Never changes anything.
 * `date` is the day you're looking at (used when the sentence doesn't name one).
 */
export function interpret(text, { state, now = new Date(), date = null } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  const today = ymd(now);
  const view = date && date >= today ? date : today;
  const ctx = { state, now, prefer: RX.morningish.test(s) ? 'am' : RX.dinnerish.test(s) ? 'pm' : null };
  const termEnd = state.settings?.term?.end || state.settings?.term?.classes_end || null;

  if (RX.undo.test(s)) return { kind: 'undo', chips: ['Undo the last change'] };
  if (RX.replan.test(s)) return { kind: 'replan', chips: ['Re-plan everything you haven’t placed yourself'] };
  if (TASK_MARKS.test(s)) return { kind: 'task' };

  const scan = new Scan(s);
  const shift = readShift(scan);
  const dur = readDurations(scan);
  const D = readDates(scan, ctx);
  const studyish = /\b(?:stud(?:y|ying)|exam|midterm|final|quiz|test|prep|review)\b/.test(s);
  if (dur.daily && !studyish) {
    D.repeat ||= [0, 1, 2, 3, 4, 5, 6]; // "1 hour every day" on an event means every day
    dur.daily = false;
  }
  if (D.part === 'morning') ctx.prefer = 'am';
  else if (D.part && D.part !== 'lunch') ctx.prefer = 'pm';
  const dates = [...new Set(D.dates.map((x) => x.d))];
  const T0 = readTimes(scan, ctx, dates[0] || view);
  if (/\bsleep(?:ing)? in\b/.test(s) && !T0.range && T0.to === null && T0.point === null) T0.to = 11 * 60;
  if (!(T0.range || T0.from !== null || T0.to !== null || T0.point !== null || T0.anchor)) D.part ||= readPart(scan);
  const rest = scan.rest();
  const target = dates[0] || view;
  const explicitTime = !!(T0.range || T0.from !== null || T0.to !== null || T0.point !== null || T0.anchor);
  const hasTime = explicitTime || !!D.part;
  const say = (d) => when(d, now);
  const has = (re) => re.test(s) || re.test(rest);

  if (RX.free.test(s)) return { kind: 'free', date: target, chips: [`Free time ${dayWord(target, now)}`] };

  // ----- A day off, a light day, or back to normal -----
  let limitDates = dates.length ? dates : [view];
  if (D.repeat) limitDates = repeatDates(D.repeat, view, D.until || termEnd);
  const limit = (minutes, label) => ({ kind: 'limit', dates: limitDates, minutes, chips: [label, limitDates.length > 3 ? `${limitDates.length} days, ${say(limitDates[0])} to ${say(limitDates.at(-1))}` : limitDates.map(say).join(', ')] });
  if (has(RX.clearLimit)) return limit(null, 'Plan work as usual');

  // ----- Exam study plans: "study 3 hours a day for the midterm" -----
  if (dur.daily || has(RX.studyStart)) {
    const exam = findTask(`${rest} exam`, state, { dates, now });
    const t = exam?.t?.type === 'exam' ? exam.t : null;
    if (!t) return err('Which exam? Try “study 2 hours a day for the math midterm”.');
    if (!t.due_at) return err(`${taskName(t, state).replace('Study: ', '')} doesn't have a date yet, so there's nothing to plan toward.`);
    const plan = studyPlanOf(t, state.settings);
    const daily = dur.daily ? dur.minutes : undefined;
    const start = has(RX.studyStart) && dates[0] ? dates[0] : undefined;
    if (start && start > plan.last) return err(`That's after the last study day for ${t.title}.`);
    if (daily === undefined && !start) return err('How much a day, or from when? Try “study 2 hours a day for the midterm”.');
    return {
      kind: 'study', t, daily, start,
      chips: ['Study plan', taskName(t, state).replace('Study: ', ''), daily !== undefined ? `${fmtMinutes(daily)} a day` : '', start ? `from ${say(start)}` : ''].filter(Boolean),
    };
  }

  const work = findTask(rest, state, { dates, now });
  const ev = findEvent(rest, state, dates.length ? dates : [view]);
  if (has(RX.limit) && dur.minutes !== null && !explicitTime && !work?.strong) return limit(dur.minutes, `At most ${fmtMinutes(dur.minutes)} of work`);
  if (has(RX.light) && !explicitTime) return limit(120, 'Light day: at most 2 h of work');
  if (has(RX.dayOff) && !hasTime && !(has(RX.cancel) && (ev || work))) return limit(0, 'Day off: no work planned');

  // ----- Cancelling: your events, a class, or a day's work -----
  if (has(RX.cancel)) {
    if (ev) {
      const weekly = (ev.days || []).length > 0;
      const all = !weekly || (!dates.length && (has(RX.series) || /\b(?:delete|remove)\b/.test(s)));
      const on = dates[0] || (eventsOn(view, { events: [ev] }).length ? view : nextOccurrence(ev, today));
      if (!all && !on) return err(`${ev.title} doesn't have any days coming up.`);
      return {
        kind: 'cancel-event', ev, date: all ? null : on, all,
        chips: all ? [weekly ? 'Delete every week' : 'Delete event', ev.title] : ['Skip', ev.title, say(on)],
      };
    }
    const named = courseHits(rest, state.courses || []).filter((c) => c.kind === 'class');
    const anyClass = !named.length && /\b(?:my |all (?:my )?|the )?class(?:es)?\b/.test(s) && !work;
    const courses = named.length ? named : anyClass ? (state.courses || []).filter((c) => c.kind === 'class') : [];
    if (courses.length && RX.classWord.test(s) && !TYPE_WORDS.some(([, re]) => re.test(rest))) {
      const ms = meetingsOn(target, state).filter((m) => courses.some((c) => c.id === m.course.id));
      const kinds = ms.filter((m) => new RegExp(`\\b${m.meeting.kind.toLowerCase()}s?\\b`).test(s));
      const pick = kinds.length ? kinds : ms;
      if (!pick.length) return err(`You don't have ${named.length ? `${named[0].short} ` : ''}class ${dayWord(target, now)}.`);
      return {
        kind: 'cancel-class', date: target, meetings: pick.map((m) => m.meeting.id),
        chips: ['No class', pick.map((m) => `${m.course.short} ${m.meeting.kind.toLowerCase()}`).join(', '), say(target)],
      };
    }
    if (work) {
      const t = work.t;
      const plan = t.plan || [];
      const day = dates[0] || (plan.some((x) => x.date === view) ? view : plan.map((x) => x.date).filter((x) => x >= today).sort()[0]);
      if (!day || !plan.some((x) => x.date === day)) return err(`${taskName(t, state)} doesn't have work planned ${day ? dayWord(day, now) : 'yet'}.`);
      return { kind: 'skip-work', t, date: day, chips: [t.type === 'exam' ? 'Skip studying' : 'Skip', taskName(t, state), say(day)] };
    }
    const outlook = busyOn(target, state).find((b) => tokens(b.title).some((w) => tokens(rest).includes(w)));
    if (outlook) return err(`“${outlook.title}” comes from Outlook. Change it there and your plan catches up within 15 minutes.`);
    if (!hasTime) return err("I couldn't find that. Use the name of one of your events or tasks, like “skip math study today”.");
  }

  // ----- Moving your events and planned work -----
  const moving = has(RX.move) || shift !== 0;
  const toDay = D.dates.find((x) => x.to)?.d;
  const fromDay = D.dates.find((x) => x.fromWord)?.d;
  if (moving && ev && !work?.strong) {
    const from = fromDay || (dates.length > 1 ? dates[0] : null) || (eventsOn(view, { events: [ev] }).length ? view : nextOccurrence(ev, today));
    if (!from) return err(`${ev.title} doesn't have any days coming up.`);
    const occ = eventsOn(from, { events: [ev] })[0];
    if (!occ) return err(`${ev.title} isn't on ${say(from)}.`);
    const toDate = toDay || (dates.length > 1 ? dates.at(-1) : dates[0] && dates[0] !== from ? dates[0] : from);
    let start = occ.s;
    let end = occ.e;
    if (T0.range) [start, end] = T0.range;
    else if (T0.point !== null || T0.toPoint !== null) {
      start = T0.point ?? T0.toPoint;
      end = start + (dur.minutes || occ.e - occ.s);
    } else if (shift) {
      start += shift;
      end += shift;
    } else if (dur.minutes) end = start + dur.minutes;
    if (start === occ.s && end === occ.e && toDate === from) return err(`Where should ${ev.title} go? Try “move ${ev.title.toLowerCase()} to 6pm”.`);
    if (start < 0 || end > 1440) return err('That would go past midnight.');
    const all = (ev.days || []).length > 0 && has(RX.series) && toDate === from;
    return {
      kind: 'move-event', ev, date: from, toDate, start: hm(start), end: hm(end), all,
      chips: ['Move', ev.title, `${all ? fmtRepeat(ev.days) : say(toDate)} ${span(toDate, start, end)}`],
    };
  }
  if (moving && work) {
    const t = work.t;
    const plan = t.plan || [];
    const from = fromDay || (dates.length > 1 ? dates[0] : null) || (plan.some((x) => x.date === view) ? view : plan.map((x) => x.date).filter((x) => x >= today).sort()[0]);
    if (!from || !plan.some((x) => x.date === from)) return err(`${taskName(t, state)} doesn't have work planned ${from ? dayWord(from, now) : 'yet'}.`);
    const blocks = plan.filter((x) => x.date === from).sort((a, b) => (a.start || '99').localeCompare(b.start || '99'));
    const toDate = toDay || (dates.length > 1 ? dates.at(-1) : dates[0] && dates[0] !== from ? dates[0] : from);
    let minutes = dur.minutes || blocks.reduce((a, x) => a + Number(x.minutes), 0);
    let start = null;
    if (T0.range) {
      start = T0.range[0];
      minutes = T0.range[1] - T0.range[0];
    } else if (T0.point !== null || T0.toPoint !== null) start = T0.point ?? T0.toPoint;
    else if (shift && blocks[0]?.start) start = toMinutes(blocks[0].start) + shift;
    else if (D.part) {
      start = findSlot(state, toDate, minutes, partRange(D.part, state, toDate), now, t.id);
      if (start === null) return err(`There's no free ${fmtMinutes(minutes)} stretch that ${D.part} for ${taskName(t, state)}.`);
    }
    if (toDate === from && start === null) return err(`Where should ${taskName(t, state)} go? Try “move it to tomorrow” or “move it to 3pm”.`);
    if (dayLimit(state, toDate) === 0) return err(`${cap(dayWord(toDate, now))} is a day off. Say “plan work again ${dayWord(toDate, now)}” first.`);
    if (t.due_at && toDate > ymd(new Date(t.due_at))) return err(`${taskName(t, state)} is due ${dayWord(ymd(new Date(t.due_at)), now)}, so its work can't go after that.`);
    if (start !== null && (start < 0 || start + minutes > 1440)) return err('That would go past midnight.');
    return {
      kind: 'move-work', t, from, toDate, start: start === null ? null : hm(start), minutes,
      chips: ['Move', taskName(t, state), `${say(toDate)}${start === null ? '' : ` ${span(toDate, start, start + minutes)}`}`],
    };
  }
  if (moving && !hasTime && !dates.length) return err("I couldn't find that event or task. Use its name, like “move the essay to sunday”.");

  // ----- Planning work at a time: "study math 2-4", "do the reading tonight" -----
  const byDay = D.dates.find((x) => /\bby\s*$/.test(s.slice(Math.max(0, x.at - 3), x.at)));
  if (work && byDay && !explicitTime) {
    return err(`The planner already gets ${taskName(work.t, state)} done before it's due. To pick the day, try “move it to ${dayWord(byDay.d, now)}”.`);
  }
  if (work && (has(RX.work) || work.strong) && !/\bfree\b/.test(s) && (hasTime || dates.length || dur.minutes)) {
    const t = work.t;
    const day = target;
    if (t.due_at && day > ymd(new Date(t.due_at))) return err(`${taskName(t, state)} is due ${dayWord(ymd(new Date(t.due_at)), now)}, so its work can't go after that.`);
    if (dayLimit(state, day) === 0) return err(`${cap(dayWord(day, now))} is a day off. Say “plan work again ${dayWord(day, now)}” first.`);
    const existing = (t.plan || []).filter((x) => x.date === day).reduce((a, x) => a + Number(x.minutes), 0);
    const ahead = (t.plan || []).filter((x) => x.date >= today).reduce((a, x) => a + Number(x.minutes), 0);
    let minutes = T0.range ? T0.range[1] - T0.range[0] : dur.minutes || existing || studyPlanOf(t, state.settings)?.daily || Math.min(120, ahead) || 60;
    minutes = Math.max(15, Math.round(minutes / 5) * 5);
    let start = null;
    if (T0.range) start = T0.range[0];
    else if (T0.point !== null) start = T0.point;
    else if (T0.from !== null) start = T0.from;
    else if (T0.to !== null) start = T0.to - minutes;
    else if (T0.anchor) {
      start = anchorStart(T0.anchor, state, day, minutes);
      if (start?.error) return err(start.error);
    } else if (D.part) {
      start = findSlot(state, day, minutes, partRange(D.part, state, day), now, t.id);
      if (start === null) return err(`There's no free ${fmtMinutes(minutes)} stretch that ${D.part}.`);
    }
    if (start !== null && (start < 0 || start + minutes > 1440)) return err('That would go past midnight.');
    return {
      kind: 'schedule-work', t, date: day, start: start === null ? null : hm(start), minutes,
      chips: ['Plan', taskName(t, state), `${say(day)}${start === null ? '' : ` ${span(day, start, start + minutes)}`}`, fmtMinutes(minutes)],
    };
  }
  if (/\bstud(?:y|ying)\b/.test(s) && !work && explicitTime) return err('Which class? Try “study math 2-4”.');

  // ----- New events and blocked-off time -----
  if (hasTime) {
    const noWork = has(RX.freeWord) || has(RX.dayOff);
    if (D.part && !explicitTime && !noWork) {
      const what = eventTitle(rest, 'dinner').toLowerCase();
      return err(`What time? Try “${what} 6-8pm${dates.length ? '' : ' tonight'}”.`);
    }
    const len = dur.minutes || 60;
    const timesOn = (d) => {
      let a;
      let b;
      if (T0.range) [a, b] = T0.range;
      else if (T0.anchor) {
        const st = anchorStart(T0.anchor, state, d, len);
        if (st?.error) return st;
        [a, b] = [st, st + len];
      } else if (T0.point !== null) [a, b] = [T0.point, T0.point + len];
      else if (T0.from !== null) [a, b] = [T0.from, dur.minutes ? T0.from + dur.minutes : Math.max(dayEnd(state), T0.from + 60)];
      else if (T0.to !== null) [a, b] = [dur.minutes ? T0.to - dur.minutes : Math.min(dayStart(state, d), T0.to - 60), T0.to];
      else if (D.part) [a, b] = partRange(D.part, state, d);
      else return { error: 'What time? Try something like “5-7pm”.' };
      a = Math.max(0, a);
      b = Math.min(1440, b);
      if (b - a < 5) return { error: 'That time range is empty.' };
      return [a, b];
    };
    let repeat = D.repeat;
    if (!repeat && (D.weeklyWord || (D.bareDays || 0) >= 2)) repeat = [...new Set(dates.map((d) => parseYmd(d).getDay()))].sort();
    const pieces = [];
    if (repeat) {
      const first = ymd(firstOnOrAfter(dates[0] || view, repeat));
      for (const dow of repeat) {
        const d = ymd(firstOnOrAfter(first, [dow]));
        const r = timesOn(d);
        if (r.error) {
          if (T0.anchor) continue; // no class that weekday
          return err(r.error);
        }
        const same = pieces.find((x) => x.start === r[0] && x.end === r[1]);
        if (same) {
          same.days.push(dow);
          if (d < same.date) same.date = d;
        } else pieces.push({ date: d, days: [dow], start: r[0], end: r[1] });
      }
      if (!pieces.length) return err("You don't have class on those days, so “after class” doesn't work there. Give a time instead.");
    } else {
      let days = dates.length ? dates : [view];
      if (!dates.length && view === today) {
        // No day named: today if there's still time, otherwise the next day it works.
        for (let i = 0; i < 8; i++) {
          const d = ymd(addDays(now, i));
          const r = timesOn(d);
          if (!r.error && (i > 0 || r[1] > minsOf(now))) {
            days = [d];
            break;
          }
        }
      }
      for (const d of days) {
        const r = timesOn(d);
        if (r.error) return err(r.error);
        pieces.push({ date: d, days: [], start: r[0], end: r[1] });
      }
    }
    const until = repeat ? D.until || (D.untilWeeks ? ymd(addDays(parseYmd(pieces[0].date), D.untilWeeks * 7 - 1)) : termEnd || ymd(addDays(parseYmd(pieces[0].date), 70))) : null;
    let title = /\bsleep(?:ing)? in\b/.test(s) ? 'Sleep in' : restoreCase(eventTitle(rest.replace(NOWORK, ' '), noWork ? 'Free time' : 'Busy'), raw);
    // "Nothing before 10" on a day that already starts at 10 doesn't need an event.
    if (!repeat && noWork && pieces.every((x) => x.end <= dayStart(state, x.date) || x.start >= dayEnd(state))) {
      const x = pieces[0];
      return err(x.end <= dayStart(state, x.date)
        ? `Work already starts at ${fmtHM(hm(dayStart(state, x.date)))} ${dayWord(x.date, now)}, so there's nothing to clear. You can change your work hours in Settings.`
        : `Work already ends by ${fmtHM(hm(dayEnd(state)))}, so there's nothing to clear. You can change your work hours in Settings.`);
    }
    if (title.length > 60) title = `${title.slice(0, 57)}…`;
    const events = pieces.map((x) => ({
      title, date: x.date, start_time: hm(x.start), end_time: x.end >= 1440 ? '23:59' : hm(x.end), days: x.days.sort(), until: x.days.length ? until : null,
    }));
    const desc = events.map((e) => `${e.days.length ? fmtRepeat(e.days) : say(e.date)} ${span(e.date, toMinutes(e.start_time), toMinutes(e.end_time))}`);
    return {
      kind: 'event', events, title,
      chips: ['New event', title, ...desc, until ? `until ${fmtDate(parseYmd(until), { weekday: false })}` : ''].filter(Boolean),
    };
  }

  if (has(RX.cancel) || moving) return err("I couldn't find that event or task. Use its name, like “move the essay to sunday”.");
  return { kind: 'task' };
}

function firstOnOrAfter(d, days) {
  let x = parseYmd(d);
  for (let i = 0; i < 7 && !days.includes(x.getDay()); i++) x = addDays(x, 1);
  return x;
}

/** Start time for "after class" / "before class" (with `len` minutes when it's before). */
function anchorStart(anchor, state, d, len) {
  const ms = meetingsOn(d, state).filter((m) => !anchor.course || m.course.id === anchor.course.id);
  if (!ms.length) return { error: `You don't have ${anchor.course ? `${anchor.course.short} ` : ''}class ${relDay(parseYmd(d)).toLowerCase()}. Give a time instead, like “4-5pm”.` };
  if (anchor.side === 'after') return roundUp(Math.max(...ms.map((m) => minsOf(m.end))) + 10);
  return Math.floor((Math.min(...ms.map((m) => minsOf(m.start))) - 10 - len) / 5) * 5;
}

/** What the live preview shows under the box. */
export function describe(cmd, text, state) {
  if (!cmd) return [];
  if (cmd.kind === 'task') {
    const p = parseQuickAdd(text, state.courses);
    return ['New task', p.title || 'New task', ...describeQuickAdd(p)];
  }
  if (cmd.kind === 'error') return [];
  return cmd.chips;
}

export const EXAMPLES = [
  'clear 5-7pm so I can play basketball',
  'basketball every tue and thu 5-7pm',
  'lift for 1 hour after class',
  'take saturday off',
  'no work after 9 tonight',
  'move the essay to sunday',
  'study math 2-4 tomorrow',
  'skip math study today',
  'when am I free tomorrow?',
];


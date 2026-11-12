// The AI helper on the Today page. When you ask something, it sends your question and a short
// summary of your dashboard to a free AI model (through the `assistant` Edge Function), shows the
// answer, and lists any changes it suggests. Nothing changes until you tap Apply, and Apply has Undo.
import { addDays, atTime, DOW, DOW_LONG, fmtDate, fmtHM, fmtMinutes, fmtRange, fmtTime, hhmm, MON, parseYmd, relDay, toIso, toMinutes, ymd } from './dates.js';
import { dayLimit, estimateOf, studyPlanOf } from './planner.js';
import { courseAliases } from './quickadd.js';
import { applyCommands, courseById, eventById, openTasks, rerender, state, store, taskById } from './state.js';
import { busyOn, eventsOn, meetingsOn } from './term.js';
import { esc } from './util.js';

const EXAMPLES = ['Estimate my tasks', 'Plan my evening', 'When am I free this weekend?', 'Make tomorrow lighter'];

const fresh = () => ({ log: [], messages: [], busy: false, error: '', pending: null, ids: new Map(), back: new Map() });
state.ai = fresh();

export function newChat() {
  state.ai = fresh();
  rerender();
}

// ---------- What the AI gets to see ----------

/** Short ids like T3 and E1 stand in for database ids, and stay the same for a whole conversation. */
function shortId(kind, id) {
  const ai = state.ai;
  if (!ai.ids.has(id)) {
    const n = [...ai.ids.values()].filter((v) => v[0] === kind).length + 1;
    ai.ids.set(id, `${kind}${n}`);
    ai.back.set(`${kind}${n}`, id);
  }
  return ai.ids.get(id);
}

const day = (d) => `${DOW[parseYmd(d).getDay()]} ${MON[parseYmd(d).getMonth()]} ${parseYmd(d).getDate()}`;
const span = (s, e) => `${hm(s)}–${hm(Math.min(e, 1440))}`;
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minsOf = (d) => d.getHours() * 60 + d.getMinutes();
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function courseLabel(id) {
  const c = courseById(id);
  return c ? c.short || c.name : '';
}

/** A plain-text summary of the next week, your events, and your open tasks. */
export function buildContext(now = new Date()) {
  const s = state.settings;
  const win = s.study_window || {};
  const cap = s.capacity || {};
  const today = ymd(now);
  const out = [];
  out.push(`Now: ${DOW[now.getDay()]} ${fmtDate(now, { weekday: false, year: true })}, ${hhmm(now)}.`);
  out.push(`Work hours: ${win.start || '08:00'}–${win.end || '23:00'} on weekdays, ${win.weekend_start || win.start || '10:00'}–${win.end || '23:00'} on weekends. Most work in a day: ${fmtMinutes(cap.weekday ?? 240)} on weekdays, ${fmtMinutes(cap.weekend ?? 300)} on weekends, unless a day limit says otherwise.`);

  const classes = state.courses.filter((c) => !c.archived && c.kind === 'class').map((c) => `${c.short} = ${c.name}`);
  if (classes.length) out.push(`Classes: ${classes.join('; ')}.`);

  out.push('', 'Schedule for the next 7 days:');
  const tasks = openTasks();
  for (let i = 0; i < 7; i++) {
    const d = ymd(addDays(now, i));
    const rows = [];
    for (const m of meetingsOn(d, state)) rows.push([minsOf(m.start), `${span(minsOf(m.start), minsOf(m.end))} class: ${m.course.short} ${m.meeting.kind}`]);
    for (const o of eventsOn(d, state)) rows.push([o.s, `${span(o.s, o.e)} event ${shortId('E', o.ev.id)}: ${o.title}${o.weekly ? ' (weekly)' : ''}`]);
    for (const b of busyOn(d, state)) {
      if (b.all_day) {
        rows.push([-1, `all day, Outlook: ${oneLine(b.title, 60)}`]);
        continue;
      }
      const bs = new Date(b.starts_at);
      const be = new Date(b.ends_at);
      const s0 = ymd(bs) < d ? 0 : minsOf(bs);
      const e0 = ymd(be) > d ? 1440 : minsOf(be);
      rows.push([s0, `${span(s0, e0)} Outlook: ${oneLine(b.title, 60)}`]);
    }
    for (const t of tasks) {
      if (t.due_at && ymd(new Date(t.due_at)) === d) {
        const due = new Date(t.due_at);
        if (t.type === 'exam' || t.type === 'event') rows.push([minsOf(due), `${span(minsOf(due), minsOf(due) + (t.duration_minutes || 60))} ${t.type} ${shortId('T', t.id)}: ${t.title}`]);
        else rows.push([minsOf(due), `${hhmm(due)} due: ${shortId('T', t.id)} ${t.title}`]);
      }
      for (const b of t.plan || []) {
        if (b.date !== d) continue;
        const what = `${t.type === 'exam' ? 'study for' : 'work on'} ${shortId('T', t.id)} (${courseLabel(t.course_id) ? `${courseLabel(t.course_id)} ` : ''}${t.title})${b.fixed ? ', placed by the student' : ''}`;
        if (b.start && !b.unscheduled) rows.push([toMinutes(b.start), `${span(toMinutes(b.start), toMinutes(b.start) + b.minutes)} ${what}`]);
        else rows.push([1441, `${fmtMinutes(b.minutes)} ${what}, no free time found for it`]);
      }
    }
    const limit = dayLimit(state, d);
    const head = `${day(d)}${i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''}${limit === 0 ? ' [day off]' : limit ? ` [at most ${fmtMinutes(limit)} of work]` : ''}:`;
    out.push(head, ...(rows.length ? rows.sort((a, b) => a[0] - b[0]).map((r) => `  ${r[1]}`) : ['  nothing scheduled']));
  }

  const later = Object.entries(s.day_limits || {}).filter(([d]) => d > ymd(addDays(now, 6))).sort();
  if (later.length) out.push(`Later day limits: ${later.map(([d, m]) => `${day(d)} ${Number(m) === 0 ? 'day off' : `at most ${fmtMinutes(m)}`}`).join('; ')}.`);

  if (state.events.length) {
    out.push('', 'The student\'s events (they can be moved or deleted):');
    for (const ev of state.events) {
      const weekly = (ev.days || []).length > 0;
      if (!weekly && ev.date < today) continue;
      if (weekly && ev.until && ev.until < today) continue;
      out.push(`  ${shortId('E', ev.id)} ${ev.title}: ${weekly ? `every ${ev.days.map((x) => DOW[x]).join(', ')} ${ev.start_time}–${ev.end_time}, from ${ev.date}${ev.until ? ` until ${ev.until}` : ''}` : `${ev.date} ${ev.start_time}–${ev.end_time}`}`);
    }
  }

  out.push('', 'Open tasks, soonest first:');
  const sorted = [...tasks].sort((a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999')).slice(0, 45);
  for (const t of sorted) {
    const bits = [`${shortId('T', t.id)}`, courseLabel(t.course_id), t.title, t.type];
    if (t.due_at) bits.push(`due ${day(ymd(new Date(t.due_at)))} ${hhmm(new Date(t.due_at))}`);
    else bits.push('no due date');
    const study = studyPlanOf(t, s);
    if (study) bits.push(`study plan: ${fmtMinutes(study.daily)} a day, ${study.start} to ${study.last}`);
    else if (t.type !== 'exam') {
      const set = t.estimate_minutes !== null && t.estimate_minutes !== undefined && t.estimate_minutes !== '';
      bits.push(`estimate ${fmtMinutes(estimateOf(t, s))}${set ? '' : ' (rough default)'}`);
    }
    const planned = (t.plan || []).filter((b) => b.date >= today).reduce((a, b) => a + b.minutes, 0);
    if (planned) bits.push(`${fmtMinutes(planned)} planned from today on`);
    const subs = t.subtasks || [];
    if (subs.length) bits.push(`${subs.filter((x) => x.done).length} of ${subs.length} steps done`);
    if (t.notes) bits.push(`notes: ${oneLine(t.notes, 160)}`);
    out.push(`  ${bits.filter(Boolean).join(' · ')}`);
  }
  if (tasks.length > sorted.length) out.push(`  (and ${tasks.length - sorted.length} more due later)`);
  return out.join('\n');
}

// ---------- Reading the AI's suggestions ----------

const DAYNUM = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(parseYmd(v)) === v;
const isTime = (v) => typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v);
const time = (v) => (isTime(v) ? v.padStart(5, '0') : null);
const whole = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return v !== null && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);
const dayText = (d) => {
  const r = relDay(parseYmd(d));
  return r === 'Today' || r === 'Tomorrow' ? r.toLowerCase() : r.length > 9 ? r : `${r.slice(0, 3)} ${fmtDate(parseYmd(d), { weekday: false })}`;
};
const range = (s, e) => fmtRange(atTime('2000-01-03', s), atTime('2000-01-03', e));
/** "every Saturday", "every Tue & Thu", "every Mon, Wed & Fri" */
function every(days) {
  if (days.length === 1) return `every ${DOW_LONG[days[0]]}`;
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW[d]);
  return `every ${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
}
const name = (t) => `${courseLabel(t.course_id) ? `${courseLabel(t.course_id)} ` : ''}${t.title}`;

function lookup(kind, ref) {
  const id = state.ai.back.get(String(ref || '').trim().toUpperCase());
  if (!id) return null;
  return kind === 'T' ? taskById(id) : eventById(id);
}

function findCourse(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return null;
  return state.courses.find((c) => !c.archived && [c.short, c.code, c.name, ...courseAliases(c)].some((x) => String(x || '').toLowerCase() === q)) || null;
}

/** Turns one suggestion into a planner change plus a sentence about it, or explains why it can't be used. */
function readAction(a) {
  const today = ymd(new Date());
  const type = String(a?.type || '');
  switch (type) {
    case 'estimate': {
      const t = lookup('T', a.task);
      const m = whole(a.minutes, 5, 2400);
      if (!t || t.status === 'done' || m === null) return null;
      if (t.type === 'exam') return null;
      const now = estimateOf(t, state.settings);
      const minutes = round5(m);
      if (minutes === now) return { same: true }; // it agrees with the estimate you have
      return { cmd: { kind: 'estimate', t, minutes }, text: `${name(t)}: ${fmtMinutes(now)} → ${fmtMinutes(minutes)}`, why: oneLine(a.why, 140) };
    }
    case 'add_task': {
      const title = oneLine(a.title, 120);
      if (!title) return null;
      const c = findCourse(a.course);
      const m = whole(a.minutes, 5, 2400);
      const [d, tm] = String(a.due || '').split('T');
      const due = isDate(d) ? toIso(d, time(tm) || '23:59') : null;
      const task = { title, course_id: c?.id || null, due_at: due, estimate_minutes: m === null ? null : round5(m), type: 'task' };
      const when = due ? `, due ${dayText(d)} ${fmtTime(new Date(due))}` : '';
      return { cmd: { kind: 'add-task', task }, text: `Add a task: ${c ? `${c.short} ` : ''}${title}${when}${m ? `, about ${fmtMinutes(round5(m))}` : ''}` };
    }
    case 'add_event': {
      const title = oneLine(a.title, 80) || 'Busy';
      const start = time(a.start);
      const end = time(a.end);
      if (!isDate(a.date) || !start || !end || toMinutes(end) <= toMinutes(start)) return null;
      const dayNum = (x) => (Number.isInteger(x) && x >= 0 && x <= 6 ? x : DAYNUM[String(x).toLowerCase().slice(0, 4)] ?? DAYNUM[String(x).toLowerCase().slice(0, 3)]);
      const days = [...new Set((Array.isArray(a.weekly) ? a.weekly : []).map(dayNum).filter((x) => x !== undefined))].sort((x, y) => x - y);
      const until = days.length && isDate(a.until) && a.until >= a.date ? a.until : null;
      const when = days.length ? `${every(days)}, ${range(start, end)}${until ? `, until ${dayText(until)}` : ''}` : `${dayText(a.date)}, ${range(start, end)}`;
      return {
        cmd: { kind: 'event', events: [{ title, date: a.date, start_time: start, end_time: end, days, until }], chips: ['Add', title, when] },
        text: `Add ${title}, ${when}`,
      };
    }
    case 'move_event': {
      const ev = lookup('E', a.event);
      if (!ev) return null;
      const weekly = (ev.days || []).length > 0;
      const all = weekly && a.every_week === true;
      // A one-day event: whichever date the AI gave that isn't its current one is where it goes.
      const date = weekly ? (isDate(a.date) ? a.date : null) : ev.date;
      const toDate = isDate(a.to_date) ? a.to_date : !weekly && isDate(a.date) ? a.date : date || ev.date;
      if (!date && !all) return null;
      const on = date ? eventsOn(date, { events: [ev] })[0] : null;
      if (!on && !all) return null;
      if (all && date && toDate !== date) return null; // moving a weekly event to another weekday happens in its editor
      const start = time(a.start) || on?.start || ev.start_time;
      const end = time(a.end) || on?.end || ev.end_time;
      if (toMinutes(end) <= toMinutes(start) || (!all && toDate < today)) return null;
      const when = all ? `${range(start, end)} every week` : `${dayText(toDate)}, ${range(start, end)}`;
      const text = all
        ? `Move ${ev.title} to ${when}`
        : toDate === date
          ? `Move ${ev.title} on ${dayText(date)} to ${range(start, end)}${weekly ? ' (just that day)' : ''}`
          : `Move ${ev.title} from ${dayText(date)} to ${when}${weekly ? ' (just that day)' : ''}`;
      return { cmd: { kind: 'move-event', ev, date: date || ev.date, toDate, start, end, all, chips: ['Move', ev.title, when] }, text };
    }
    case 'delete_event': {
      const ev = lookup('E', a.event);
      if (!ev) return null;
      const weekly = (ev.days || []).length > 0;
      if (!weekly || a.every_week === true) return { cmd: { kind: 'cancel-event', ev, all: true }, text: `Delete ${ev.title}${weekly ? ' (every week)' : ''}` };
      if (!isDate(a.date) || !eventsOn(a.date, { events: [ev] }).length) return null;
      return { cmd: { kind: 'cancel-event', ev, all: false, date: a.date }, text: `Skip ${ev.title} ${dayText(a.date)}` };
    }
    case 'plan_work': {
      const t = lookup('T', a.task);
      if (!t || t.status === 'done' || !isDate(a.date) || a.date < today) return null;
      const start = time(a.start);
      const minutes = whole(a.minutes, 15, 480) ?? 60;
      const when = `${dayText(a.date)}${start ? ` ${fmtHM(start)}` : ''}`;
      return {
        cmd: { kind: 'schedule-work', t, date: a.date, minutes, start, chips: ['Plan', name(t), when, fmtMinutes(minutes)] },
        text: `${t.type === 'exam' ? 'Study for' : 'Work on'} ${name(t)} ${when} for ${fmtMinutes(minutes)}`,
      };
    }
    case 'move_work': {
      const t = lookup('T', a.task);
      if (!t || !isDate(a.from) || !isDate(a.to) || a.to < today || a.from === a.to) return null;
      const minutes = (t.plan || []).filter((b) => b.date === a.from).reduce((x, b) => x + b.minutes, 0);
      if (!minutes) return null;
      const start = time(a.start);
      const when = `${dayText(a.to)}${start ? ` ${fmtHM(start)}` : ''}`;
      return {
        cmd: { kind: 'move-work', t, from: a.from, toDate: a.to, minutes, start, chips: ['Move', name(t), when] },
        text: `Move ${name(t)} (${fmtMinutes(minutes)}) from ${dayText(a.from)} to ${when}`,
      };
    }
    case 'skip_work': {
      const t = lookup('T', a.task);
      if (!t || !isDate(a.date) || !(t.plan || []).some((b) => b.date === a.date)) return null;
      return { cmd: { kind: 'skip-work', t, date: a.date }, text: `Skip ${name(t)} ${dayText(a.date)}` };
    }
    case 'day_limit': {
      if (!isDate(a.date) || a.date < today) return null;
      const minutes = a.minutes === null ? null : whole(a.minutes, 0, 960);
      if (minutes === null && a.minutes !== null) return null;
      const text = minutes === null ? `Plan work as usual ${dayText(a.date)}` : minutes === 0 ? `Take ${dayText(a.date)} off` : `At most ${fmtMinutes(minutes)} of work ${dayText(a.date)}`;
      return { cmd: { kind: 'limit', dates: [a.date], minutes, chips: ['Limit', dayText(a.date)] }, text };
    }
    case 'replan':
      return { cmd: { kind: 'replan' }, text: 'Re-plan the work you haven’t placed yourself' };
    default:
      return null;
  }
}

// ---------- Asking ----------

function friendly(err) {
  const code = err?.code || '';
  if (code === 'not_set_up') return "The AI helper isn't connected yet.";
  if (code === 'daily_limit') {
    const n = new Date();
    const reset = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
    return `Today's free AI allowance is used up. It resets at ${fmtTime(reset)}.`;
  }
  if (code === 'busy') return 'The AI is busy right now. Try again in a minute.';
  if (code === 'bad_token') return "Cloudflare didn't accept the AI helper's access token, so it needs a new one.";
  if (code === 'signed_out') return 'Sign in again to use the AI helper.';
  if (/Failed to fetch|NetworkError|Load failed|FunctionsFetchError/i.test(`${err?.name} ${err?.message}`)) return "Couldn't reach the AI. Check your connection and try again.";
  return err?.message || String(err);
}

export async function askAI(text) {
  const ai = state.ai;
  text = String(text || '').trim();
  if (!text || ai.busy) return;
  if (state.offline) {
    ai.error = "You're offline, so the AI helper can't answer right now.";
    rerender();
    return;
  }
  ai.log.push({ who: 'you', text });
  ai.messages.push({ role: 'user', content: text });
  Object.assign(ai, { busy: true, error: '', pending: null, retry: '' });
  rerender();
  try {
    const res = await store.invoke('assistant', { messages: ai.messages.slice(-10), context: buildContext() });
    if (state.ai !== ai) return; // you started a new chat meanwhile
    const raw = Array.isArray(res?.actions) ? res.actions : [];
    const read = raw.map(readAction);
    const items = read.filter((x) => x && !x.same).map((x) => ({ ...x, on: true }));
    const dropped = read.filter((x) => !x).length;
    const reply = String(res?.reply || '').trim() || (items.length ? 'Here’s what I’d change:' : 'I don’t have an answer for that.');
    ai.log.push({ who: 'ai', text: reply });
    ai.messages.push({ role: 'assistant', content: res?.raw || JSON.stringify({ reply, actions: raw }) });
    ai.pending = items.length || dropped ? { items, dropped, text } : null;
  } catch (err) {
    console.warn('AI helper', err);
    if (state.ai !== ai) return;
    ai.log.pop();
    ai.messages.pop();
    ai.error = friendly(err);
    ai.retry = text;
  } finally {
    ai.busy = false;
    rerender();
  }
}

export function pickAI(i, on) {
  const item = state.ai.pending?.items?.[i];
  if (item) item.on = on;
}

export async function applyAI() {
  const p = state.ai.pending;
  if (!p) return;
  const cmds = p.items.filter((x) => x.on).map((x) => x.cmd);
  state.ai.pending = null;
  if (!cmds.length) {
    rerender();
    return;
  }
  const ok = await applyCommands(cmds, { text: p.text });
  if (ok) state.ai.log.push({ who: 'note', text: `Applied ${cmds.length === 1 ? 'the change' : `${cmds.length} changes`}.` });
  rerender();
}

export function skipAI() {
  state.ai.pending = null;
  state.ai.log.push({ who: 'note', text: 'Left your plan as it was.' });
  rerender();
}

// ---------- The card ----------

export function aiCard() {
  const ai = state.ai;
  const log = ai.log.slice(-6);
  const bubble = (m) =>
    m.who === 'note'
      ? `<p class="ai-note">${esc(m.text)}</p>`
      : `<p class="ai-msg ${m.who === 'you' ? 'you' : 'bot'}"><span class="sr-only">${m.who === 'you' ? 'You' : 'AI'}: </span>${esc(m.text)}</p>`;
  const p = ai.pending;
  const changes = p
    ? `<div class="ai-pending">
        ${p.items.length ? `<p class="ai-pending-title">Suggested changes <span class="ai-pending-hint">Tap Apply to make them</span></p>
        <ul class="ai-changes">${p.items
          .map(
            (x, i) => `<li><label><input type="checkbox" data-ai-pick="${i}"${x.on ? ' checked' : ''}><span>${esc(x.text)}${x.why ? `<span class="ai-why">${esc(x.why)}</span>` : ''}</span></label></li>`,
          )
          .join('')}</ul>` : ''}
        ${p.dropped ? `<p class="ai-note">${p.dropped === 1 ? 'One suggestion' : `${p.dropped} suggestions`} didn't match anything in your dashboard, so ${p.dropped === 1 ? 'it was' : 'they were'} left out.</p>` : ''}
        ${p.items.length ? `<div class="row-gap"><button class="btn btn-primary small" type="button" data-action="ai-apply">Apply</button><button class="btn small" type="button" data-action="ai-skip">Not now</button></div>` : ''}
      </div>`
    : '';
  return `<section class="card ai o-0" aria-labelledby="ai-title">
    <header class="card-head"><h2 id="ai-title"><span class="ai-spark" aria-hidden="true">✦</span> Ask AI</h2>${ai.log.length ? '<button class="btn small ghost" type="button" data-action="ai-new">New chat</button>' : ''}</header>
    ${log.length || ai.busy ? `<div class="ai-log" aria-live="polite">${log.map(bubble).join('')}${ai.busy ? '<p class="ai-msg bot thinking"><span class="sr-only">Thinking</span><i></i><i></i><i></i></p>' : ''}</div>` : ''}
    ${ai.error ? `<p class="ai-error" role="alert">${esc(ai.error)}${ai.retry ? ` <button class="btn small" type="button" data-action="ai-example" data-text="${esc(ai.retry)}">Try again</button>` : ''}</p>` : ''}
    ${changes}
    <form class="ai-form" data-form="ai" autocomplete="off">
      <label class="sr-only" for="ai-input">Ask the AI helper</label>
      <input id="ai-input" name="text" type="text" maxlength="600" placeholder="${ai.log.length ? 'Reply or ask something else' : 'How long will my CS homework take?'}" enterkeyhint="send"${ai.busy ? ' disabled' : ''}>
      <button class="btn btn-primary" type="submit"${ai.busy ? ' disabled' : ''}>Ask</button>
    </form>
    ${ai.log.length ? '' : `<div class="ai-examples">${EXAMPLES.map((x) => `<button type="button" class="qp-bit" data-action="ai-example" data-text="${esc(x)}">${esc(x)}</button>`).join('')}</div>`}
    <p class="foot ai-foot">A free AI model on Cloudflare reads your tasks and schedule when you ask. It only suggests changes; you choose what to apply. It won't do coursework for you.</p>
  </section>`;
}

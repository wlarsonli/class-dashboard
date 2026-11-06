import { byDue, empty, section, TYPE_LABEL, taskRow } from '../components.js';
import { addDays, weekStart } from '../dates.js';
import { courseById, liveTasks, state } from '../state.js';
import { esc } from '../util.js';

export function renderTasks() {
  const now = new Date();
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  let list = liveTasks().filter((t) => (f.status === 'all' ? true : f.status === 'done' ? t.status === 'done' : t.status !== 'done'));
  if (f.course) list = list.filter((t) => (f.course === 'none' ? !t.course_id : t.course_id === f.course));
  if (f.type) list = list.filter((t) => t.type === f.type);
  if (q) list = list.filter((t) => `${t.title} ${t.notes} ${courseById(t.course_id)?.short || ''}`.toLowerCase().includes(q));

  const courseOpts = state.courses
    .filter((c) => !c.archived)
    .map((c) => `<option value="${c.id}"${f.course === c.id ? ' selected' : ''}>${esc(c.short || c.name)}</option>`)
    .join('');
  const typeOpts = Object.entries(TYPE_LABEL)
    .map(([k, v]) => `<option value="${k}"${f.type === k ? ' selected' : ''}>${esc(v)}</option>`)
    .join('');
  const seg = ['open', 'done', 'all']
    .map((s) => `<button type="button" class="${f.status === s ? 'active' : ''}" data-action="status" data-value="${s}" aria-pressed="${f.status === s}">${{ open: 'To do', done: 'Done', all: 'All' }[s]}</button>`)
    .join('');

  const filters = `<div class="filters card">
    <label class="sr-only" for="task-search">Search tasks</label>
    <input id="task-search" type="search" placeholder="Search tasks" value="${esc(f.q)}" data-filter="q">
    <select data-filter="course" aria-label="Class"><option value="">All classes</option>${courseOpts}<option value="none"${f.course === 'none' ? ' selected' : ''}>No class</option></select>
    <select data-filter="type" aria-label="Type"><option value="">All types</option>${typeOpts}</select>
    <div class="seg pills" role="group" aria-label="Status">${seg}</div>
  </div>`;

  const rows = (arr) => `<div class="task-list">${arr.map((t) => taskRow(t, { now })).join('')}</div>`;
  let body;
  if (!list.length) {
    body = empty(q || f.course || f.type ? 'No tasks match those filters.' : f.status === 'done' ? 'Nothing finished yet.' : 'Nothing to do. Nice.');
  } else if (f.status === 'done') {
    list.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
    body = section('Done', rows(list), { count: list.length });
  } else {
    list.sort(byDue);
    const nextWeek = addDays(weekStart(now), 7);
    const after = addDays(nextWeek, 7);
    const groups = [
      ['Overdue', (t) => t.due_at && new Date(t.due_at) < now && t.status !== 'done'],
      ['This week', (t) => t.due_at && new Date(t.due_at) < nextWeek],
      ['Next week', (t) => t.due_at && new Date(t.due_at) < after],
      ['Later', (t) => !!t.due_at],
      ['No due date', () => true],
    ];
    const seen = new Set();
    body = groups
      .map(([name, test]) => {
        const g = list.filter((t) => !seen.has(t.id) && test(t));
        g.forEach((t) => seen.add(t.id));
        return g.length ? section(name, rows(g), { count: g.length, cls: name === 'Overdue' ? 'tone-overdue' : '' }) : '';
      })
      .join('');
  }

  return `<div class="page-head"><div><p class="eyebrow">Everything</p><h1>Tasks</h1></div>
    <div class="head-actions"><button class="btn btn-primary" type="button" data-action="new-task">+ New task</button></div></div>
    ${filters}<div class="stack">${body}</div>`;
}

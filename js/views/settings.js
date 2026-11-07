import { section } from '../components.js';
import { fmtDate, fmtTime } from '../dates.js';
import { pushState } from '../push.js';
import { state, store } from '../state.js';
import { esc } from '../util.js';

const hrs = (min) => Math.round(((Number(min) || 0) / 60) * 100) / 100;
const checked = (b) => (b ? ' checked' : '');

function notificationsCard(cloud) {
  const ps = pushState();
  let status;
  let actions = '';
  if (!cloud) status = 'Notifications start working once the dashboard is online (connected to Supabase).';
  else if (ps === 'needs-install') {
    status = 'On iPhone, notifications work after you add the dashboard to your Home Screen: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Open it from the Home Screen and come back here.';
  } else if (ps === 'unsupported') status = "This browser can't show notifications.";
  else if (ps === 'denied') status = "Notifications are blocked for this app. Turn them on in your device's settings, then reload.";
  else if (ps === 'granted') {
    status = 'Notifications are allowed on this device.';
    actions = `<button class="btn" type="button" data-action="enable-push">Re-connect this device</button>
      <button class="btn" type="button" data-action="test-push">Send a test</button>`;
  } else {
    status = 'Notifications are off on this device.';
    actions = '<button class="btn btn-primary" type="button" data-action="enable-push">Turn on notifications</button>';
  }
  const s = state.settings;
  return section(
    'Notifications',
    `<p>${status}</p>${actions ? `<div class="row-gap">${actions}</div>` : ''}
    <form data-form="alerts" class="stack-sm">
      <label class="toggle"><input type="checkbox" name="rundown"${checked(s.alerts.rundown)}> Morning rundown at <input type="time" name="rundown_time" value="${esc(s.rundown_time)}" required></label>
      <label class="toggle"><input type="checkbox" name="nudges"${checked(s.alerts.nudges)}> Reminder about work you planned for the day at <input type="time" name="nudge_time" value="${esc(s.nudge_time)}" required></label>
      <label class="toggle"><input type="checkbox" name="quiet"${checked(s.quiet_during_classes)}> Hold alerts until class is over</label>
      <div><button class="btn btn-primary" type="submit">Save alert times</button></div>
    </form>`,
  );
}

function planningCard() {
  const s = state.settings;
  const d = s.default_estimates;
  const est = (k, label) => `<label class="field"><span>${label}</span><input type="number" name="est_${k}" min="0" max="40" step="0.25" value="${hrs(d[k])}"></label>`;
  return section(
    'Planning',
    `<form data-form="planning" class="stack-sm">
      <div class="grid2">
        <label class="field"><span>Study time on weekdays (hours)</span><input type="number" name="cap_weekday" min="0" max="16" step="0.5" value="${hrs(s.capacity.weekday)}"></label>
        <label class="field"><span>Study time on weekends (hours)</span><input type="number" name="cap_weekend" min="0" max="16" step="0.5" value="${hrs(s.capacity.weekend)}"></label>
        <label class="field"><span>Warn me when a day has this many deadlines</span><input type="number" name="wl_deadlines" min="1" max="10" step="1" value="${esc(s.workload.deadlines)}"></label>
      </div>
      <p class="hint">The planner fills each day up to its study time, minus your Outlook events. You also get a heads-up whenever a day ends up with more work than that.</p>
      <div class="grid3">
        <label class="field"><span>Schedule work from (weekdays)</span><input type="time" name="win_start" value="${esc(s.study_window.start)}" required></label>
        <label class="field"><span>From (weekends)</span><input type="time" name="win_weekend" value="${esc(s.study_window.weekend_start || s.study_window.start)}" required></label>
        <label class="field"><span>Until</span><input type="time" name="win_end" value="${esc(s.study_window.end)}" required></label>
      </div>
      <p class="hint">Default time needed for new tasks (hours). You can change it on any task.</p>
      <div class="grid5">${est('assignment', 'Assignment')}${est('essay', 'Essay or paper')}${est('reading', 'Reading')}${est('task', 'To-do')}</div>
      <p class="hint">Exam studying: how much to study each day, and for how many days before the exam. You can change it on any exam.</p>
      <div class="prep-rows">${[
        ['final', 'Finals'],
        ['midterm', 'Midterms'],
        ['quiz', 'Quizzes and assessments'],
      ]
        .map(
          ([k, label]) => `<div class="prep-row"><span>${label}</span>
            <label class="field inline"><input type="number" name="prep_${k}_daily" min="0" max="12" step="0.25" value="${hrs(s.exam_prep[k].daily)}" aria-label="${label}: hours a day"><span>h a day for</span></label>
            <label class="field inline"><input type="number" name="prep_${k}_days" min="1" max="21" step="1" value="${esc(s.exam_prep[k].days)}" aria-label="${label}: days"><span>days</span></label>
          </div>`,
        )
        .join('')}</div>
      <div><button class="btn btn-primary" type="submit">Save planning settings</button></div>
    </form>`,
  );
}

function termCard() {
  const t = state.settings.term;
  const breaks = [...(t.breaks || []), { label: '', start: '', end: '' }];
  const date = (name, label) => `<label class="field"><span>${label}</span><input type="date" name="${name}" value="${esc(t[name] || '')}"></label>`;
  return section(
    'Term dates',
    `<form data-form="term" class="stack-sm">
      <label class="field"><span>Term name</span><input name="name" value="${esc(t.name || '')}" placeholder="Autumn 2026"></label>
      <div class="grid3">${date('start', 'First day')}${date('classes_end', 'Last day of classes')}${date('end', 'Term ends')}${date('finals_start', 'Finals start')}${date('finals_end', 'Finals end')}</div>
      <p class="hint">Breaks and reading period. Classes are hidden on these days. Leave the last row empty unless you're adding one.</p>
      <div class="break-rows">${breaks
        .map(
          (b, i) => `<div class="grid3 break-row">
            <label class="field"><span>Name</span><input name="break_label_${i}" value="${esc(b.label || '')}" placeholder="Thanksgiving break"></label>
            <label class="field"><span>From</span><input type="date" name="break_start_${i}" value="${esc(b.start || '')}"></label>
            <label class="field"><span>To</span><input type="date" name="break_end_${i}" value="${esc(b.end || '')}"></label>
          </div>`,
        )
        .join('')}</div>
      <div class="grid2">
        <label class="field"><span>Next term</span><input name="next_label" value="${esc(t.next_term?.label || '')}" placeholder="Winter quarter"></label>
        <label class="field"><span>Starts</span><input type="date" name="next_start" value="${esc(t.next_term?.start || '')}"></label>
      </div>
      <div><button class="btn btn-primary" type="submit">Save term dates</button></div>
    </form>`,
  );
}

function connectionsCard(cloud) {
  const i = state.integrations || {};
  const feed = cloud ? store.calendarUrl(i) : '';
  const last = i.last_sync_at ? `Last checked ${fmtDate(new Date(i.last_sync_at))}, ${fmtTime(new Date(i.last_sync_at))}${i.last_sync_status ? `: ${i.last_sync_status}` : ''}` : '';
  return section(
    'Canvas and Outlook',
    `<form data-form="connections" class="stack-sm">
      <label class="field"><span>Canvas calendar feed</span><input type="url" name="canvas_feed_url" value="${esc(i.canvas_feed_url || '')}" placeholder="https://canvas.uchicago.edu/feeds/calendars/….ics" spellcheck="false"></label>
      <label class="field"><span>Outlook calendar (published ICS link)</span><input type="url" name="outlook_feed_url" value="${esc(i.outlook_feed_url || '')}" placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" spellcheck="false"></label>
      <p class="hint">Keep both links private: anyone who has them can see that calendar. ${cloud ? 'The dashboard checks them every hour.' : 'They start syncing once the dashboard is online.'}</p>
      <div class="row-gap"><button class="btn btn-primary" type="submit">Save links</button>${cloud ? '<button class="btn" type="button" data-action="sync-now">Sync now</button>' : ''}</div>
      ${last ? `<p class="hint">${esc(last)}</p>` : ''}
    </form>
    ${
      feed
        ? `<div class="feed">
            <p><strong>Your deadlines in Outlook.</strong> In Outlook on the web, open Calendar, choose <em>Add calendar</em> → <em>Subscribe from web</em>, and paste this link:</p>
            <div class="copy-row"><input readonly value="${esc(feed)}" aria-label="Deadline calendar link" spellcheck="false"><button class="btn" type="button" data-action="copy" data-copy="${esc(feed)}">Copy</button></div>
            <p class="hint">Outlook refreshes subscribed calendars every few hours, so new deadlines can take a while to show up there.</p>
          </div>`
        : ''
    }`,
  );
}

function dataCard(cloud) {
  return section(
    'Your data',
    `<p>${cloud ? `Signed in as <strong>${esc(store.email)}</strong>. Your data syncs between your devices.` : 'Local mode: everything is saved in this browser only.'}</p>
    <div class="row-gap">
      <button class="btn" type="button" data-action="export">Download a backup</button>
      <label class="btn">Import a file<input type="file" accept="application/json,.json" data-import hidden></label>
      ${cloud ? '<button class="btn ghost" type="button" data-action="sign-out">Sign out</button>' : '<button class="btn ghost danger" type="button" data-action="erase-local">Erase this browser\'s data</button>'}
    </div>
    <p class="hint">Importing replaces everything currently in the dashboard. Backups include your Canvas and Outlook links, so keep them private.</p>`,
  );
}

function appearanceCard() {
  const t = state.settings.theme;
  const opt = (v, l) => `<option value="${v}"${t === v ? ' selected' : ''}>${l}</option>`;
  return section(
    'Appearance',
    `<label class="field inline"><span>Theme</span><select data-setting="theme">${opt('auto', 'Match my device')}${opt('light', 'Light')}${opt('dark', 'Dark')}</select></label>`,
  );
}

export function renderSettings() {
  const cloud = store.mode === 'cloud';
  return `<div class="page-head"><div><p class="eyebrow">Dashboard</p><h1>Settings</h1></div></div>
  <div class="settings-grid">
    <div class="stack">${notificationsCard(cloud)}${planningCard()}${appearanceCard()}</div>
    <div class="stack">${connectionsCard(cloud)}${termCard()}${dataCard(cloud)}</div>
  </div>`;
}

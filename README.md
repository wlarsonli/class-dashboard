# Class Dashboard

A soft-pastel dashboard for classes, deadlines, and a weekly work plan. It runs as a web app on your
laptop and iPhone (added to the Home Screen) and syncs between them through Supabase.

**Live:** https://wlarsonli.github.io/class-dashboard/
· Supabase project `jiubqvyadpqyaksttvdl` (us-east-2)
· Jobs: Canvas and Outlook sync every 15 minutes, notifications every 15 minutes

- **Today:** overdue and due-today items, work planned for today, the next 7 days, today's classes and
  Outlook events, countdowns to exams and big deadlines, and a term progress bar.
- **Ask AI (on Today):** a free AI model that knows your tasks and schedule. Ask how long something will
  take, when you're free, or to change your plan ("add gym Saturday 9–10", "make tomorrow lighter").
  - It can suggest new time estimates, tasks, and events, move or skip work and events, set day limits,
    and re-plan. Each suggestion has a checkbox, nothing changes until you tap **Apply**, and Apply has Undo.
  - It runs on OpenAI's open gpt-oss model through Cloudflare Workers AI's free daily allowance (roughly
    40–80 questions a day, reset at 6 pm Chicago time). Cloudflare doesn't train on what you send.
  - It doesn't do coursework (your syllabi limit AI use); it plans time for the work instead.
  - When the Plan tab's box doesn't understand a sentence, it offers **Ask AI instead**.
- **Plan → Day:** a timeline of your day. Classes, your events, Outlook events, exams, and deadlines are
  shown, and the planner fits work blocks into the free time between them, with breaks after each block.
  - **Drag and drop:** drag a work block or one of your events to a new time, or drag its bottom edge to
    change how long it is. On the iPhone, press and hold for a moment first, so normal swipes still scroll.
    Tap a block instead for more options. Blocks you place yourself stay put.
  - **Re-planning:** when something changes in the app or in Outlook, the plan reshuffles around it.
  - **Your own Outlook study blocks** (like "Math P-Set") count toward that class's work.
- **Tell the planner:** type a change into the box at the top of the Plan tab (or the box on Today).
  Under the box you see what it will do, and afterward what moved, with Undo. For example:
  - `clear 5-7pm so I can play basketball`, `basketball every tue and thu 5-7pm`, `lift for 1 hour after class`
  - `take saturday off`, `only 2 hours of work tomorrow`, `no work after 9 tonight`, `plan work again saturday`
  - `move the essay to sunday`, `study math 2-4 tomorrow`, `skip math study today`, `push basketball back an hour`
  - `no math class tuesday`, `study 3 hours a day for the midterm`, `when am I free tomorrow?`, `re-plan`

  It runs in the app (no AI service), so it understands these kinds of sentences rather than anything at all.
- **Your events:** events you add this way (or by tapping one to edit it) live in the app, one day or every
  week. Tap one to rename it, change its time or days, skip a day, or delete it. Outlook events and
  classes can't be dragged, since they come from Outlook and your class schedule.
- **Plan → Week:** Monday–Sunday at a glance, with how much work each day holds. Drag a day's work to
  another day.
- **Exam study plans:** exams get a set amount of study every day before them. The defaults are:
  - Finals: 2 hours a day for 7 days
  - Midterms: 2 hours a day for 5 days
  - Quizzes: 1 hour a day for 3 days

  You can change these in Settings, or on any exam.
- **Classes:** a card for each class with meeting times, office hours (marked when they clash with your
  classes), links, policies, and progress.
- **Tasks:** everything, with search and filters.
- **Smart quick-add:** type `cs hw7 fri 6pm ~3h !` and it fills in the class, due date, time needed, and priority.
- **Background jobs:**
  - A Canvas and Outlook sync every 15 minutes. The app also syncs when you open it.
  - A 7:30 am rundown that includes today's work blocks and their times.
  - A 3 pm reminder about work still ahead today.
  - A calendar feed that Outlook can subscribe to: your deadlines and exams, your own events, and your
    planned work blocks (the last two can be turned off in Settings).

## Folders

```
Claude Dashboards/
├── class-dashboard/          ← this repo (the app code, safe to publish)
│   ├── index.html, styles.css, sw.js, manifest.webmanifest
│   ├── js/                   ← app logic and screens
│   ├── vendor/supabase.js    ← Supabase client library (v2)
│   └── supabase/             ← database schema, Edge Functions, cron setup
└── private/                  ← never committed
    ├── seed-autumn-2026.json ← your classes and deadlines (import this in Settings)
    └── .env                  ← notification keys and the scheduler secret
```

## Run it on your Mac

```bash
cd class-dashboard
python3 -m http.server 8000
```

Then open http://localhost:8000. While `js/config.js` is empty, it runs in **local mode** and saves
everything in that browser. Use **Settings → Import a file** to load `private/seed-autumn-2026.json`.

## Going online (one-time setup)

1. **Tools:** install the Supabase and GitHub command-line tools.
2. **Supabase:**
   - Sign in with `supabase login`.
   - Create a project in the region closest to Chicago (`us-east-2`) and link this folder to it.
   - `supabase db push` creates the tables from `supabase/migrations/`.
   - `supabase secrets set` stores the values from `private/.env`.
   - `supabase functions deploy sync notify calendar assistant` uploads the background jobs and the AI helper.
   - Run `supabase/cron.sql` (with your project ref) to schedule them.
3. **Config:** put the project URL, the anon key, and `VAPID_PUBLIC_KEY` into `js/config.js`.
   All three are public by design.
4. **GitHub Pages:** push this folder to a public repo and turn on Pages. The app then lives at
   `https://<username>.github.io/class-dashboard/`.
5. **AI helper:** make a free Cloudflare account, then open **AI → Workers AI → Use REST API**.
   Copy the Account ID and create a Workers AI API token there. Add both as secrets in Supabase
   (Edge Functions → Secrets) named `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, and deploy the
   `assistant` function. Keep the Cloudflare account on the free plan so it can never charge you.
6. **Your account:**
   - Open the site and choose **Create your account**.
   - Turn off new sign-ups in Supabase (Authentication → Sign In / Providers), so the dashboard stays yours.
   - Import the seed file in Settings.
7. **iPhone:**
   - Open the site in Safari and tap **Share → Add to Home Screen**.
   - Open it from the Home Screen and sign in.
   - Go to Settings → **Turn on notifications**. This needs iOS 16.4 or newer.
8. **Outlook:** copy the deadline calendar link from Settings, then in Outlook on the web choose
   **Add calendar → Subscribe from web**.

## Privacy

- **Public:** the app code, the Supabase URL and anon key, and the public notification key. None of these
  can read your data without your login.
- **Private:** your tasks, classes, settings, and calendar links live in Supabase behind row-level
  security, so only your account can read them.
- **Server-only:** the Canvas and Outlook links, the service key, the notification private key, and the
  Cloudflare token stay on the server or in `../private`.
- **AI helper:** when you ask it something, your question and a summary of your tasks and schedule go to
  Cloudflare Workers AI. Your email address and calendar links are never included.
- **Secret link:** the Outlook deadline feed link contains a long random token. Treat it like a password.

## Updating the app

After changing any app file, bump `VERSION` in `sw.js` so installed copies pick up the new version, then push.

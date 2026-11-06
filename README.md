# Class Dashboard

A soft-pastel dashboard for classes, deadlines, and a weekly work plan. It runs as a web app on your
laptop and iPhone (added to the Home Screen) and syncs between them through Supabase.

- **Today:** overdue and due-today items, work planned for today, the next 7 days, today's classes and
  Outlook events, countdowns to exams and big deadlines, and a term progress bar.
- **Week:** a Monday–Sunday planner. It suggests which day to work on each task, based on your time
  estimates, your study time per day, and your Outlook events. Drag a work session to another day, or tap
  it on a phone, to move it.
- **Classes:** a card for each class with meeting times, office hours (marked when they clash with your
  classes), links, policies, and progress.
- **Tasks:** everything, with search and filters.
- **Smart quick-add:** type `cs hw7 fri 6pm ~3h !` and it fills in the class, due date, time needed, and priority.
- **Background jobs:** hourly Canvas and Outlook sync, a 7:30 am rundown, a 3 pm reminder about
  planned work, and a calendar feed of your deadlines that Outlook can subscribe to.

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
   - `supabase functions deploy sync notify calendar` uploads the background jobs.
   - Run `supabase/cron.sql` (with your project ref) to schedule them.
3. **Config:** put the project URL, the anon key, and `VAPID_PUBLIC_KEY` into `js/config.js`.
   All three are public by design.
4. **GitHub Pages:** push this folder to a public repo and turn on Pages. The app then lives at
   `https://<username>.github.io/class-dashboard/`.
5. **Your account:**
   - Open the site and choose **Create your account**.
   - Turn off new sign-ups in Supabase (Authentication → Sign In / Providers), so the dashboard stays yours.
   - Import the seed file in Settings.
6. **iPhone:**
   - Open the site in Safari and tap **Share → Add to Home Screen**.
   - Open it from the Home Screen and sign in.
   - Go to Settings → **Turn on notifications**. This needs iOS 16.4 or newer.
7. **Outlook:** copy the deadline calendar link from Settings, then in Outlook on the web choose
   **Add calendar → Subscribe from web**.

## Privacy

- **Public:** the app code, the Supabase URL and anon key, and the public notification key. None of these
  can read your data without your login.
- **Private:** your tasks, classes, settings, and calendar links live in Supabase behind row-level
  security, so only your account can read them.
- **Server-only:** the Canvas and Outlook links, the service key, and the notification private key stay on
  the server or in `../private`.
- **Secret link:** the Outlook deadline feed link contains a long random token. Treat it like a password.

## Updating the app

After changing any app file, bump `VERSION` in `sw.js` so installed copies pick up the new version, then push.

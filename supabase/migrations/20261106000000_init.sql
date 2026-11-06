-- Class Dashboard database.
-- Every table is private to its owner through row-level security (RLS).

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null default 'class' check (kind in ('class', 'category')),
  code text not null default '',
  name text not null default '',
  short text not null default '',
  color text not null default '#C9B8F0',
  instructor text not null default '',
  email text not null default '',
  office_hours jsonb not null default '[]',
  links jsonb not null default '[]',
  policies text not null default '',
  canvas_course_id text,
  aliases text[] not null default '{}',
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  kind text not null default 'Lecture',
  days int[] not null default '{}',          -- 0 = Sunday … 6 = Saturday
  start_time text not null,                   -- 'HH:MM', Chicago time
  end_time text not null,
  location text not null default '',
  start_date date,
  end_date date,
  exceptions jsonb not null default '[]',     -- [{ date, cancelled?, location?, note? }]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  course_id uuid references public.courses (id) on delete set null,
  title text not null,
  type text not null default 'task',          -- assignment, essay, reading, exam, task, admin, event
  due_at timestamptz,                         -- for exams and events: the start time
  duration_minutes int,
  estimate_minutes int,
  priority int not null default 0,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  done_at timestamptz,
  notes text not null default '',
  links jsonb not null default '[]',
  subtasks jsonb not null default '[]',
  plan jsonb not null default '[]',           -- [{ date: 'YYYY-MM-DD', minutes, pinned }]
  series_id uuid,
  repeat jsonb,
  source text not null default 'manual',      -- manual, quickadd, syllabus, canvas
  external_uid text,                          -- Canvas calendar UID, so syncs don't duplicate
  estimated_date boolean not null default false,
  location text not null default '',
  hidden boolean not null default false,      -- deleted Canvas items stay hidden instead of coming back
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tasks_user_external_uid on public.tasks (user_id, external_uid);
create index tasks_user_due on public.tasks (user_id, due_at);

-- Events copied from your published Outlook calendar (refreshed by the sync job).
create table public.busy_blocks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null default 'outlook',
  uid text not null,
  title text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  location text not null default ''
);
create index busy_blocks_user_time on public.busy_blocks (user_id, starts_at);

create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.integrations (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  canvas_feed_url text not null default '',
  outlook_feed_url text not null default '',
  -- Secret part of the deadline-calendar link you subscribe to in Outlook.
  calendar_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  last_sync_at timestamptz,
  last_sync_status text not null default '',
  updated_at timestamptz not null default now()
);
create unique index integrations_calendar_token on public.integrations (calendar_token);

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now()
);

-- Which alerts already went out, so each one is sent once.
create table public.notification_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  ref text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, kind, ref)
);

-- Keep updated_at current.
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger courses_touch before update on public.courses for each row execute function public.touch_updated_at();
create trigger meetings_touch before update on public.meetings for each row execute function public.touch_updated_at();
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.settings for each row execute function public.touch_updated_at();
create trigger integrations_touch before update on public.integrations for each row execute function public.touch_updated_at();

-- Row-level security: you can only see and change your own rows.
alter table public.courses enable row level security;
alter table public.meetings enable row level security;
alter table public.tasks enable row level security;
alter table public.busy_blocks enable row level security;
alter table public.settings enable row level security;
alter table public.integrations enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_log enable row level security;

create policy "owner" on public.courses for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner" on public.meetings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner" on public.tasks for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner" on public.settings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner" on public.integrations for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner" on public.push_subscriptions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
-- Outlook events are written only by the sync job; you can read yours.
create policy "owner reads" on public.busy_blocks for select to authenticated
  using ((select auth.uid()) = user_id);
-- notification_log has no policies: only the server can use it.

-- Events you add in the app, like "Basketball, 5–7 pm", on one day or every week.
-- The planner keeps work out of them. One-day changes to a weekly event go in `skip` and `moved`.
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '',
  date date not null,                          -- the day, or the first day of a weekly event
  start_time text not null,                    -- 'HH:MM', Chicago time
  end_time text not null,
  days int[] not null default '{}',            -- weekly on these days (0 = Sunday … 6 = Saturday); empty = one day only
  until date,                                  -- last day of a weekly event
  skip date[] not null default '{}',           -- days a weekly event isn't happening
  moved jsonb not null default '{}',           -- one-day time changes: { "2026-11-10": { "start": "17:30", "end": "19:30" } }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_user_date on public.events (user_id, date);
create trigger events_touch before update on public.events for each row execute function public.touch_updated_at();

alter table public.events enable row level security;
create policy "owner" on public.events for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.events to authenticated;
grant all on table public.events to service_role;

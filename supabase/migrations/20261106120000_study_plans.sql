-- Exam study plans: how much to study each day and from which day, plus days you skipped.
-- Shape: { "daily": 120, "start": "2026-11-06", "skip": ["2026-11-09"] }
alter table public.tasks add column if not exists study jsonb;

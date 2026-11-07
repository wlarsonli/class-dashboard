-- Schedules the background jobs. Run once, after the Edge Functions are deployed.
-- Setup replaces PROJECT_REF and stores the CRON_SECRET from ../private/.env in Vault first:
--   select vault.create_secret('<CRON_SECRET>', 'class_dashboard_cron_secret');
-- Times are in UTC; the functions themselves work in your time zone.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Canvas and Outlook, every 15 minutes
select cron.schedule('class-dashboard-sync', '7,22,37,52 * * * *', $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'class_dashboard_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- Notifications, every 15 minutes
select cron.schedule('class-dashboard-notify', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'class_dashboard_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
$$);

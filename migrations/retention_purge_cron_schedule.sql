-- =============================================================================
-- Daily data-retention purge schedule (manual-apply via Supabase SQL editor)
-- =============================================================================
-- The retention-purge edge function already exists at
--   supabase/functions/crm-purge-retention/index.ts
-- It POSTs to the Node backend /api/v1/cron/purge-retention, which enforces the
-- retention schedule (DPDP §8(7) / GDPR Art.5(1)(e)): hard-purges soft-deleted
-- CRM PII past its grace window, trims old GPS/telemetry, and deletes personal
-- media (attendance selfies, form photos, call-recording audio) past the media
-- window — including the underlying storage objects.
--
-- Until now this had NO committed schedule (only lead-rescore was scheduled),
-- so in practice the purge never ran. Committing it here makes it reproducible.
--
-- SAFETY: the Node side runs as a DRY RUN (counts only, no deletes) unless
-- RETENTION_PURGE_ENABLED=true is set on Railway. Scheduling this BEFORE that
-- flag is set therefore only logs eligible counts — it never deletes. Flip the
-- flag once you've reviewed a dry-run in the logs.
--
-- Requires:
--   * pg_cron + pg_net + supabase_vault extensions enabled
--   * vault.secrets entries 'SUPABASE_URL' and 'SUPABASE_EDGE_SECRET'
--
-- Apply ONCE per environment. pg_cron overwrites a duplicate jobname silently;
-- run the SELECT first to keep the migration log clean.
-- =============================================================================

-- 1. Verify (returns 0 rows if not yet scheduled).
-- select jobname, schedule from cron.job where jobname = 'crm-purge-retention-daily';

-- 2. (Optional) Unschedule if you need to change the cron expression.
-- select cron.unschedule('crm-purge-retention-daily');

-- 3. Schedule — 03:30 UTC every day (offset from the 02:00 rescore job).
select cron.schedule(
  'crm-purge-retention-daily',
  '30 3 * * *',
  $$
  select
    net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL')
                 || '/functions/v1/crm-purge-retention',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_EDGE_SECRET')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- 4. Confirm.
-- select jobname, schedule, active from cron.job where jobname = 'crm-purge-retention-daily';

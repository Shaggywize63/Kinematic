-- =============================================================================
-- Daily lead-rescore schedule (manual-apply via Supabase SQL editor)
-- =============================================================================
-- The lead-rescore edge function already exists at
--   supabase/functions/crm-rescore-all-leads/index.ts
-- It scans every lead with score_updated_at older than 24h and fans out
-- per-lead rescore jobs. Until now its daily 02:00 UTC schedule lived
-- only in the Supabase dashboard — if the project is restored or
-- recreated, the schedule disappears. Committing it here makes the
-- schedule reproducible.
--
-- Requires:
--   * The pg_cron + pg_net + supabase_vault extensions enabled
--   * vault.secrets entries 'SUPABASE_URL' and 'SUPABASE_EDGE_SECRET'
--
-- Apply ONCE per environment (run the SELECT to verify it's not already
-- scheduled before unscheduling/rescheduling). pg_cron will silently
-- accept a duplicate name and overwrite, but checking first keeps the
-- migration log clean.
-- =============================================================================

-- 1. Verify (returns 0 rows if not yet scheduled).
-- select jobname, schedule from cron.job where jobname = 'crm-rescore-all-leads-daily';

-- 2. (Optional) Unschedule if you need to change the cron expression.
-- select cron.unschedule('crm-rescore-all-leads-daily');

-- 3. Schedule.
select cron.schedule(
  'crm-rescore-all-leads-daily',
  '0 2 * * *',  -- 02:00 UTC every day
  $$
  select
    net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL')
                 || '/functions/v1/crm-rescore-all-leads',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_EDGE_SECRET')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- 4. Confirm.
-- select jobname, schedule, active from cron.job where jobname = 'crm-rescore-all-leads-daily';

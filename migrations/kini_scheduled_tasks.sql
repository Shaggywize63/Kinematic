-- =============================================================================
-- KINI Wave 4a — kini_scheduled_tasks
-- =============================================================================
-- Backs the "remind me later" / recurring-reminder capability KINI schedules
-- from chat (tool: kini_schedule_reminder). Each row is one scheduled delivery
-- scoped to a single user under an org (and client where applicable). A cron
-- worker (POST /api/v1/cron/kini-scheduled) picks up active rows whose run_at
-- has passed, delivers the reminder via the existing notifications → FCM/APNs
-- push path, then completes a `once` task (status='done') or advances a
-- daily/weekly task's run_at by one interval.
--
-- RLS is enabled with a service_role bypass policy matching the established
-- style in migrations/kini_agentic_v2_init.sql — every read/write goes through
-- the backend service role, never a direct client.
--
-- Apply ONCE per environment (Kinematic + Tata). This migration only provisions
-- storage; scheduling the cron job (pg_cron → edge function → the route) is a
-- separate operation, mirroring the other cron jobs.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.kini_scheduled_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  client_id    uuid,
  user_id      uuid NOT NULL,
  run_at       timestamptz NOT NULL,
  recurrence   text NOT NULL DEFAULT 'once' CHECK (recurrence IN ('once','daily','weekly')),
  message      text NOT NULL,
  title        text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The cron worker's hot path: active tasks whose run_at has passed. A partial
-- index on status='active' keeps the due-scan cheap as done/cancelled rows pile
-- up.
CREATE INDEX IF NOT EXISTS idx_kini_scheduled_tasks_due
  ON public.kini_scheduled_tasks (run_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_kini_scheduled_tasks_status
  ON public.kini_scheduled_tasks (status, run_at);

-- Per-user listing ("what have I got scheduled?").
CREATE INDEX IF NOT EXISTS idx_kini_scheduled_tasks_user
  ON public.kini_scheduled_tasks (user_id, run_at DESC);

ALTER TABLE public.kini_scheduled_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kini_scheduled_tasks_service_role ON public.kini_scheduled_tasks;
CREATE POLICY kini_scheduled_tasks_service_role ON public.kini_scheduled_tasks FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMIT;

-- Verification (commented — run by hand after migrate):
--   SELECT count(*) FROM information_schema.tables
--     WHERE table_schema='public' AND table_name='kini_scheduled_tasks';  -- 1
--   SELECT indexname FROM pg_indexes
--     WHERE tablename='kini_scheduled_tasks';  -- pk + 3 indexes

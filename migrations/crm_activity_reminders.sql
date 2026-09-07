-- ═══════════════════════════════════════════════════════════════════════════
-- Activity reminders — scheduled-task/activity due notifications.
--
-- The delivery + display pipeline (notifications table → dispatch-pushes cron →
-- FCM/APNs + all three in-app bells) already exists; the only missing piece was
-- a generator that turns a *scheduled activity coming due* into a per-user
-- notification row. This migration adds:
--   1. crm_activities.reminded_at — a once-per-activity dedup stamp so the
--      generator fires exactly one reminder per activity.
--   2. notification_type enum value 'crm_activity_due' — the category the
--      generator writes (mirrors notification_type_add_daily_briefing.sql).
--   3. a partial index for the cheap "due & not yet reminded" scan.
--
-- Apply to each tenant Supabase project (Kinematic + Tata). Idempotent.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a txn block on some setups;
-- run this file with autocommit (psql default) — PG 17 accepts it fine.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.crm_activities
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'crm_activity_due';

-- Cheap scan surface for dispatchActivityReminders(): open, dated, un-reminded.
CREATE INDEX IF NOT EXISTS idx_crm_activities_reminder
  ON public.crm_activities (org_id, due_at)
  WHERE completed_at IS NULL AND reminded_at IS NULL AND due_at IS NOT NULL;

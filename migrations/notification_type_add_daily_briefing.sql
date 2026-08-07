-- =============================================================================
-- Fix: add missing 'daily_briefing' value to the notification_type enum
-- =============================================================================
-- The daily-briefing service (src/services/crm/ai/dailyBriefing.service.ts)
-- inserts notifications with type='daily_briefing', but that value was never
-- added to the notification_type enum on either tenant. Every briefing insert
-- therefore failed (invalid enum input) and was silently dropped — no briefing
-- was ever delivered.
--
-- This adds the intended value so the existing code works. Idempotent and
-- additive (never removes/rewrites existing values). Apply once per environment
-- (already applied to Kinematic + Tata).
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block that
-- then USES the value; run this statement on its own (no surrounding BEGIN).
-- =============================================================================

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'daily_briefing';

-- ============================================================
-- KINEMATIC CRM — LEAD LIFECYCLE FUNNEL + UTM + SLA TRACKING
-- Apply manually via Supabase SQL editor or psql.
--
-- Adds the columns the dashboard / mobile lead lifecycle UX needs but the
-- original schema was missing:
--
--   1. utm_source / utm_medium / utm_campaign / utm_term / utm_content /
--      referrer_url / landing_page  — campaign attribution. Lead Source
--      ROI reports can now bucket by channel + campaign, not just the
--      coarse lead_source bucket.
--
--   2. lifecycle_stage (subscriber / lead / mql / sql / customer /
--      evangelist) — funnel position, orthogonal to `status`. HubSpot-
--      style two-dimensional model:
--        status          = workflow state  (new, working, qualified, …)
--        lifecycle_stage = funnel position (lead, mql, sql, customer, …)
--      Service auto-bumps to 'customer' on convertLead().
--
--   3. stage_changed_at   — timestamp the lead's status last flipped.
--                            Backfilled to COALESCE(updated_at, created_at)
--                            for existing rows so the "stuck leads"
--                            query has a sane baseline.
--   4. first_response_at  — auto-stamped server-side on the first
--                            outbound activity (call/email/whatsapp) to
--                            the lead. Drives time-to-first-touch SLA.
--
-- Idempotent: all column adds gated with IF NOT EXISTS, constraint dropped
-- before re-add, indexes via IF NOT EXISTS. Safe to re-run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Campaign attribution ────────────────────────────────────
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS utm_source     text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS utm_medium     text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS utm_campaign   text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS utm_term       text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS utm_content    text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS referrer_url   text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS landing_page   text;

-- ── Funnel position (lifecycle_stage) ───────────────────────
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'lead';

ALTER TABLE public.crm_leads
  DROP CONSTRAINT IF EXISTS crm_leads_lifecycle_stage_check;

ALTER TABLE public.crm_leads
  ADD CONSTRAINT crm_leads_lifecycle_stage_check
  CHECK (lifecycle_stage IN ('subscriber','lead','mql','sql','customer','evangelist'));

-- ── SLA tracking ────────────────────────────────────────────
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS stage_changed_at   timestamptz;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS first_response_at  timestamptz;

-- Backfill stage_changed_at for legacy rows so the "stuck" query has a
-- baseline to compare against. Uses updated_at if available, else created_at.
UPDATE public.crm_leads
SET stage_changed_at = COALESCE(updated_at, created_at)
WHERE stage_changed_at IS NULL;

-- ── Indexes ─────────────────────────────────────────────────
-- Funnel reports filter by lifecycle_stage; UI groups by it.
CREATE INDEX IF NOT EXISTS idx_crm_leads_lifecycle_stage
  ON public.crm_leads (org_id, lifecycle_stage)
  WHERE deleted_at IS NULL;

-- "Stuck leads" query: WHERE stage_changed_at < now() - interval 'N days'.
CREATE INDEX IF NOT EXISTS idx_crm_leads_stage_changed
  ON public.crm_leads (org_id, stage_changed_at)
  WHERE deleted_at IS NULL;

-- Source-ROI reports join on (utm_source, utm_campaign).
CREATE INDEX IF NOT EXISTS idx_crm_leads_utm_campaign
  ON public.crm_leads (org_id, utm_source, utm_campaign)
  WHERE deleted_at IS NULL AND utm_source IS NOT NULL;

-- ============================================================
-- KINEMATIC CRM — LEAD HISTORY + LIFECYCLE COLUMNS
-- Apply manually via Supabase SQL editor or psql.
--
-- This migration:
--   1. Codifies the crm_lead_history runtime schema (was created out of
--      band; not present in migration_crm.sql, so a fresh deploy would
--      miss it). Mirrors the (lead_id, org_id, field, old_value,
--      new_value, changed_by, changed_at) shape already in production.
--   2. Extends crm_leads_status_check to include 'lost' so reps can
--      explicitly disqualify a lead (the TS LeadStatus / Zod validator
--      already include 'nurturing', so the live constraint just needs
--      the additional 'lost' value).
--   3. Adds crm_leads.lost_reason + disqualified_at so leads have parity
--      with deals on the disqualification capture path.
--
-- Idempotent: all statements gated with IF NOT EXISTS / DROP IF EXISTS
-- so a re-run is a no-op.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── crm_lead_history ────────────────────────────────────────
-- Audit log: one row per tracked field change on crm_leads. Written by
-- src/services/crm/leads.service.ts updateLead() + bulkAssign() on every
-- status / owner / disqualification transition.
CREATE TABLE IF NOT EXISTS public.crm_lead_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid        NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  org_id      uuid        NOT NULL,
  field       text        NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  changed_by  uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- Per-lead timeline view (most-recent first).
CREATE INDEX IF NOT EXISTS idx_crm_lead_history_lead
  ON public.crm_lead_history (lead_id, changed_at DESC);

-- Tenant-scoped audit reports (e.g. "all status changes this week").
CREATE INDEX IF NOT EXISTS idx_crm_lead_history_org
  ON public.crm_lead_history (org_id, changed_at DESC);

-- RLS: enable + grant select to authenticated users whose JWT org_id
-- matches the row. Mirror what crm_deal_history would have if it had
-- RLS configured — the rest of the CRM tables enforce tenant isolation
-- at the service layer (supabaseAdmin uses service_role) and rely on
-- RLS only as defence-in-depth for direct PostgREST access.
ALTER TABLE public.crm_lead_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'crm_lead_history'
      AND policyname = 'crm_lead_history_select_own_org'
  ) THEN
    CREATE POLICY crm_lead_history_select_own_org
      ON public.crm_lead_history
      FOR SELECT
      TO authenticated
      USING (org_id::text = COALESCE(auth.jwt() ->> 'org_id', ''));
  END IF;
END$$;

-- Service role bypasses RLS, but grant explicitly so a future move off
-- service_role doesn't silently break the audit-log endpoints.
GRANT SELECT ON public.crm_lead_history TO authenticated;

-- ── crm_leads.status — add 'lost' ───────────────────────────
-- Existing live constraint already has 'nurturing'; we extend it with
-- 'lost' so reps can disqualify outright (vs. 'unqualified' which is
-- "not a fit right now, may revisit").
ALTER TABLE public.crm_leads
  DROP CONSTRAINT IF EXISTS crm_leads_status_check;

ALTER TABLE public.crm_leads
  ADD CONSTRAINT crm_leads_status_check
  CHECK (status IN ('new','working','nurturing','qualified','unqualified','converted','lost'));

-- ── crm_leads.lost_reason + disqualified_at ─────────────────
-- Captures the "why" when a lead transitions to 'unqualified' or 'lost'.
-- Mirrors crm_deals.lost_reason. The disqualified_at timestamp is set by
-- the service on the first transition into one of those states.
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS lost_reason     text;

ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS disqualified_at timestamptz;

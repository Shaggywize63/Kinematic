-- =============================================================================
-- Lead NBA + Lead Updates schema
-- =============================================================================
-- Adds the storage layer for two paired features on the CRM leads surface:
--
--   1. Next-Best-Action on leads. crm_deals already carries `next_action_ai`
--      jsonb + `next_action_updated_at`; we mirror those columns onto
--      crm_leads so the lead-detail page can render the same recommended-
--      action card. The NBA computer is implemented in code
--      (src/services/crm/ai/leadNextBestAction.service.ts).
--
--   2. Free-form lead Updates timeline. Reps need somewhere to write
--      "customer asked for revised quote" / "will call back Tue" without
--      structuring it into an activity type. We store every entry in the
--      append-only public.crm_lead_updates table, AND denormalise the most
--      recent entry onto crm_leads.{latest_update, latest_update_at,
--      latest_update_by} so the list view can render a Latest Update
--      column without an N+1 lookup.
--
-- The denormalised columns are kept in sync at the application layer
-- (leadUpdates.service.ts on insert) so we don't carry a trigger in
-- production migration history.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- crm_leads — NBA + latest-update fields
-- -----------------------------------------------------------------------------
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS next_action_ai         jsonb,
  ADD COLUMN IF NOT EXISTS next_action_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS latest_update          text,
  ADD COLUMN IF NOT EXISTS latest_update_at       timestamptz,
  ADD COLUMN IF NOT EXISTS latest_update_by       uuid;

CREATE INDEX IF NOT EXISTS idx_crm_leads_latest_update_at
  ON public.crm_leads (latest_update_at DESC NULLS LAST);

-- -----------------------------------------------------------------------------
-- crm_lead_updates — append-only timeline
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_lead_updates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL,
  client_id   uuid,
  author_id   uuid NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_lead_updates_lead
  ON public.crm_lead_updates (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_lead_updates_org_created
  ON public.crm_lead_updates (org_id, created_at DESC);

ALTER TABLE public.crm_lead_updates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_lead_updates_service_role ON public.crm_lead_updates;
CREATE POLICY crm_lead_updates_service_role ON public.crm_lead_updates FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMIT;

-- Verification (commented — run by hand after migrate):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='crm_leads' AND column_name LIKE 'next_action%';
--   -- expected: next_action_ai, next_action_updated_at
--   SELECT count(*) FROM information_schema.tables WHERE table_name='crm_lead_updates';
--   -- expected: 1

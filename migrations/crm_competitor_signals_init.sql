-- Market-intelligence signals harvested from rep field notes (lead updates).
--
-- One row per structured signal an LLM extracts from a free-text lead update:
-- competitor mentions, price deltas, stock-outs, purchase timelines, product
-- quality remarks, buying intent. Powers the Market Intelligence dashboard.
-- Tenant-scoped exactly like the updates they are extracted from
-- (org_id + client_id); all access goes through the service-role client with
-- scoping enforced in code, consistent with crm_lead_updates.

CREATE TABLE IF NOT EXISTS public.crm_competitor_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  client_id       uuid,
  lead_id         uuid REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  source          text NOT NULL DEFAULT 'lead_update',  -- where the signal came from
  source_id       uuid,                                 -- crm_lead_updates.id it was extracted from
  signal_type     text NOT NULL,                        -- competitor_mention|price|stockout|timeline|quality|intent|other
  competitor_name text,                                 -- raw, as the rep said it ("Jindal Panther")
  competitor_key  text,                                 -- normalized lowercase for grouping ("jindal panther")
  stance          text,                                 -- we_winning|we_losing|neutral (from our perspective)
  price_delta     numeric,                              -- competitor price minus ours (signed); null if not stated
  city            text,
  state           text,
  postal_code     text,
  body            text NOT NULL,                        -- short evidence snippet
  confidence      smallint NOT NULL DEFAULT 50,         -- 0-100
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Dashboard reads: recent signals per tenant, competitor rollups, city rollups.
CREATE INDEX IF NOT EXISTS idx_competitor_signals_org_client_created
  ON public.crm_competitor_signals (org_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_competitor_signals_org_competitor
  ON public.crm_competitor_signals (org_id, competitor_key);
CREATE INDEX IF NOT EXISTS idx_competitor_signals_org_city
  ON public.crm_competitor_signals (org_id, city);
CREATE INDEX IF NOT EXISTS idx_competitor_signals_lead
  ON public.crm_competitor_signals (lead_id);

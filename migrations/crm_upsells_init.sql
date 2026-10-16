-- Upsells — additional revenue logged against an existing deal and/or lead.
--
-- One row per upsell a rep records on an existing customer (e.g. "added an
-- extended warranty, ₹5,000"). Kept separate from the deal's own amount so the
-- original value and the upsell revenue report independently, and so a customer
-- can carry several upsells over time. Surfaced as the "Upsells" section on both
-- the deal- and lead-detail pages. Tenant-scoped (org_id + client_id) exactly
-- like the deals/leads it hangs off; access is via the service-role client with
-- scoping enforced in code. Additive + idempotent — safe to re-run. Apply to
-- every Supabase project the backend serves (default/Tata + kinematic), then
-- NOTIFY pgrst to reload the schema cache.
CREATE TABLE IF NOT EXISTS public.crm_upsells (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  deal_id       uuid REFERENCES public.crm_deals(id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  product_id    uuid,                                   -- optional link to crm_products
  product_name  text,                                   -- free-text / denormalised product label
  amount        numeric NOT NULL DEFAULT 0,             -- upsell value in `currency`
  currency      text NOT NULL DEFAULT 'INR',
  quantity      numeric,                                -- optional
  status        text NOT NULL DEFAULT 'won',            -- proposed | won | lost
  note          text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),     -- when the upsell happened
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- An upsell must hang off at least one of a deal or a lead.
  CONSTRAINT crm_upsells_deal_or_lead CHECK (deal_id IS NOT NULL OR lead_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_crm_upsells_org_deal   ON public.crm_upsells (org_id, deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_upsells_org_lead   ON public.crm_upsells (org_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_upsells_org_client ON public.crm_upsells (org_id, client_id, occurred_at DESC);

-- NOTIFY pgrst, 'reload schema';

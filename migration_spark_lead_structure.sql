-- Spark & Ray refined lead structure. Additive + idempotent. Applied at boot via
-- exec_migration (PL/pgSQL EXECUTE) — so NO top-level BEGIN/COMMIT (those can't run there).
-- Every feature here is gated to connected-B2B clients (Spark & Ray) in the API, so a
-- tenant whose database has run this file but is not a B2B client is never touched.
-- After apply the runner issues: NOTIFY pgrst, 'reload schema';
--
-- Adds, end to end, the chain the field team actually sells on:
--   Group → Company → Location → Plant/Unit → Department → Person → Requirement → Make·Product·Qty
--
--   1. crm_accounts.is_group            — marks an account that only groups its children
--                                         (the "group" is a parent account; parent_account_id
--                                         already exists, so NINL → Tata Steel is parent_account_id).
--   2. crm_sites.parent_site_id         — a Location (site) holds one or more Plants/Units (child sites).
--      crm_sites.site_kind              — 'location' | 'unit' (NULL = legacy flat site).
--   3. crm_leads.site_id                — the plant/unit this requirement is for.
--      crm_leads.requirement            — the requirement text (one lead = one requirement).
--      crm_leads.department             — the contact's department, denormalised for naming/filtering.
--      crm_leads.display_name           — the computed, human-readable lead name.
--   4. crm_lead_product_lines           — several make/product/qty rows under one requirement.

-- ============================================================= 1. account group
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_crm_accounts_parent ON public.crm_accounts (parent_account_id);

-- ============================================================= 2. nested sites (location → unit)
ALTER TABLE public.crm_sites ADD COLUMN IF NOT EXISTS parent_site_id uuid REFERENCES public.crm_sites(id);
ALTER TABLE public.crm_sites ADD COLUMN IF NOT EXISTS site_kind      text;   -- 'location' | 'unit'
CREATE INDEX IF NOT EXISTS idx_crm_sites_parent ON public.crm_sites (parent_site_id);

-- ============================================================= 3. lead plant / requirement / name
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS site_id      uuid REFERENCES public.crm_sites(id);
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS requirement  text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS department   text;
ALTER TABLE public.crm_leads ADD COLUMN IF NOT EXISTS display_name text;
CREATE INDEX IF NOT EXISTS idx_crm_leads_site ON public.crm_leads (site_id);

-- ============================================================= 4. product lines per requirement
CREATE TABLE IF NOT EXISTS public.crm_lead_product_lines (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL,
  client_id     uuid,
  lead_id       uuid        NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  make_id       uuid        REFERENCES public.crm_makes(id),
  make_name     text,
  product_id    uuid        REFERENCES public.crm_products(id),
  product_name  text,
  qty           numeric,
  unit          text,
  line_value    numeric,
  position      integer     NOT NULL DEFAULT 0,
  custom_fields jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_crm_lpl_lead    ON public.crm_lead_product_lines (lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_lpl_org     ON public.crm_lead_product_lines (org_id);
CREATE INDEX IF NOT EXISTS idx_crm_lpl_make    ON public.crm_lead_product_lines (make_id)    WHERE make_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_lpl_product ON public.crm_lead_product_lines (product_id) WHERE product_id IS NOT NULL;

-- RLS: service-role backend (supabaseAdmin) bypasses RLS; enable it so no other role can read,
-- matching the sibling Spark tables (crm_account_updates, crm_activity_assignees). Idempotent.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.crm_lead_product_lines ENABLE ROW LEVEL SECURITY';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_lead_product_lines TO authenticated, service_role';
END $$;

NOTIFY pgrst, 'reload schema';

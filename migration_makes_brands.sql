-- Makes and Brands for the CRM product catalogue (Spark & Ray).
-- A "make" is the manufacturer; a "brand" is the product brand sold (MAC, PHD, BEKO, PIAB ...).
-- They are separate lists, and every product links to at most one make and one brand.
-- Additive + idempotent. NOT applied automatically: the operator runs it, then NOTIFY pgrst, 'reload schema'
-- (deliberately not part of this file).
-- Conventions mirrored from migration_crm_sites_visits_attendance_sessions.sql: gen_random_uuid() ids, RLS with the
-- tenant_isolation policy (org_id = auth.jwt()->>'org_id'), grants to authenticated/service_role, set_updated_at()
-- trigger. The service-role backend (supabaseAdmin) bypasses RLS.
--
-- Until this is applied the API answers 503 NOT_MIGRATED on /makes, /brands and on product make/brand writes;
-- product reads keep working (make_name / brand_name come back null).

BEGIN;

-- ============================================================= crm_makes / crm_brands
CREATE TABLE IF NOT EXISTS public.crm_makes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  deleted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.crm_brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  client_id   uuid,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  deleted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_makes_org  ON public.crm_makes  (org_id);
CREATE INDEX IF NOT EXISTS idx_crm_brands_org ON public.crm_brands (org_id);

-- A name is unique per org + client (client NULL = the org-level list), case-insensitive, among live rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_makes_org_client_name
  ON public.crm_makes (org_id, (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_brands_org_client_name
  ON public.crm_brands (org_id, (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name))
  WHERE deleted_at IS NULL;

-- ============================================================= RLS, grants, triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_makes','crm_brands'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation'
                   AND polrelid = format('public.%I', t)::regclass) THEN
      EXECUTE format($f$CREATE POLICY tenant_isolation ON public.%I
        USING (org_id = ((( SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid)
        WITH CHECK (org_id = ((( SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid)$f$, t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, service_role', t);
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_'||t||'_updated'
                   AND tgrelid = format('public.%I', t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON public.%I
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;

-- ============================================================= products link to one make and one brand
ALTER TABLE public.crm_products ADD COLUMN IF NOT EXISTS make_id  uuid REFERENCES public.crm_makes(id);
ALTER TABLE public.crm_products ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.crm_brands(id);

CREATE INDEX IF NOT EXISTS idx_crm_products_make  ON public.crm_products (make_id);
CREATE INDEX IF NOT EXISTS idx_crm_products_brand ON public.crm_products (brand_id);

-- Speeds up the product-reference uniqueness check and the bulk import (the API compares case-insensitively).
-- Not UNIQUE: existing data may already hold duplicate references; the API enforces uniqueness for new writes.
-- Guarded so a database whose crm_products has no `sku` column still migrates cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'crm_products' AND column_name = 'sku') THEN
    CREATE INDEX IF NOT EXISTS idx_crm_products_org_sku_lower
      ON public.crm_products (org_id, lower(sku)) WHERE deleted_at IS NULL;
  END IF;
END $$;

COMMIT;

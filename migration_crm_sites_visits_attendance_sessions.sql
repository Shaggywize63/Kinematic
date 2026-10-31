-- Phase 1 backbone for the field-sales visit model (Spark & Ray valve surveys).
-- Additive + idempotent. Adds:
--   * crm_sites           — a plant/site under a customer account (multi-site customers)
--   * crm_visits          — one plant trip; groups many product forms + many contacts
--   * attendance_sessions — per-punch attendance so a rep can check in/out many times a day
--   * CRM links on form_submissions (account/site/contact/deal/visit)
--   * site_id/product_id on crm_deals, site_id on crm_contacts, site_id/visit_id on crm_activities
-- Conventions mirrored from crm_* : gen_random_uuid() ids, RLS + tenant_isolation
-- (org_id = auth.jwt()->>'org_id'), grants to authenticated/service_role, set_updated_at() trigger.
-- The service-role backend (supabaseAdmin) bypasses RLS (force row security is off).

BEGIN;

-- ============================================================= crm_sites
CREATE TABLE IF NOT EXISTS public.crm_sites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  account_id    uuid NOT NULL REFERENCES public.crm_accounts(id),
  name          text NOT NULL,
  code          text,
  site_type     text,
  address_line1 text,
  address_line2 text,
  city          text,
  district      text,
  state         text,
  postal_code   text,
  country       text DEFAULT 'India',
  latitude      double precision,
  longitude     double precision,
  phone         text,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  tags          text[],
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_crm_sites_org        ON public.crm_sites (org_id);
CREATE INDEX IF NOT EXISTS idx_crm_sites_account    ON public.crm_sites (account_id);
CREATE INDEX IF NOT EXISTS idx_crm_sites_org_client ON public.crm_sites (org_id, client_id);

-- ============================================================= crm_visits
CREATE TABLE IF NOT EXISTS public.crm_visits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  client_id     uuid,
  user_id       uuid NOT NULL,
  account_id    uuid REFERENCES public.crm_accounts(id),
  site_id       uuid REFERENCES public.crm_sites(id),
  visit_date    date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date),
  started_at    timestamptz,
  ended_at      timestamptz,
  check_in_gps  text,
  check_out_gps text,
  latitude      double precision,
  longitude     double precision,
  purpose       text,
  notes         text,
  status        text NOT NULL DEFAULT 'open',   -- open | completed | cancelled
  activity_id   uuid REFERENCES public.crm_activities(id),
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_crm_visits_org      ON public.crm_visits (org_id);
CREATE INDEX IF NOT EXISTS idx_crm_visits_user     ON public.crm_visits (user_id);
CREATE INDEX IF NOT EXISTS idx_crm_visits_account  ON public.crm_visits (account_id);
CREATE INDEX IF NOT EXISTS idx_crm_visits_site     ON public.crm_visits (site_id);
CREATE INDEX IF NOT EXISTS idx_crm_visits_org_date ON public.crm_visits (org_id, visit_date);

-- ============================================================= attendance_sessions
-- One row per check-in/check-out pair. The daily public.attendance row is kept as
-- the rollup (first check-in, last check-out, SUM of working_minutes) so every
-- existing hours/analytics reader keeps working unchanged.
CREATE TABLE IF NOT EXISTS public.attendance_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id      uuid REFERENCES public.attendance(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL,
  org_id             uuid NOT NULL,
  client_id          uuid,
  date               date NOT NULL,
  seq                integer,
  checkin_at         timestamptz,
  checkin_lat        double precision,
  checkin_lng        double precision,
  checkin_selfie_url text,
  checkin_address    text,
  checkin_distance_m integer,
  checkin_accuracy_m numeric,
  checkin_is_mock    boolean,
  checkout_at        timestamptz,
  checkout_lat       double precision,
  checkout_lng       double precision,
  checkout_selfie_url text,
  checkout_accuracy_m numeric,
  checkout_is_mock   boolean,
  working_minutes    integer,
  status             text NOT NULL DEFAULT 'open',  -- open | closed
  transport_mode     text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_att_sessions_user_date ON public.attendance_sessions (user_id, date);
CREATE INDEX IF NOT EXISTS idx_att_sessions_att       ON public.attendance_sessions (attendance_id);
CREATE INDEX IF NOT EXISTS idx_att_sessions_org_date  ON public.attendance_sessions (org_id, date);
-- At most one OPEN session per rep per day (no double check-in without a check-out).
CREATE UNIQUE INDEX IF NOT EXISTS uq_att_sessions_open
  ON public.attendance_sessions (user_id, date) WHERE status = 'open';

-- ============================================================= RLS, grants, triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_sites','crm_visits','attendance_sessions'] LOOP
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

-- ============================================================= links on existing tables
ALTER TABLE public.crm_contacts    ADD COLUMN IF NOT EXISTS site_id    uuid REFERENCES public.crm_sites(id);
ALTER TABLE public.crm_deals       ADD COLUMN IF NOT EXISTS site_id    uuid REFERENCES public.crm_sites(id);
ALTER TABLE public.crm_deals       ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES public.crm_products(id);
ALTER TABLE public.crm_activities  ADD COLUMN IF NOT EXISTS site_id    uuid REFERENCES public.crm_sites(id);
ALTER TABLE public.crm_activities  ADD COLUMN IF NOT EXISTS visit_id   uuid REFERENCES public.crm_visits(id);
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.crm_accounts(id);
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS site_id    uuid REFERENCES public.crm_sites(id);
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.crm_contacts(id);
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS deal_id    uuid REFERENCES public.crm_deals(id);
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS visit_id   uuid REFERENCES public.crm_visits(id);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_site    ON public.crm_contacts (site_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_site       ON public.crm_deals (site_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_product    ON public.crm_deals (product_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_site  ON public.crm_activities (site_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_visit ON public.crm_activities (visit_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_account ON public.form_submissions (account_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_site    ON public.form_submissions (site_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_contact ON public.form_submissions (contact_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_deal    ON public.form_submissions (deal_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_visit   ON public.form_submissions (visit_id);

COMMIT;

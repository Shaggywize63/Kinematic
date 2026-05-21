-- Pre-deploy security migration — enable RLS on the core CRM /
-- distribution / identity tables that today rely entirely on code-
-- level `.eq('org_id', ...)` filters. This is defense-in-depth: the
-- backend uses the service_role key (which bypasses RLS) for all
-- queries, so enabling RLS does NOT change application behavior. It
-- only adds a database-layer guard against future regressions and
-- against any path that ever uses the anon key against these tables.
--
-- Safe to apply with traffic running: ENABLE ROW LEVEL SECURITY
-- doesn't lock the table for reads or writes, and the policies below
-- explicitly preserve service_role access (USING (true), WITH CHECK
-- (true)). The authenticated-user policies are tightly scoped so
-- there's zero data leak surface if a service_role bug ever exposes
-- an anon-key path to these tables.
--
-- Apply via Supabase SQL editor or `supabase db push`. Rollback:
-- `ALTER TABLE <name> DISABLE ROW LEVEL SECURITY;`.

BEGIN;

-- ── Helper: extract org_id from the request JWT ─────────────────────
-- Centralised so policies stay short. Casts to uuid to match the
-- existing column types on these tables.
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id', '')::uuid;
$$;

-- ── CRM core tables ─────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'crm_leads',
    'crm_activities',
    'crm_contacts',
    'crm_accounts',
    'crm_deals',
    'crm_deal_stages',
    'crm_lead_sources',
    'crm_lead_inbound_events',
    'crm_lead_attribution',
    'crm_lead_source_integrations',
    'crm_pipelines',
    'crm_custom_field_defs',
    'crm_lead_scores',
    'crm_email_templates',
    'crm_whatsapp_templates',
    'crm_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

      -- Service role bypass — backend uses this exclusively, so the
      -- app keeps working unchanged.
      EXECUTE format($p$
        DROP POLICY IF EXISTS %I_service_role ON public.%I;
        CREATE POLICY %I_service_role ON public.%I
          FOR ALL TO service_role
          USING (true) WITH CHECK (true);
      $p$, t || '_service_role', t, t || '_service_role', t);

      -- Authenticated users — read only rows in their own org. Writes
      -- via authenticated context are NOT enabled here; we keep all
      -- mutations going through the backend (which uses service_role
      -- and enforces org scoping in code, see Stage 1 commit).
      EXECUTE format($p$
        DROP POLICY IF EXISTS %I_select_own_org ON public.%I;
        CREATE POLICY %I_select_own_org ON public.%I
          FOR SELECT TO authenticated
          USING (org_id = public.current_org_id());
      $p$, t || '_select_own_org', t, t || '_select_own_org', t);
    END IF;
  END LOOP;
END $$;

-- ── Identity + workspace ─────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'users',
    'organizations',
    'orgs',
    'clients',
    'org_roles',
    'user_module_permissions',
    'user_city_assignments'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
      EXECUTE format($p$
        DROP POLICY IF EXISTS %I_service_role ON public.%I;
        CREATE POLICY %I_service_role ON public.%I
          FOR ALL TO service_role
          USING (true) WITH CHECK (true);
      $p$, t || '_service_role', t, t || '_service_role', t);
    END IF;
  END LOOP;
END $$;

-- ── Fix the two effectively-disabled policies on live tracking ──────
-- These were CREATE POLICY ... USING (true) which lets any
-- authenticated user across all orgs read every row. Rewrite to
-- scope by org_id.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='work_activity') THEN
    DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.work_activity;
    DROP POLICY IF EXISTS work_activity_authenticated_select ON public.work_activity;
    CREATE POLICY work_activity_authenticated_select ON public.work_activity
      FOR SELECT TO authenticated
      USING (org_id = public.current_org_id());
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='activity_users') THEN
    DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.activity_users;
    DROP POLICY IF EXISTS activity_users_authenticated_select ON public.activity_users;
    CREATE POLICY activity_users_authenticated_select ON public.activity_users
      FOR SELECT TO authenticated
      USING (org_id = public.current_org_id());
  END IF;
END $$;

COMMIT;

-- Verification queries to run after apply:
--
--   SELECT relname, relrowsecurity
--   FROM pg_class
--   WHERE relname IN ('crm_leads','crm_activities','users','organizations','work_activity','activity_users')
--   AND relkind = 'r';
--   -- Expect: relrowsecurity = true for each row.
--
--   SELECT tablename, policyname, cmd, roles, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--   AND tablename IN ('crm_leads','crm_activities','work_activity','activity_users')
--   ORDER BY tablename, policyname;
--   -- Expect: per-table you'll see <name>_service_role (FOR ALL, USING true)
--   --         and <name>_select_own_org or <name>_authenticated_select
--   --         (FOR SELECT, USING org_id = current_org_id()).

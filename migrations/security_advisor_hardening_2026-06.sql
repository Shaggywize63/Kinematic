-- Security-advisor remediation (June 2026).
--
-- Applied to BOTH Supabase projects (Tata lnvxqjqfsxvtjvbzphou +
-- Kinematic clldjlojtmrrpozydqxk). The API accesses Postgres only via the
-- service role (which bypasses RLS and keeps every function grant), and clients
-- reach data solely through the Express backend — never the anon/authenticated
-- PostgREST roles directly (proven by the ~82 tables that already ran
-- "RLS enabled, no policy" while the app worked). So every statement below is a
-- safe *tightening*. Written idempotent + existence-guarded so it re-runs cleanly
-- on either project (their object sets overlap but aren't identical).

-- 1) Enable RLS (deny-by-default) on tables that were exposed in `public`
--    (rls_disabled_in_public ERRORs). No policies = no direct anon/authenticated
--    access; the service-role backend is unaffected. Enabling twice is a no-op.
ALTER TABLE IF EXISTS public.crm_automation_event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.notification_groups      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.crm_activity_subjects    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.crm_blocks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.crm_competitor_signals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.crm_report_schedules     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.crm_daily_briefing_log   ENABLE ROW LEVEL SECURITY;

-- 2) Pin a stable search_path so the trigger function isn't role-mutable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'crm_touch_lead_last_activity') THEN
    EXECUTE 'ALTER FUNCTION public.crm_touch_lead_last_activity() SET search_path = public, pg_temp';
  END IF;
END $$;

-- 3) SECURITY DEFINER views -> run with the querying role's privileges (respect
--    RLS) instead of the view owner's. Transparent for the service-role backend.
ALTER VIEW IF EXISTS public.v_today_attendance       SET (security_invoker = true);
ALTER VIEW IF EXISTS public.v_daily_kpis             SET (security_invoker = true);
ALTER VIEW IF EXISTS public.v_route_outlet_detail    SET (security_invoker = true);
ALTER VIEW IF EXISTS public.v_route_plan_daily       SET (security_invoker = true);
ALTER VIEW IF EXISTS public.crm_v_deal_weight        SET (security_invoker = true);
ALTER VIEW IF EXISTS public.v_client_enabled_modules SET (security_invoker = true);

-- 4) Materialized views: remove from the anon/authenticated API surface.
DO $$
DECLARE mv text;
BEGIN
  FOREACH mv IN ARRAY ARRAY['crm_mv_funnel_daily','crm_mv_lead_source_roi',
                            'crm_mv_activity_heatmap','crm_mv_pipeline_value'] LOOP
    IF EXISTS (SELECT 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = mv) THEN
      EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', mv);
    END IF;
  END LOOP;
END $$;

-- 5) SECURITY DEFINER functions: not invokable by PUBLIC/anon/authenticated via
--    PostgREST (functions grant EXECUTE to PUBLIC by default, so a named revoke
--    alone isn't enough). The service role — and postgres owner / pg_cron —
--    retain execute. This closed a real exposure: the *_integration_read/store_
--    credentials helpers were anon-executable. Signature-agnostic; DEFINER-only.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND p.proname IN (
        'clear_user_session','crm_integration_read_credentials',
        'crm_integration_store_credentials','crm_seed_indian_locations',
        'crm_send_email_digest','crm_send_reminders','current_user_org_id',
        'current_user_profile','current_user_role','dist_integration_read_credentials',
        'dist_integration_store_credentials','increment_broadcast_read_count',
        'is_admin_or_above','is_supervisor_or_above','list_lookup_tables','rotate_user_session')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- 6) Relocate citext + pg_trgm out of `public` into the dedicated `extensions`
--    schema. Prep the app roles' search_path first so name resolution never
--    breaks (PostgREST also injects `extensions` into its per-request path).
--    pg_net is intentionally NOT moved — it is supabase_admin-owned and powers
--    Supabase webhooks/cron, so its `extension_in_public` notice is expected.
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
ALTER ROLE anon          SET search_path = "$user", public, extensions;
ALTER ROLE authenticated SET search_path = "$user", public, extensions;
ALTER ROLE service_role  SET search_path = "$user", public, extensions;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'citext' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER EXTENSION citext SET SCHEMA extensions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_trgm' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA extensions';
  END IF;
END $$;

-- 7) MANUAL (dashboard-only, not settable via SQL): enable Auth "Leaked password
--    protection" (HaveIBeenPwned) under
--    Authentication -> Sign In / Providers -> Password settings.

-- Security-advisor hardening pass.
--
-- Applied against the production database via Supabase MCP. Captured here
-- so future schema rebuilds carry the same posture.
--
-- The app uses the service-role key for every backend write (Express +
-- supabaseAdmin), so enabling RLS without policies is the same pattern the
-- 53 already-protected public tables use — it locks the tables down for
-- anon/authenticated callers while leaving server-side traffic untouched.
--
-- Four buckets fixed here:
--   1. rls_disabled_in_public        — 19 tables with RLS off; turn it on
--   2. security_definer_view         — 2 views; switch to security_invoker
--   3. (anon|authenticated)_security_definer_function_executable — 9 funcs;
--      revoke EXECUTE from anon + authenticated. Internal callers all use
--      service_role.
--   4. function_search_path_mutable  — 7 funcs; pin search_path = public, pg_temp
--
-- Skipped (need separate handling):
--   - extension_in_public (citext, pg_trgm, pg_net) — moving extensions is a
--     major refactor that would touch every table using these types/operators
--   - auth_leaked_password_protection — project-level Auth setting, must be
--     toggled in the Supabase dashboard (Auth → Settings → Password Strength
--     → "Prevent use of leaked passwords"), not via SQL

-- ── 1. Enable RLS on tables flagged rls_disabled_in_public ──

ALTER TABLE public.client_modules                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_modules                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_dashboard_layouts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activity_types                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_hierarchy_levels                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_google_integrations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_roles                           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_assignment_rules                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_automations                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_lead_source_integrations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_lead_attribution                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_lead_inbound_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_integrations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_integration_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_external_party_map     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.people_directory                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.people_directory_types              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_targets                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_client_locations                ENABLE ROW LEVEL SECURITY;

-- ── 2. Flip the SECURITY DEFINER views to security_invoker ──

ALTER VIEW public.crm_v_deal_weight        SET (security_invoker = true);
ALTER VIEW public.v_client_enabled_modules SET (security_invoker = true);

-- ── 3. Revoke EXECUTE on SECURITY DEFINER helper functions from anon +
--      authenticated (including their inherited PUBLIC grant), then explicitly
--      grant to service_role so the Express backend keeps working.

DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT (p.oid::regprocedure)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'clear_user_session',
        'crm_integration_read_credentials',
        'crm_integration_store_credentials',
        'crm_seed_indian_locations',
        'crm_send_email_digest',
        'crm_send_reminders',
        'dist_integration_read_credentials',
        'dist_integration_store_credentials',
        'rotate_user_session'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', fn);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END$$;

-- ── 4. Pin search_path on functions flagged function_search_path_mutable.

DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT (p.oid::regprocedure)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'crm_seed_indian_locations',
        'crm_set_updated_at',
        'set_website_lead_default_client',
        'role_subtree_user_ids',
        'crm_recompute_deal_amount',
        'user_subtree_ids',
        'crm_rollup_customer_metrics'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn);
  END LOOP;
END$$;

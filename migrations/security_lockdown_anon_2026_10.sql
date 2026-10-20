-- SECURITY LOCKDOWN (2026-10 audit) — close the anonymous / public-key attack surface on BOTH Supabase projects
-- (kinematic and the Tata default). Apply to each project, then NOTIFY pgrst.
--
-- WHY. The Supabase `anon` key is public by design (the dashboard ships it as NEXT_PUBLIC_SUPABASE_ANON_KEY) and
-- PostgREST is reachable on the internet (supabase-<project>.kinematicapp.com). Live inspection of both databases showed:
--   1. `anon` and `authenticated` hold ALL privileges (incl. TRUNCATE) on every public table; RLS is the only guard.
--   2. Kinematic DB: 5 tables have RLS DISABLED (crm_proposals, crm_proposal_items, crm_telephony_calls, crm_upsells,
--      distribution_stock_batches) -> readable AND writable with just the anon key.
--   3. 21 SECURITY DEFINER functions are EXECUTE-able by `anon`/PUBLIC (PostgREST /rpc/<fn>) with NO caller check, e.g.
--      clone_org_config / promote_org_config / config_promote_items / config_diff (copy or diff one org's config into another),
--      rotate_user_session / clear_user_session (log any user out), crm_integration_store_credentials /
--      dist_integration_store_credentials (overwrite an integration's credentials), crm_seed_indian_locations,
--      crm_record_email_recipients, crm_send_reminders / crm_send_email_digest (trigger sends), gen_*_no (burn numbering).
-- The backend only ever uses the service_role key for these (supabaseAdmin) and never reads tables with the anon client,
-- so none of this is needed by the product. service_role bypasses RLS and is granted EXECUTE explicitly below.
--
-- SAFE TO RE-RUN (idempotent). Takes brief locks; run in a quiet minute. Verify afterwards with the queries at the bottom.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1) Row-level security on every public base table that lacks it. With no policy this is deny-by-default for anon and
--    authenticated; service_role (backend) is unaffected.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    RAISE NOTICE 'RLS enabled on public.%', r.relname;
  END LOOP;
END $$;

-- 2) Functions: nobody but the backend may call them. Extension-owned functions (citext, pg_trgm, uuid-ossp, pgcrypto)
--    are skipped — revoking their PUBLIC execute would break every query that uses those types/operators.
--    The five RLS helper functions stay callable by `authenticated` (policies evaluate them as the invoking role).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.proname NOT IN ('current_user_org_id', 'current_user_profile', 'current_user_role', 'is_admin_or_above', 'is_supervisor_or_above', 'current_org_id') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- 3) Tables / sequences / views: `anon` gets nothing; `authenticated` loses the privileges that RLS cannot police.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;

-- 4) Future objects created by this role must not be auto-granted to anon (Supabase's default does exactly that).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

COMMIT;

-- 5) OPTIONAL (run as the storage owner): the `email-assets` bucket accepts INSERTs from `anon` — an unauthenticated
--    upload of any file type into a public bucket on our domain. Nothing in the backend, dashboard or apps references it.
-- DROP POLICY IF EXISTS email_assets_anon_insert ON storage.objects;

NOTIFY pgrst, 'reload schema';

-- ── Verify (all three must return 0 rows / false) ───────────────────────────────────────────────────────────────────
-- select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity;
-- select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE');
-- select has_table_privilege('anon', 'public.crm_proposals', 'SELECT');
--
-- ── Rollback (only if something unexpected breaks; restores the previous, insecure grants) ──────────────────────────
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC, anon, authenticated;

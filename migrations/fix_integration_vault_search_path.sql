-- Fix: integration credential-vault functions can't find pgcrypto.
--
-- crm_integration_store_credentials / _read_credentials and their dist_*
-- siblings are SECURITY DEFINER functions pinned to
--   search_path = public, pg_catalog
-- On self-hosted Supabase, pgcrypto (pgp_sym_encrypt / pgp_sym_decrypt) is
-- installed in the `extensions` schema, which that search_path omits. So every
-- vault write/read failed with:
--   function pgp_sym_encrypt(text, text) does not exist
-- e.g. storing a Meta Lead Ads Page access token on OAuth connect ("Connected
-- to Facebook, but every Page failed to subscribe").
--
-- Add `extensions` to each function's search_path. Signature-agnostic and
-- idempotent — re-running just re-sets the same search_path.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'crm_integration_store_credentials', 'crm_integration_read_credentials',
        'dist_integration_store_credentials', 'dist_integration_read_credentials')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_catalog', r.sig);
  END LOOP;
END $$;

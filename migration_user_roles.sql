-- Multiple roles per user (additive).
--
-- Today each user holds exactly ONE hierarchy role via users.org_role_id. This
-- adds a join table so a user can be assigned SEVERAL org_roles at once, with
-- their effective module permissions resolved as the UNION of every role.
--
-- Back-compat: users.org_role_id is UNCHANGED and remains the user's PRIMARY
-- role (it still drives the displayed designation + data_scope). Rows in
-- user_roles are purely ADDITIONAL roles layered on top. A user with no rows
-- here behaves exactly as before.
--
-- Additive + idempotent (CREATE TABLE IF NOT EXISTS). NOT applied automatically
-- by hand: the operator runs it (or the boot-time auto-migrate runner does),
-- then NOTIFY pgrst, 'reload schema' (deliberately not part of this file).
-- Conventions mirrored from migration_makes_brands.sql: RLS with the
-- tenant_isolation policy (org_id = auth.jwt()->>'org_id'), grants to
-- authenticated/service_role. The service-role backend (supabaseAdmin) bypasses
-- RLS. There is no updated_at column (a pure join row is never edited in place),
-- so no set_updated_at() trigger is attached.
--
-- NOTE: no top-level BEGIN;/COMMIT; wrapper. The boot-time runner applies this
-- through the exec_migration() RPC (PL/pgSQL EXECUTE), which cannot run
-- transaction-control statements ("EXECUTE of transaction commands is not
-- implemented") — the function call is already atomic. (The other migrations
-- that still carry BEGIN;/COMMIT; were applied via direct psql, never through
-- this RPC, so they never hit that limitation.) psql -1 would also run this
-- file atomically, so dropping the wrapper is safe on both paths.

-- ============================================================= user_roles join table
-- One row per (user, additional role). The user's PRIMARY role stays on
-- users.org_role_id and is NOT duplicated here. ON DELETE CASCADE keeps the
-- join clean when either the user or the role is removed.
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id     uuid NOT NULL REFERENCES public.users(id)     ON DELETE CASCADE,
  org_role_id uuid NOT NULL REFERENCES public.org_roles(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL,
  client_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  PRIMARY KEY (user_id, org_role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON public.user_roles (org_role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_org  ON public.user_roles (org_id);

-- ============================================================= RLS + grants
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY';
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation'
                 AND polrelid = 'public.user_roles'::regclass) THEN
    EXECUTE $f$CREATE POLICY tenant_isolation ON public.user_roles
      USING (org_id = ((( SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid)
      WITH CHECK (org_id = ((( SELECT auth.jwt() AS jwt) ->> 'org_id'::text))::uuid)$f$;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated, service_role';
END $$;

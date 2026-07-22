-- Read-only account flag on users.
--
-- When true, the API's read-only guard (src/middleware/readOnly.ts) blocks every
-- write (POST/PUT/PATCH/DELETE) for the user while leaving all reads (GET) and
-- the login-as/impersonate view-switch intact — so a cross-tenant super_admin can
-- VIEW every tenant but change nothing.
--
-- The shared backend SELECTs is_read_only in the auth middleware, so this column
-- MUST exist in every Supabase project the code serves (default + kinematic, and
-- any future project). Default false = zero behavior change for existing users.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_read_only boolean NOT NULL DEFAULT false;

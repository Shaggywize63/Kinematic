-- A mobile number is no longer required to create a user.
--
-- public.users.mobile was NOT NULL (with UNIQUE (org_id, mobile)). A user without a mobile number is
-- now stored with mobile = NULL: NULLs never collide in a unique index, so any number of users in one
-- organisation can have no mobile, while two users still cannot share the same number.
--
-- Safe to run on a live database and to run twice. Existing rows are untouched (the few rows that
-- hold an empty-string mobile keep it). Run it on EVERY project database (Kinematic and Tata).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f migrations/users_mobile_optional.sql
--
-- Until it has run, creating a user without a mobile number is refused with HTTP 409
-- MOBILE_OPTIONAL_NOT_ENABLED; everything else keeps working.

ALTER TABLE public.users ALTER COLUMN mobile DROP NOT NULL;

-- Make PostgREST pick up the change straight away.
NOTIFY pgrst, 'reload schema';

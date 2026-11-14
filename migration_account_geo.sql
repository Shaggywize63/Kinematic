-- Account geofence columns. The web + mobile New Account forms send latitude/longitude from the Google place
-- pick, but crm_accounts had no columns to hold them, so the geofence was lost on save.
-- Additive and idempotent. Run, then: NOTIFY pgrst, 'reload schema';
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS latitude  double precision;
ALTER TABLE public.crm_accounts ADD COLUMN IF NOT EXISTS longitude double precision;

NOTIFY pgrst, 'reload schema';

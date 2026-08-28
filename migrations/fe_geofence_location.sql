-- Attendance / Geofence — per-field-executive base location
--
-- Geofence attendance previously had no place to configure an FE's expected
-- location: the only geofence source was the shared zone (which usually defaults
-- to 0,0), and the computed distance was recorded but NEVER enforced. This adds
-- an optional per-FE base location + radius.
--
--   base_lat / base_lng  — the FE's expected check-in location.
--   geofence_radius_m     — allowed distance from it (metres).
--
-- When a base location IS set, attendance check-in is geofenced against it and
-- an out-of-radius check-in is rejected — that is what makes geofence attendance
-- actually work. When it is NOT set, behaviour is unchanged (distance recorded
-- against the zone, never rejected), so existing tenants are unaffected until an
-- admin sets an FE's location.
--
-- Applied to Kinematic (clldjlojtmrrpozydqxk) via apply_migration
-- `fe_geofence_location`. Apply to Tata before enabling FE geofencing there.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS base_lat          double precision,
  ADD COLUMN IF NOT EXISTS base_lng          double precision,
  ADD COLUMN IF NOT EXISTS geofence_radius_m integer;

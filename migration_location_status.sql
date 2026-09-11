-- Location-status tracking for the field force.
--
-- Purpose: surface WHEN a rep's device has location turned off, so the
-- dashboard can flag "not reporting" instead of silently showing a stale dot.
-- The device reports its permission/services state (no coordinates) to
-- PATCH /api/v1/users/location-status; a real GPS fix (PATCH /users/status)
-- stamps status = 'on'. The last real fix stays in the existing
-- users.last_latitude / last_longitude / last_location_updated_at columns and
-- is rendered as a clearly-labelled STALE point, never as live.
--
-- All additive + nullable + IF NOT EXISTS, so this is safe to run repeatedly
-- and on both the Kinematic and Tata databases. It changes no existing rows
-- and no existing behaviour.

ALTER TABLE users
  -- Coarse device location state. One of:
  --   'on'           granted + services enabled + sending fixes
  --   'services_off' granted, but device Location Services are off
  --   'denied'       app permission denied by the user
  --   'restricted'   blocked by OS policy / MDM / parental controls
  --   'unknown'      not determined yet (fresh install, never asked)
  ADD COLUMN IF NOT EXISTS location_status text,
  -- true  = full / precise accuracy
  -- false = reduced (iOS) / approximate (Android) accuracy
  ADD COLUMN IF NOT EXISTS location_precise boolean,
  -- When location_status last CHANGED value (i.e. "off since"). Only bumped on
  -- a transition, so the dashboard can say "Location off since 09:42".
  ADD COLUMN IF NOT EXISTS location_status_updated_at timestamptz;

-- Optional backfill: existing reps that already have a recent fix are treated
-- as 'on' as of their last fix, so the dashboard doesn't show every rep as
-- "unknown" on day one. Rows with no fix stay NULL (unknown).
UPDATE users
   SET location_status = 'on',
       location_status_updated_at = last_location_updated_at
 WHERE location_status IS NULL
   AND last_location_updated_at IS NOT NULL;

-- =============================================================================
-- Mode of transport on the day's attendance (EFocus wave 2 / C8).
-- =============================================================================
-- When a client turns on the attendance rule `track_transport_mode`
-- (clients.settings.attendance_rules), the rep says how they are travelling today
-- (a vehicle id from their expense policy, `two_wheeler` / `car`, `public_transport`
-- or `other`) at check-in, and can change it later. The id is stored here.
--
-- Additive and nullable: no default, no index, no backfill. The backend writes
-- `transport_mode` ONLY for a client whose `track_transport_mode` rule is on AND
-- only when the request supplies it, and never lists the column in a generic
-- select/insert — so a project that has NOT run this migration keeps working for
-- every other client. (If a client there turns the rule on anyway, the check-in
-- still succeeds, just without the mode.)
--
-- Apply to the Kinematic Supabase project (`clldjlojtmrrpozydqxk`) ONLY. Do NOT
-- apply to Tata (`lnvxqjqfsxvtjvbzphou`) unless explicitly asked. Idempotent.
-- =============================================================================

ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS transport_mode text;

COMMENT ON COLUMN public.attendance.transport_mode IS
  'Mode of transport for the day (e.g. two_wheeler, car, public_transport, other, or a vehicle id from the user''s expense policy). Written only when the client''s attendance_rules.track_transport_mode is true.';

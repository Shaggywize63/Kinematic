-- Route-deviation alerts — dedupe marker.
--
-- The route_deviation module alerts a rep's supervisor when the rep checks in
-- further from a planned outlet than its geofence allows. This column records
-- that an alert was already sent for a given visit so the scan never notifies
-- twice. Additive + nullable; apply to every project the backend serves.

alter table public.route_plan_outlets
  add column if not exists deviation_alerted_at timestamptz;

comment on column public.route_plan_outlets.deviation_alerted_at is
  'Set when a supervisor was alerted that this visit was off-route (check-in beyond the outlet geofence). Prevents duplicate route_deviation alerts.';

# Live Tracking — Device & Battery Patch

## Goal

Surface `device_model`, `device_brand`, `os_version` and a normalized
`last_location_updated_at` in the `/api/v1/analytics/live-locations` response
so the dashboard can display them next to the FE marker on the live tracking
map and in the Field-Executive detail panel.

The columns already exist on `users` (see `migration_device_info.sql`) and the
mobile clients (Android since this branch + iOS HEARTBEAT) already populate
them when calling `PATCH /api/v1/users/status` (handled by
`updateUserStatus` in `src/controllers/misc.controller.ts`).

The only missing piece was the SELECT clause + response mapping in
`getLiveLocations` (`src/controllers/analytics.controller.ts`).

## Diff to apply

```diff
@@ getLiveLocations
   let execQuery = supabaseAdmin
     .from('users')
-    .select('id, name, employee_id, role, battery_percentage, last_latitude, last_longitude, last_location_updated_at, zone_id, zones!zone_id(name, city, meeting_lat, meeting_lng)')
+    .select('id, name, employee_id, role, battery_percentage, device_model, device_brand, os_version, last_latitude, last_longitude, last_location_updated_at, zone_id, zones!zone_id(name, city, meeting_lat, meeting_lng)')
     .eq('org_id', user.org_id)
     .not('role', 'in', `(${restrictedRoles.join(',')})`);
@@
     return {
       id: fe.id,
       name: fe.name,
       employee_id: fe.employee_id,
       role: fe.role,
       battery_percentage: fe.battery_percentage,
+      device_model: fe.device_model || null,
+      device_brand: fe.device_brand || null,
+      os_version:   fe.os_version   || null,
       zone_name: zone?.name || null,
       city: zone?.city || null,
       status: rec ? (rec.checkout_at ? 'checked_out' : (rec.status === 'on_break' ? 'on_break' : 'active')) : 'absent',
       checkin_at: rec?.checkin_at || null,
       checkout_at: rec?.checkout_at || null,
       lat,
       lng,
       address: rec?.checkin_address || null,
       total_hours: enrichWithHours(rec)?.total_hours || null,
       is_regularised: rec?.is_regularised || false,
+      last_location_updated_at: fe.last_location_updated_at || null,
     };
   });
```

## Backwards compatibility

- New fields default to `null` when the user has never sent a heartbeat.
- The Android client (kinematic-app) already sends these on every heartbeat.
- The iOS client (kinematic-ios) is updated in this branch to send them too,
  using the same `PATCH /api/v1/users/status` endpoint as Android (instead of
  the older `/attendance/pings` route). See `LiveTrackingPing+Device.swift`.

## Dashboard

The dashboard (kinematic-dashboard) live-tracking page already reads these
fields from the response and renders them in the popup + FE detail panel. The
same branch adds:

1. A "Low Battery" KPI tile counting FEs under 20%.
2. A "Low battery only" filter chip.
3. A red alert banner when one or more checked-in FEs drop under 10%.

## Performance

`getLiveLocations` does not need any other change — the dashboard polls every
30 s (already `cache: 'no-store'`) and the queries are already indexed.

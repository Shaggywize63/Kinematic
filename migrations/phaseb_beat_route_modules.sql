-- Phase B — Beat, route & journey planning modules.
--
-- Three new field-force capabilities, each a per-client toggle that master
-- admin switches on at onboarding. All ship OFF by default (no client_modules
-- grants), so production behaviour is unchanged until a client is granted one.
--
--   route_optimization — "optimize & apply" a rep's beat (nearest-neighbour +
--                        2-opt), persisting the new visit order.
--   route_deviation    — off-route / geo-deviation alerts to the supervisor.
--   beat_productivity  — TLSD (total lines sold per day) + unique/productive
--                        outlet metrics.
--
-- The existing FFM analytics widgets (beat-adherence, outlet-coverage,
-- productive-calls, off-route) stay under the `analytics` module — these new
-- modules gate only the NEW surfaces, so no existing tenant loses a widget.
--
-- Apply to every Supabase project the backend serves (default/Tata + kinematic).

insert into public.modules (id, name, description, package, is_universal)
values
  ('route_optimization', 'Route Optimization',
   'Auto-sequence a rep''s beat by shortest travel (nearest-neighbour + 2-opt) and persist the optimized order.',
   'field_force', false),
  ('route_deviation', 'Route Deviation Alerts',
   'Flag visits made outside the planned beat / outlet geofence and alert the supervisor.',
   'field_force', false),
  ('beat_productivity', 'Beat Productivity',
   'Total Lines Sold per Day (TLSD) plus unique and productive outlet metrics per rep.',
   'field_force', false)
on conflict (id) do update
  set name = excluded.name,
      description = excluded.description,
      package = excluded.package,
      is_universal = excluded.is_universal;

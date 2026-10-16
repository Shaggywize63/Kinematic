-- Register the Timeline module in the catalog.
--
-- Timeline is the mobile apps' read-out of a person's day (check-in, travel legs, customer visits,
-- halts, check-out) — the same data the web Daily Travel Report shows. Field executives see their own
-- day; managers can also pick someone on their team.
--
-- Non-universal + granted to NO client here = OFF by default for every tenant. A master admin turns it
-- on per client from the dashboard Clients page (which writes a `client_modules` row); the apps then
-- read it via the enabled_modules entitlement. The data endpoints (GET /attendance/daily-report,
-- /daily-report/team) are not module-gated — a person may always read their own day — so this only
-- decides whether the app shows the menu entry. Idempotent — safe to re-run. Apply to every Supabase
-- project the backend serves (default/Tata + kinematic).
insert into modules (id, name, description, package, is_universal)
values (
  'timeline',
  'Timeline',
  'In-app timeline of a day: check-in, travel, customer visits, halts and check-out (own day for field executives, team for managers).',
  'field_force',
  false
)
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  package     = excluded.package,
  is_universal = excluded.is_universal;

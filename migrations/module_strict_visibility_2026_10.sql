-- Modules: a client sees exactly what Client Management ticked.
--
-- Until now 17 modules were flagged is_universal (Users, Settings, Reports, Leave, Broadcast, Notifications, Visit
-- Logs, Grievances, HR, Cities, Zones, Outlets, Security Alerts, SKUs, Assets, Warehouse, Clients). They were switched
-- on for every client whether ticked or not, so a client could see more than its ticks. This migration makes every
-- module a tick, WITHOUT changing what any existing client sees today:
--
--   1. Register the four app sections that never had a module of their own (Learning Hub, Leaderboard, Activity Feed,
--      Emergency SOS) so they can be ticked too.
--   2. Grandfather: give every client an explicit tick for each module it effectively has today (the formerly
--      universal ones, plus the four new ones). Existing ticks are left alone.
--   3. Clear is_universal. v_client_enabled_modules then reports exactly the ticks.
--
-- From here on a new client only gets what is ticked for it; an admin unticks a module to take it away.
--
-- Additive and idempotent. Apply to the KINEMATIC database only (Tata keeps the legacy behaviour; the strict model is
-- switched on per project with MODULE_STRICT_PROJECTS, default "kinematic").
begin;

insert into modules (id, name, description, package, is_universal) values
  ('learning',      'Learning Hub',    'Learning materials in the mobile apps.',                     'people',      false),
  ('leaderboard',   'Leaderboard',     'The rep leaderboard in the mobile apps.',                    'people',      false),
  ('activity_feed', 'Activity Feed',   'The rep''s submitted-activity feed in the mobile apps.',      'field_force', false),
  ('emergency_sos', 'Emergency SOS',   'The SOS alert button and screen in the mobile apps.',        'people',      false)
on conflict (id) do nothing;

insert into client_modules (client_id, module_id, enabled, source, granted_by)
select c.id, m.id, true, 'grandfather_2026_10', null
from clients c
cross join modules m
where (m.is_universal or m.id in ('learning', 'leaderboard', 'activity_feed', 'emergency_sos'))
  and not exists (select 1 from client_modules x where x.client_id = c.id and x.module_id = m.id);

update modules set is_universal = false where is_universal;

commit;

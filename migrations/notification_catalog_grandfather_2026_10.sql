-- Notification catalogue: keep today's behaviour for every org that already exists.
--
-- From now on a client receives a notification only if its kind is in org_settings
-- 'notifications.enabled_kinds' (services/notificationPolicy.ts), and a client with no row receives nothing.
-- Without this seed that would silently switch off everything for clients that get notifications today.
-- This gives every existing org that has users the wildcard ["*"] (= every kind, as before). Orgs created
-- afterwards have no row and so start with notifications off.
--
-- Apply to the KINEMATIC database only. The Tata project is switched off as a whole by
-- NOTIFICATIONS_DISABLED_PROJECTS (default "default"), so seeding it would be pointless and, if that switch is
-- ever lifted, would turn every kind on there.
--
-- Additive and idempotent: orgs that already have a row (an admin's choice) are left alone.
insert into org_settings (org_id, key, value, updated_by)
select o.id, 'notifications.enabled_kinds', '["*"]'::jsonb, null
from organisations o
where exists (select 1 from users u where u.org_id = o.id)
  and not exists (select 1 from org_settings s where s.org_id = o.id and s.key = 'notifications.enabled_kinds');

-- Register the "leave" module so the dashboard nav can surface it.
--
-- The leave feature (leave_management.sql + /api/v1/leave) shipped without a row
-- in the `modules` catalog, so `resolveEntitlements()` never emitted 'leave' in
-- any user's enabled_modules and the sidebar entry (module: 'leave') was gated
-- out for everyone except platform admins. Registering it as a UNIVERSAL module
-- mirrors every other People-package module (hr, grievances, notifications, …):
-- `v_client_enabled_modules` unions universal modules into every client's grant,
-- so the entitlement gate passes for all tenants without a per-client SKU.
--
-- Applied to BOTH Supabase projects (Tata `lnvxqjqfsxvtjvbzphou` +
-- Kinematic `clldjlojtmrrpozydqxk`). Idempotent.

insert into modules (id, name, description, package, is_universal)
values ('leave', 'Leave',
        'Leave management, balances & attendance regularization',
        'people', true)
on conflict (id) do update
  set is_universal = true,
      package      = 'people',
      name         = 'Leave';

-- Grant Leave into every INTERNAL org-role's read permissions so field reps
-- (not just admins) see the tab on web — leave self-service is universal for
-- employees. External Distributor roles are excluded (they don't manage
-- employee leave). Legacy roles with empty permissions already fall through to
-- the entitlement grant, so they need no change. Idempotent.
update org_roles
   set permissions = array_append(permissions, 'leave')
 where not ('leave' = any(permissions))
   and name not ilike '%distributor%';

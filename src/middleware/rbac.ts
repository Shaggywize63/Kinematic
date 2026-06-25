import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { forbidden, unauthorized } from '../utils/response';
import { isDemo } from '../utils/demoData';

/**
 * Middleware to check for module-level access.
 * Admins always have access to all modules.
 */
export function requireModule(moduleName: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);
    if (isDemo(req.user)) return next();

    const { role, permissions, enabled_modules } = req.user;

    // super_admin bypasses both the entitlement gate and per-user RBAC.
    if (role === 'super_admin') return next();

    // Entitlement gate (per-client SKU). When a client has any entitlements
    // resolved, the module must be in the enabled set; otherwise the SKU was
    // not purchased/granted.
    const entitlements = enabled_modules || [];
    if (entitlements.length > 0 && !entitlements.includes(moduleName)) {
      return forbidden(res, `Module not enabled for your account: ${moduleName}`);
    }

    // Per-user RBAC inside a client: legacy permissions array still respected.
    // If a client-admin role with no per-user permissions reaches here, the
    // entitlement membership above is sufficient.
    if (permissions && permissions.includes(moduleName)) return next();
    if (entitlements.includes(moduleName)) return next();

    return forbidden(res, `Access denied: You do not have permission to access the ${moduleName} module.`);
  };
}

// Methods that only read data — everything else is treated as a write and
// gated against the role's permissions_write set.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Returns true when the caller has an explicit, role-driven permission set
 * we should enforce strictly. Users with an org_role attached are governed
 * by org_roles.permissions / permissions_write; users without one fall back
 * to the legacy entitlement-only behaviour so existing admin accounts that
 * were never given a granular role keep working unchanged.
 */
function hasRoleGovernedPerms(user: AuthRequest['user']): boolean {
  // Only enforce strictly when the role actually carries a permissions array.
  // A role whose `permissions` is NULL (never configured) is treated as
  // unconfigured and falls back to the legacy path, so a misconfiguration
  // can't silently lock a user out of every module.
  return !!(user && (user as any).org_role_id && Array.isArray(user.role_permissions));
}

/**
 * Granular, method-aware module gate. Unlike requireModule (which gates the
 * CRM *package* and is satisfied by a client-level entitlement), this enforces
 * the per-designation grants the Roles UI configures:
 *
 *   - GET/HEAD  → module must be in the role's read permissions.
 *   - mutating  → module must be in the role's permissions_write set.
 *
 * Entitlement is still a necessary upper bound (the client must own the SKU),
 * but it is no longer *sufficient*: a user whose role omits `crm_settings`
 * can no longer read or write settings just because the client is entitled.
 *
 * Users without an org_role (legacy admins) keep the old entitlement-or-
 * per-user-permission behaviour so this change can't lock them out.
 */
export function requireModuleAccess(moduleName: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);
    if (isDemo(req.user)) return next();

    const role = req.user.role?.toLowerCase();
    if (role === 'super_admin') return next();

    const entitlements = req.user.enabled_modules || [];
    // Entitlement gate: the client must own the module SKU at all.
    if (entitlements.length > 0 && !entitlements.includes(moduleName)) {
      return forbidden(res, `Module not enabled for your account: ${moduleName}`);
    }

    const isWrite = !READ_METHODS.has(req.method.toUpperCase());

    if (hasRoleGovernedPerms(req.user)) {
      const readPerms = req.user.role_permissions || [];
      // Fall back to read perms when a role has no explicit write list, so a
      // misconfigured (empty) permissions_write doesn't silently freeze writes
      // for a role that can clearly read+act on the module.
      const writePerms = (req.user.role_permissions_write && req.user.role_permissions_write.length > 0)
        ? req.user.role_permissions_write
        : readPerms;
      const perms = isWrite ? writePerms : readPerms;
      if (perms.includes(moduleName)) return next();
      return forbidden(
        res,
        isWrite
          ? `You don't have write access to the ${moduleName} module.`
          : `Access denied: You do not have permission to access the ${moduleName} module.`,
      );
    }

    // Legacy path (no org_role): per-user permissions or entitlement suffice.
    const permissions = req.user.permissions || [];
    if (permissions.includes(moduleName)) return next();
    if (entitlements.includes(moduleName)) return next();
    return forbidden(res, `Access denied: You do not have permission to access the ${moduleName} module.`);
  };
}

/**
 * Lenient variant — passes when the user has access to ANY of the
 * supplied modules (read or write depending on the request method).
 * Used by routes whose semantics span multiple modules (e.g. the
 * activity-subjects catalogue is "activities settings": CRM Admin
 * legitimately reaches it via crm_settings, but an org that has
 * carved out a dedicated "Activities Admin" role with only
 * crm_activities write should also be able to manage subjects).
 */
export function requireAnyModuleAccess(moduleNames: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);
    if (isDemo(req.user)) return next();

    const role = req.user.role?.toLowerCase();
    if (role === 'super_admin') return next();

    const entitlements = req.user.enabled_modules || [];
    // Entitlement gate: any one of the modules must be enabled for the
    // client. (Most CRM modules are bundled together, so this is a
    // formality except for surgically narrow installs.)
    if (entitlements.length > 0 && !moduleNames.some((m) => entitlements.includes(m))) {
      return forbidden(res, `None of the required modules are enabled for your account: ${moduleNames.join(', ')}`);
    }

    const isWrite = !READ_METHODS.has(req.method.toUpperCase());

    if (hasRoleGovernedPerms(req.user)) {
      const readPerms = req.user.role_permissions || [];
      const writePerms = (req.user.role_permissions_write && req.user.role_permissions_write.length > 0)
        ? req.user.role_permissions_write
        : readPerms;
      const perms = isWrite ? writePerms : readPerms;
      if (moduleNames.some((m) => perms.includes(m))) return next();
      return forbidden(
        res,
        isWrite
          ? `You don't have write access to any of: ${moduleNames.join(', ')}.`
          : `Access denied: You do not have permission to access ${moduleNames.join(', ')}.`,
      );
    }

    // Legacy path: per-user permissions or entitlement suffice.
    const permissions = req.user.permissions || [];
    if (moduleNames.some((m) => permissions.includes(m) || entitlements.includes(m))) return next();
    return forbidden(res, `Access denied: You do not have permission to access ${moduleNames.join(', ')}.`);
  };
}

/**
 * Middleware to enforce city-level data restriction.
 * City Managers only see data for their assigned cities.
 */
export function enforceCityScope(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return unauthorized(res);
  if (isDemo(req.user)) return next();

  const { role, assigned_cities } = req.user;

  // Only City Managers are restricted by assigned_cities (per requirements)
  // Admins and Sub-Admins have global access unless specified otherwise
  if (role !== 'city_manager') {
    return next();
  }

  if (!assigned_cities || assigned_cities.length === 0) {
    // If a City Manager has no city assigned → no data access
    return forbidden(res, 'Access denied: No cities assigned to your account.');
  }

  next();
}

/**
 * Helper to get city filter for database queries.
 * Use this in controllers to restrict data based on assigned cities.
 */
export function getCityFilter(req: AuthRequest) {
  if (!req.user) return [];

  const { role, assigned_cities } = req.user;

  // Only City Managers are restricted by city assignment
  if (role === 'city_manager' && assigned_cities && assigned_cities.length > 0) {
    return assigned_cities;
  }

  return [];
}

/**
 * Returns the effective city NAMES this user is allowed to see, for CRM
 * record-geo-tag filtering (crm_leads.city, crm_contacts.city — both text).
 *
 *   null  → no restriction (super_admin, or neither role nor user defines
 *           a scope). Caller should NOT filter at all.
 *   []    → restriction active but no overlap (intentionally empty). Caller
 *           SHOULD filter to zero rows.
 *   [...] → restrict CRM reads to records whose city is in this list.
 *
 * Model: hierarchy role's `assigned_cities` is the upper cap; user-level
 * `assigned_city_names` narrows further. Empty user-level means "inherit
 * the role's full list". Empty role list means "no role-level cap" — the
 * user list is the scope. Both empty → null (no restriction).
 */
export function getEffectiveCityNames(user: AuthRequest['user']): string[] | null {
  if (!user) return null;
  // Platform-tier users see everything regardless of city.
  if (user.role === 'super_admin' || user.role === 'admin') return null;
  // Tenant-level admins whose org_role explicitly opts into
  // data_scope='all' (e.g. CRM Admin, Business Head) are also exempt
  // from the city geo-cap. The user_city_assignments rows on these
  // accounts are used as a DEFAULT city filter for convenience, not
  // a visibility ceiling — without this bypass, a CRM Admin with 10
  // assigned cities silently loses every lead in the other ~90, even
  // though their role was explicitly configured for org-wide reads.
  // Without this branch the only escape was the legacy `users.role`
  // column ('admin' / 'super_admin'), which most modern tenants
  // don't populate — they configure the same intent through org_roles
  // instead. See bug: Hema (sub_admin + CRM Admin) saw 1613/1859
  // active Tata leads because her 10 user_city_assignments rows
  // narrowed the in-city slice to ~1058 of ~1273.
  if (user.org_role_data_scope === 'all') return null;

  const roleList = (user.role_assigned_cities || []).filter(Boolean);
  const userList = (user.assigned_city_names || []).filter(Boolean);

  if (roleList.length === 0 && userList.length === 0) return null;

  if (userList.length === 0) return roleList.slice();          // user inherits role
  if (roleList.length === 0) return userList.slice();          // no role cap

  // Both defined → intersect, capping user to role.
  const roleSet = new Set(roleList);
  return userList.filter((c) => roleSet.has(c));
}

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

  const roleList = (user.role_assigned_cities || []).filter(Boolean);
  const userList = (user.assigned_city_names || []).filter(Boolean);

  if (roleList.length === 0 && userList.length === 0) return null;

  if (userList.length === 0) return roleList.slice();          // user inherits role
  if (roleList.length === 0) return userList.slice();          // no role cap

  // Both defined → intersect, capping user to role.
  const roleSet = new Set(roleList);
  return userList.filter((c) => roleSet.has(c));
}

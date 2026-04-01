import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { forbidden, unauthorized } from '../utils/response';

/**
 * Middleware to check for module-level access.
 * Admins always have access to all modules.
 */
export function requireModule(moduleName: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);

    const { role, permissions } = req.user;

    // Only super_admin has full access pass. 
    // Client admins ('admin' role) should still be restricted by assigned permissions.
    if (role === 'super_admin') {
      return next();
    }

    // Sub-Admin and City Manager must have the module in their permissions
    if (permissions && permissions.includes(moduleName)) {
      return next();
    }

    return forbidden(res, `Access denied: You do not have permission to access the ${moduleName} module.`);
  };
}

/**
 * Middleware to enforce city-level data restriction.
 * City Managers only see data for their assigned cities.
 */
export function enforceCityScope(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return unauthorized(res);

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

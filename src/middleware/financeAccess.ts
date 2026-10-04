import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../utils';
import { MASTER_ADMIN_EMAIL } from './auth';

export const FINANCE_MODULE_ID = 'finance';

// Roles that may use Finance when it has been explicitly shared with a client.
const CLIENT_FINANCE_ROLES = new Set(['admin', 'main_admin', 'client']);

/**
 * True when the REAL caller is the master admin — also while the master is
 * impersonating another user (the minted identity is the target; the master's
 * email survives on `impersonated_by`).
 */
export function isMasterCaller(req: AuthRequest): boolean {
  const u = req.user as { email?: string; impersonated_by?: { email?: string } } | undefined;
  const real = u?.impersonated_by?.email ?? u?.email;
  return typeof real === 'string' && real.toLowerCase() === MASTER_ADMIN_EMAIL;
}

/**
 * Finance access gate.
 *
 *  - Master admin: always.
 *  - Anyone else: only when the `finance` module was explicitly granted to their
 *    client (client_modules) AND their role is a client-admin role. We check
 *    `enabled_modules` directly instead of requireModule(): requireModule lets
 *    super_admin through and treats an empty entitlement list as "allow all",
 *    neither of which is acceptable for billing data.
 */
export function requireFinanceAccess(req: AuthRequest, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, 'Unauthorized', 'UNAUTHORIZED'));
  if (isMasterCaller(req)) return next();

  const role = (req.user.role || '').toLowerCase();
  const granted = (req.user.enabled_modules || []).includes(FINANCE_MODULE_ID);
  if (granted && req.user.client_id && CLIENT_FINANCE_ROLES.has(role)) return next();

  return next(new AppError(403, 'Finance is not available for your account', 'FORBIDDEN'));
}

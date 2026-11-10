import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../utils';
import { isMasterCaller } from './financeAccess';

/**
 * HRMS access gate: the master admin, as themselves.
 *
 * Stricter than Finance. Finance lets the master through while impersonating (the real caller is still the master);
 * HRMS does not. The module holds personal data (PAN, bank accounts, dates of birth), so a request made while viewing
 * AS another user or client is refused. The dashboard hides the module in that state too; this is the enforcement.
 *
 *  - not signed in                      -> 401
 *  - impersonating (impersonated_by)    -> 403
 *  - anyone but the master admin        -> 403 (no module grant can open this: there is no client sharing)
 */
export function requireHrmsAccess(req: AuthRequest, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, 'Unauthorized', 'UNAUTHORIZED'));
  if ((req.user as { impersonated_by?: unknown }).impersonated_by) {
    return next(new AppError(403, 'HRMS is not available while viewing as another user', 'FORBIDDEN'));
  }
  if (!isMasterCaller(req)) return next(new AppError(403, 'HRMS is not available for your account', 'FORBIDDEN'));
  return next();
}

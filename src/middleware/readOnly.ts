import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { forbidden } from '../utils/response';

// HTTP methods that only read data. Everything else is a write.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// V1-relative paths a read-only account may still POST to — these authenticate
// or SWITCH which tenant is being VIEWED and never mutate our data:
//   POST /clients/:id/login-as, POST /clients/:id/impersonate
// (they only SELECT + mint an acting-as token; see client.controller.ts).
// /auth/* session ops don't need listing here — the global requireAuth
// catch-all next()s them before auth, so they reach this guard with no
// req.user and are exempted by the `!user` check below.
const VIEW_SWITCH_ALLOW: RegExp[] = [
  /^\/clients\/[^/]+\/(login-as|impersonate)$/,
];

/**
 * Blocks every write (POST/PUT/PATCH/DELETE) for a user flagged
 * `users.is_read_only`. All reads pass, so a read-only super_admin keeps full
 * cross-tenant VIEW access — cross-org viewing is GET-only (the dashboard scopes
 * to another org via the X-Org-Id header, honoured by maybeImpersonate). The one
 * non-GET such an account needs is the login-as/impersonate view-switch, which is
 * allowlisted above.
 *
 * Unlike requireModule / requireRole, this deliberately does NOT exempt
 * super_admin — the whole point is a super_admin that can look but not touch.
 * Mounted once on the V1 catch-all, after requireAuth has populated req.user.
 */
export function readOnlyGuard(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user || !user.is_read_only) return next();            // not a read-only account
  if (READ_METHODS.has(req.method)) return next();           // all viewing is allowed
  if (VIEW_SWITCH_ALLOW.some((re) => re.test(req.path))) return next(); // switch tenant view
  return forbidden(res, 'This account is read-only and cannot make changes.');
}

import type { Request } from 'express';
import { AppError } from '../../utils';
import { getClientScope } from '../../lib/tenancy';
import type { AuthRequest } from '../../types';

export interface FinanceScope {
  org_id: string;
  /** NULL = the org's own books. Set = a specific client's books. */
  client_id: string | null;
  user_id: string;
  actor: string;
}

export function scopeOf(req: Request): FinanceScope {
  const u = (req as AuthRequest).user as (AuthRequest['user'] & { id?: string; email?: string }) | undefined;
  const org = u?.org_id ?? (req.headers['x-org-id'] as string | undefined);
  if (!org) throw new AppError(400, 'No organisation on request', 'NO_ORG');
  return {
    org_id: org,
    client_id: getClientScope(req).id,
    user_id: String(u?.id ?? ''),
    actor: String(u?.email ?? u?.id ?? ''),
  };
}

/** Apply the tenant filter to any PostgREST builder: same org, same client (or the org's own NULL books). */
export function scoped<T>(q: T, s: FinanceScope): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (q as any).eq('org_id', s.org_id);
  return (s.client_id ? b.eq('client_id', s.client_id) : b.is('client_id', null)) as T;
}

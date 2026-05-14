import type { Request } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClientScope {
  /** Resolved client UUID, or null when no client filter applies. */
  id: string | null;
  /** When true, queries MUST hard-filter by client_id (no NULL/legacy leak). */
  strict: boolean;
  /** How the scope was determined - useful for logging/debug. */
  source: 'jwt' | 'header' | 'none';
}

/**
 * Resolve the client scope for any request.
 *
 * Precedence:
 *   1. JWT-pinned client (req.user.client_id)  -> strict, source='jwt'
 *   2. X-Client-Id header (admin/super_admin picker) -> strict, source='header'
 *   3. None -> id=null, strict=false, source='none' (super_admin sees all,
 *      org admins fall back to org-level NULL rows).
 */
export function getClientScope(req: Request): ClientScope {
  const r = req as Request & { user?: { client_id?: string | null } };
  const jwtId = r.user?.client_id;
  if (jwtId && UUID_RE.test(String(jwtId))) {
    return { id: String(jwtId), strict: true, source: 'jwt' };
  }
  const header = (req.headers['x-client-id'] as string | undefined)?.trim();
  if (header && UUID_RE.test(header)) {
    return { id: header, strict: true, source: 'header' };
  }
  return { id: null, strict: false, source: 'none' };
}

/** Convenience: just the id, or null. */
export function getClientId(req: Request): string | null {
  return getClientScope(req).id;
}

/** True when the caller is acting as super_admin (case-insensitive). */
export function isSuperAdmin(req: Request): boolean {
  const r = req as Request & { user?: { role?: string | null } };
  return (r.user?.role ?? '').toLowerCase() === 'super_admin';
}

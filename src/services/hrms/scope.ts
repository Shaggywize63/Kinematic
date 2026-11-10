import type { Request } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import type { AuthRequest } from '../../types';

/**
 * Every HRMS query runs in the caller's own org with client_id NULL. Unlike Finance, the X-Client-Id header is
 * deliberately ignored: HRMS has no per-client books, and honouring the header would let one request reach a client's
 * rows (there are none) or, worse, write rows under a client id.
 */
export interface HrmsScope {
  org_id: string;
  /** The signed-in user's id when it is a uuid (history / access-log rows keep it), else null. */
  user_id: string | null;
  /** Who the history and access-log rows name: the user's name, else email, else id. */
  actor: string;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scopeOf(req: Request): HrmsScope {
  const u = (req as AuthRequest).user as (AuthRequest['user'] & { id?: string; email?: string; name?: string }) | undefined;
  const org = u?.org_id;
  if (!org || !UUID_RE.test(String(org))) throw new AppError(400, 'No organisation on request', 'NO_ORG');
  const id = u?.id ? String(u.id) : '';
  return {
    org_id: String(org),
    user_id: UUID_RE.test(id) ? id : null,
    actor: String(u?.name || u?.email || u?.id || 'Unknown').slice(0, 200),
  };
}

/** Apply the tenant filter to any PostgREST builder: the caller's org and the org's own (NULL client) rows. */
export function scoped<T>(q: T, s: HrmsScope): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (q as any).eq('org_id', s.org_id).is('client_id', null) as T;
}

/** Columns every insert must carry so the row lands in the caller's scope. */
export const scopeCols = (s: HrmsScope) => ({ org_id: s.org_id, client_id: null as string | null });

export const db = () => supabaseAdmin;

// PostgREST says PGRST205 for a table that is not in its schema cache, PGRST202 for a missing function; Postgres itself
// says 42P01 (undefined table). All of them mean the migration has not been applied (or PostgREST has not reloaded).
const NOT_READY = new Set(['PGRST205', 'PGRST202', '42P01']);

type DbError = { message?: string; code?: string } | null | undefined;

export function isNotReady(e: DbError): boolean {
  if (!e) return false;
  if (e.code && NOT_READY.has(e.code)) return true;
  return /hrms_\w+/i.test(e.message ?? '') && /(does not exist|schema cache)/i.test(e.message ?? '');
}

export function fail(e: DbError): AppError {
  if (isNotReady(e)) return new AppError(503, 'HRMS storage is not set up yet', 'HRMS_NOT_READY');
  return new AppError(500, e?.message || 'Database error', 'DB_ERROR');
}

/** Unwrap a PostgREST result: throw the mapped error, else return the data. */
export function must<T>(res: { data: T | null; error: DbError }): T {
  if (res.error) throw fail(res.error);
  return res.data as T;
}

export const isUniqueViolation = (e: DbError, constraintHint?: string): boolean =>
  !!e && e.code === '23505' && (!constraintHint || (e.message ?? '').includes(constraintHint));
export const isForeignKeyViolation = (e: DbError): boolean => !!e && e.code === '23503';

/** Read every row of a query, a page at a time (PostgREST caps one response, 1000 rows by default). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<any>, pageSize = 1000, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = (await build(page * pageSize, page * pageSize + pageSize - 1)) as { data: T[] | null; error: DbError };
    if (error) throw fail(error);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

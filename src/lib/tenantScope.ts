import { Request } from 'express';
import { supabaseAdmin } from './supabase';
import { currentProjectKey, DEFAULT_PROJECT } from './projects';
import { AppError, isUUID } from '../utils';
import type { AuthRequest } from '../types';

/**
 * Tenant scoping for the cross-client "team" reads (Work Activities, team attendance, route plans).
 *
 * Those endpoints used to treat any client-unbound `admin` / `super_admin` — or anyone whose NAME contained
 * "sagar" — as a platform operator and, with no client picked, returned EVERY org's rows. On the Kinematic
 * project (15 customer orgs in one database) that surfaced ByteBack's field reps inside the Kinematic admin's
 * Work Activities. The rule here is simple: a response only ever holds ONE org's rows.
 *
 *  - client-bound caller  → their own org (the JWT pins the client; headers are ignored);
 *  - everyone else        → their own org, unless they PICK a client (X-Client-Id header, then ?client_id=);
 *  - a picked client      → allowed only if it lives in / is owned by the caller's org, or the caller is an
 *                           allow-listed platform operator (who may act as any client — never "all at once").
 *
 * The Tata `default` project keeps its aggregated "All clients" view, but ONLY for the named platform operators
 * (resolveTenantScope). Anyone else there — an unbound admin, a client-role user, a name containing "sagar" — gets
 * their own org, and a picked client is verified exactly as above. `TENANT_LEGACY_SCOPE=on` restores the old
 * any-admin global view and unverified picks without a code change (kill switch).
 */

/** Cross-org platform operators: named super-admins only — NOT "any super_admin" and never a name match. */
const PLATFORM_OPERATOR_EMAILS = new Set(
  (process.env.CROSS_ORG_SUPERADMIN_EMAILS || 's@kinematicapp.com,sagar@horizontechstudio.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

type Caller = { role?: string | null; email?: string | null; client_id?: string | null; org_id?: string | null } | undefined;

export const isPlatformOperator = (user: Caller): boolean =>
  (user?.role || '').toLowerCase() === 'super_admin'
  && !isUUID(user?.client_id)
  && PLATFORM_OPERATOR_EMAILS.has((user?.email || '').trim().toLowerCase());

/**
 * The strict one-org rule (no aggregated view at all, not even for operators) applies to every project except the
 * historical Tata `default`, whose platform operators (SRS / PASA / BMW sit under three different orgs there) rely on
 * the aggregated "All clients" view — see resolveTenantScope.
 */
export const usesStrictTenantScope = (): boolean => currentProjectKey() !== DEFAULT_PROJECT;

/** The dashboard's "All clients" picker sentinels — "no client picked", never a real client. */
const isAllClientsSentinel = (v: unknown): boolean => v === 'Kinematic' || v === '00000000-0000-0000-0000-000000000000';

export interface TenantScope {
  /** The one org every query must be filtered to. */
  scopeOrgId: string | null;
  /** The client picked (JWT-pinned, header, or query) — null when none. */
  pickedClientId: string | null;
  isClientBound: boolean;
}

/**
 * Resolve the single org a team read may return. Throws 404 for a client that doesn't exist or isn't the
 * caller's to use (a 404, not a 403, so ids can't be probed).
 */
export async function resolveStrictTenantScope(req: Request | AuthRequest, queryClientId?: unknown): Promise<TenantScope> {
  const user = (req as AuthRequest).user!;
  const own = (user.org_id as string | undefined) ?? null;

  if (isUUID(user.client_id)) {
    if (!own) throw new AppError(403, 'No organisation context', 'NO_ORG');
    return { scopeOrgId: own, pickedClientId: user.client_id as string, isClientBound: true };
  }

  const header = req.headers['x-client-id'];
  const headerId = String((Array.isArray(header) ? header[0] : header) ?? '').trim();
  const queryId = isAllClientsSentinel(queryClientId) ? '' : String(queryClientId ?? '').trim();
  const picked = isUUID(headerId) ? headerId : isUUID(queryId) ? queryId : null;
  if (!picked) {
    // No org context at all must never mean "no org filter".
    if (!own) throw new AppError(403, 'No organisation context', 'NO_ORG');
    return { scopeOrgId: own, pickedClientId: null, isClientBound: false };
  }

  // owner_org_id only exists on org-per-client projects; fall back without it.
  let res = await supabaseAdmin.from('clients').select('id, org_id, owner_org_id').eq('id', picked).maybeSingle();
  if (res.error && /owner_org_id|42703/.test(`${res.error.message} ${res.error.code ?? ''}`)) {
    res = await supabaseAdmin.from('clients').select('id, org_id').eq('id', picked).maybeSingle();
  }
  const row = (res.data as { org_id?: string | null; owner_org_id?: string | null } | null) ?? null;
  if (!row) throw new AppError(404, 'Client not found', 'NOT_FOUND');

  if (!callerMayUseClientRow(user, row)) throw new AppError(404, 'Client not found', 'NOT_FOUND');
  const scopeOrgId = row.org_id ?? own;
  if (!scopeOrgId) throw new AppError(403, 'No organisation context', 'NO_ORG');
  return { scopeOrgId, pickedClientId: picked, isClientBound: false };
}

/** May the caller read a single row stamped with `rowOrgId`? Own org, or a platform operator acting as a client. */
export const callerMayReadOrg = (user: Caller, rowOrgId: unknown): boolean =>
  (!!user?.org_id && rowOrgId === user.org_id) || isPlatformOperator(user);

/** Kill switch: TENANT_LEGACY_SCOPE=on brings back the pre-fix Tata behaviour (any admin may see every org). */
const legacyTenantScope = (): boolean =>
  (process.env.TENANT_LEGACY_SCOPE || '').toLowerCase() === 'on' && currentProjectKey() === DEFAULT_PROJECT;

/** Enforcement flags that used to be opt-in (`=on`) and are now on unless explicitly `off`. */
export const enforcedUnlessOff = (flag: string): boolean => (process.env[flag] || '').trim().toLowerCase() !== 'off';

/** Callers the pre-fix Tata code treated as platform-wide: any unbound admin tier, or a name containing "sagar". */
const legacyGlobalCaller = (user: Caller & { name?: string | null }): boolean => {
  if (isUUID(user?.client_id)) return false;
  const role = (user?.role || '').toLowerCase();
  return ['super_admin', 'admin', 'main_admin', 'master_admin'].includes(role)
    || (user?.name || '').toLowerCase().includes('sagar');
};

/**
 * May the caller use a client they PICKED (X-Client-Id / ?client_id=) rather than one their JWT pins? Yes when the
 * client lives in, or is owned by, the caller's org, or the caller is an allow-listed platform operator.
 */
export const callerMayUseClientRow = (
  user: Caller & { name?: string | null },
  row: { org_id?: string | null; owner_org_id?: string | null },
): boolean => {
  const own = user?.org_id;
  if (own && (row.org_id === own || row.owner_org_id === own)) return true;
  if (isPlatformOperator(user)) return true;
  return legacyTenantScope() && (user?.role || '').toLowerCase() === 'super_admin';
};

export interface TenantScopeResult extends TenantScope {
  /** True only for the Tata aggregated view: no org filter at all. Never true on any other project. */
  isGlobal: boolean;
}

/**
 * The scope for a cross-client "team" read on ANY project.
 *
 *  - every project except Tata  → exactly resolveStrictTenantScope (one org, always);
 *  - Tata `default`             → the same one-org rule, except an allow-listed platform operator with no client
 *                                 picked keeps the aggregated "All clients" view (`isGlobal`, scopeOrgId null).
 *
 * A picked client that isn't the caller's to use is a 404, whichever project and role.
 */
export async function resolveTenantScope(req: Request | AuthRequest, queryClientId?: unknown): Promise<TenantScopeResult> {
  if (usesStrictTenantScope()) return { ...(await resolveStrictTenantScope(req, queryClientId)), isGlobal: false };

  const user = (req as AuthRequest).user!;
  const own = (user.org_id as string | undefined) ?? null;
  const pinned = isUUID(user.client_id);

  if (!pinned && !own && !isPlatformOperator(user)) throw new AppError(403, 'No organisation context', 'NO_ORG');

  const header = req.headers['x-client-id'];
  const headerId = String((Array.isArray(header) ? header[0] : header) ?? '').trim();
  const queryId = isAllClientsSentinel(queryClientId) ? '' : String(queryClientId ?? '').trim();
  const picked = pinned ? null : isUUID(headerId) ? headerId : isUUID(queryId) ? queryId : null;

  if (!pinned && !picked && (isPlatformOperator(user) || (legacyTenantScope() && legacyGlobalCaller(user)))) {
    return { scopeOrgId: null, pickedClientId: null, isClientBound: false, isGlobal: true };
  }

  const s = await resolveStrictTenantScope(req, queryClientId);
  return { ...s, isGlobal: false };
}

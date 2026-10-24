// Module entitlement resolver. Single source of truth for "what can this user see?".
//
// Rules (in order of precedence):
//   1. Universal modules (modules.is_universal = true) are always enabled for any client. As of 2026-10 none are
//      flagged universal: Client Management ticks every module, so a client sees exactly what was ticked.
//   2. Per-client grants from `client_modules` (enabled = true, not expired).
//   3. Per-org grants from `org_modules` (enabled = true, not expired).
//   4. super_admin gets every module.
//   5. Non-super platform users (no client_id) get every module EXCEPT the paid
//      Distribution / Supply-Chain SKU, which stays deny-by-default and is only
//      unlocked by an explicit org_modules grant. (Client-bound users already
//      get it via rule 2 when their client owns the SKU.)
//
// Returns both the enabled module IDs AND the enabled package SKUs (derived from
// the modules' `package` column) so clients can render package-aware UI.

import { supabaseAdmin } from './supabase';
import { logger } from './logger';
import { currentProjectKey } from './projects';

/**
 * Projects whose clients see exactly what Client Management ticked (the strict model). The Tata project (`default`) is
 * deliberately not in the default list: its database still carries the old always-on modules, so it keeps today's
 * behaviour until its data is migrated and `default` is added here. Env MODULE_STRICT_PROJECTS overrides (comma list).
 */
export function strictProjects(): Set<string> {
  const raw = process.env.MODULE_STRICT_PROJECTS;
  const list = raw === undefined ? 'kinematic' : raw;
  return new Set(list.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
}
const strictHere = (): boolean => strictProjects().has(String(currentProjectKey()).toLowerCase());

export type Entitlements = {
  enabled_modules: string[];
  enabled_packages: string[];
  /**
   * True when `enabled_modules` is the COMPLETE list of what this user's client was given (a client-bound user whose
   * lookup succeeded). Then an empty list means "nothing", not "unknown": every gate (backend, dashboard, apps) denies
   * what is not in the list. False for platform users (who see everything) and when the lookup failed (fail open, so a
   * database hiccup never locks anyone out).
   */
  strict?: boolean;
};

const EMPTY: Entitlements = { enabled_modules: [], enabled_packages: [] };

// The paid Distribution / Supply-Chain SKU. It is NEVER auto-granted to a
// non-super platform user (no client_id); it must be explicitly granted, per
// client (client_modules) or per org (org_modules). Keep in sync with the
// dashboard's SELLABLE_PACKAGES + the modules.package column.
const PAID_DISTRIBUTION_PACKAGE = 'distribution';

// Add-on packages that are explicitly granted, never implied. Finance (billing
// data) follows the same rule as Distribution: a non-super platform user with no
// client_id does NOT get it just for being a platform user.
const EXPLICIT_GRANT_PACKAGES = [PAID_DISTRIBUTION_PACKAGE, 'finance'];

// Cache: clientId → entitlements. Invalidate via clearEntitlementCache().
// Short TTL since entitlement changes are rare and immediate visibility matters.
const ENTITLEMENT_CACHE_TTL_MS = 60 * 1000;
type CacheEntry = { value: Entitlements; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export function clearEntitlementCache(clientId?: string) {
  if (clientId) cache.delete(clientId);
  else cache.clear();
}

type ModuleRow = { id: string; package: string | null };

async function fetchAllModuleRows(): Promise<ModuleRow[]> {
  const { data, error } = await supabaseAdmin
    .from('modules')
    .select('id, package');
  if (error || !data) return [];
  return data as ModuleRow[];
}

function entitlementsFromRows(rows: ModuleRow[]): Entitlements {
  return {
    enabled_modules: rows.map(m => m.id),
    enabled_packages: Array.from(new Set(rows.map(m => m.package).filter(Boolean) as string[])),
  };
}

// True only when the org has at least one live (enabled, unexpired) org-level
// grant for a Distribution module — the only way a no-client platform user can
// legitimately unlock the paid SCM SKU.
async function orgGrantsDistribution(orgId: string | null | undefined, distIds: string[]): Promise<boolean> {
  if (!orgId || distIds.length === 0) return false;
  const { data, error } = await supabaseAdmin
    .from('org_modules')
    .select('module_id, expires_at')
    .eq('org_id', orgId)
    .eq('enabled', true)
    .in('module_id', distIds);
  if (error || !data) return false;
  const now = Date.now();
  return data.some(r => !r.expires_at || new Date(r.expires_at as string).getTime() > now);
}

/**
 * The modules a client was explicitly granted (client_modules: enabled and not expired) — NOT the always-on
 * universal ones. This is the set the Clients page assigns, and what a new user under the client should
 * start with (see modulePermissionsForNewUser). Any failure returns [] so the caller falls back to its
 * previous behaviour instead of blocking user creation.
 */
export async function clientGrantedModuleIds(clientId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('client_modules')
    .select('module_id, expires_at')
    .eq('client_id', clientId)
    .eq('enabled', true);
  if (error || !data) return [];
  const now = Date.now();
  return data
    .filter((r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now)
    .map((r) => r.module_id as string);
}

/**
 * Resolve entitlements for a given user.
 *
 * @param opts.role         User's role (super_admin bypass)
 * @param opts.clientId     User's client_id (null/undefined = platform user)
 * @param opts.orgId        User's org_id (used for org_modules grants)
 */
export async function resolveEntitlements(opts: {
  role?: string | null;
  clientId?: string | null;
  orgId?: string | null;
}): Promise<Entitlements> {
  const role = opts.role?.toLowerCase();

  // Super-admin and platform-level users (no client_id) see (almost) everything.
  if (role === 'super_admin' || !opts.clientId) {
    const rows = await fetchAllModuleRows();
    const all = entitlementsFromRows(rows);

    // The true platform operator sees literally every module.
    if (role === 'super_admin') return all;

    // A non-super platform user (no client_id) is NOT auto-granted the paid
    // Distribution / Supply-Chain SKU — it must be explicitly granted to their
    // ORG (client grants can't apply: they have no client). Everything else
    // keeps the legacy "platform user sees all" behaviour so no existing tenant
    // is locked out of non-SCM modules. This is what stops SCM/Distribution
    // leaking into the nav by default.
    const hidden = new Set<string>();
    const hiddenPackages = new Set<string>();
    for (const pkg of EXPLICIT_GRANT_PACKAGES) {
      const ids = rows.filter(r => r.package === pkg).map(r => r.id);
      if (ids.length === 0) continue;
      if (await orgGrantsDistribution(opts.orgId, ids)) continue;
      ids.forEach(id => hidden.add(id));
      hiddenPackages.add(pkg);
    }
    if (hidden.size === 0) return all;
    return {
      enabled_modules: all.enabled_modules.filter(id => !hidden.has(id)),
      enabled_packages: all.enabled_packages.filter(p => !hiddenPackages.has(p)),
    };
  }

  const cacheKey = opts.clientId;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  try {
    // Use the view that already merges universal + client_grant + org_grant
    // and excludes expired grants.
    const { data, error } = await supabaseAdmin
      .from('v_client_enabled_modules')
      .select('module_id, package')
      .eq('client_id', opts.clientId);

    if (error) {
      logger.warn(`[Entitlements] view query failed for client ${opts.clientId}: ${error.message}`);
      // Safety fallback: don't lock out. Return universal modules only.
      const { data: uni } = await supabaseAdmin
        .from('modules')
        .select('id, package')
        .eq('is_universal', true);
      const fallback: Entitlements = {
        enabled_modules: uni?.map(m => m.id) || [],
        enabled_packages: Array.from(new Set((uni || []).map(m => m.package).filter(Boolean) as string[])),
        strict: false, // the real list is unknown: do not treat this one as complete
      };
      cache.set(cacheKey, { value: fallback, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
      return fallback;
    }

    const result: Entitlements = {
      enabled_modules: (data || []).map(r => r.module_id),
      enabled_packages: Array.from(new Set((data || []).map(r => r.package).filter(Boolean) as string[])),
      strict: strictHere(),
    };
    cache.set(cacheKey, { value: result, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
    return result;
  } catch (e: any) {
    logger.error(`[Entitlements] resolve exception for client ${opts.clientId}: ${e.message}`);
    return EMPTY;
  }
}

// Module entitlement resolver. Single source of truth for "what can this user see?".
//
// Rules (in order of precedence):
//   1. Universal modules (modules.is_universal = true) are always enabled for any client.
//   2. Per-client grants from `client_modules` (enabled = true, not expired).
//   3. Per-org grants from `org_modules` (enabled = true, not expired).
//   4. super_admin and users with no client_id (platform users) get every module.
//
// Returns both the enabled module IDs AND the enabled package SKUs (derived from
// the modules' `package` column) so clients can render package-aware UI.

import { supabaseAdmin } from './supabase';
import { logger } from './logger';

export type Entitlements = {
  enabled_modules: string[];
  enabled_packages: string[];
};

const EMPTY: Entitlements = { enabled_modules: [], enabled_packages: [] };

// Cache: clientId → entitlements. Invalidate via clearEntitlementCache().
// Short TTL since entitlement changes are rare and immediate visibility matters.
const ENTITLEMENT_CACHE_TTL_MS = 60 * 1000;
type CacheEntry = { value: Entitlements; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export function clearEntitlementCache(clientId?: string) {
  if (clientId) cache.delete(clientId);
  else cache.clear();
}

async function fetchAllModules(): Promise<Entitlements> {
  const { data, error } = await supabaseAdmin
    .from('modules')
    .select('id, package');
  if (error || !data) return EMPTY;
  return {
    enabled_modules: data.map(m => m.id),
    enabled_packages: Array.from(new Set(data.map(m => m.package).filter(Boolean) as string[])),
  };
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

  // Super-admin and platform-level users (no client_id) see everything.
  if (role === 'super_admin' || !opts.clientId) {
    return fetchAllModules();
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
      };
      cache.set(cacheKey, { value: fallback, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
      return fallback;
    }

    const result: Entitlements = {
      enabled_modules: (data || []).map(r => r.module_id),
      enabled_packages: Array.from(new Set((data || []).map(r => r.package).filter(Boolean) as string[])),
    };
    cache.set(cacheKey, { value: result, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
    return result;
  } catch (e: any) {
    logger.error(`[Entitlements] resolve exception for client ${opts.clientId}: ${e.message}`);
    return EMPTY;
  }
}

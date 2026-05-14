// Per-client SKU entitlements derived from the `client_module_access` table.
// Mobile clients (iOS/Android) gate UI by:
//   - `enabled_modules`: granular module IDs the client has bought (crm,
//     attendance, orders, ...)
//   - `enabled_packages`: the three high-level SKU bundles the apps care
//     about (`crm`, `field_force`, `distribution`)
//
// Both `/auth/login` and `/auth/me` echo these fields so the apps don't
// fall back to the "legacy session = full access" path that shows every
// tab when the arrays are empty.

import { supabaseAdmin } from '../lib/supabase';

// Module IDs that imply each high-level package. Conservative — only flips
// the package on when the client actually has at least one constituent
// module enabled. Keep in sync with the iOS `User.hasFieldForce` /
// `hasCrm` / `hasDistribution` helpers in KinematicApp.swift.
const PACKAGE_MODULES: Record<string, string[]> = {
  field_force: [
    'attendance', 'live_tracking', 'form_builder', 'visit_logs',
    'zones', 'work_activities', 'broadcast', 'grievances',
  ],
  crm: ['crm'],
  distribution: ['orders', 'inventory', 'stores', 'skus', 'assets'],
};

export interface ClientEntitlements {
  enabled_modules: string[];
  enabled_packages: string[];
}

/** Look up the per-client SKU grant. `null` client_id (super_admin /
 *  org-wide user) returns empty arrays — callers should treat that as
 *  "no client scope" rather than legacy. */
export async function getEntitlementsForClient(
  client_id: string | null | undefined,
): Promise<ClientEntitlements> {
  if (!client_id) return { enabled_modules: [], enabled_packages: [] };

  const { data, error } = await supabaseAdmin
    .from('client_module_access')
    .select('module_id, enabled')
    .eq('client_id', client_id);

  if (error || !data) return { enabled_modules: [], enabled_packages: [] };

  const enabled_modules = data
    .filter(r => r.enabled !== false)
    .map(r => r.module_id as string);

  const set = new Set(enabled_modules);
  const enabled_packages = Object.entries(PACKAGE_MODULES)
    .filter(([, mods]) => mods.some(m => set.has(m)))
    .map(([pkg]) => pkg);

  return { enabled_modules, enabled_packages };
}

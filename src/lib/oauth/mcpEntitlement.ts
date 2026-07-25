// AI-assistant (MCP connector) entitlement — the connector is a paid add-on.
//
// Source of truth is the central `mcp_connector_orgs` table (in the OAuth/default
// project), managed from the dashboard by super-admins. An org may use the
// connector only if it has a row with enabled=true. OFF for everyone by default;
// the Kinematic parent org is seeded ON.
//
// Enforced in TWO places:
//   - POST /oauth/authorize — a non-entitled tenant can't obtain a token.
//   - requireOAuth (the MCP tool layer) — defense-in-depth for tokens already
//     issued, or whose org was disabled after issuance.

import { adminClientFor } from '../projects';
import { logger } from '../logger';

// OAuth tables (incl. this one) live in the default project — reached directly,
// never via the ALS-bound proxy, so lookups are project-independent.
const OAUTH_PROJECT = 'default';

// The product's home tenant. Used only as a safety fallback if the table can't
// be read, so the parent is never accidentally locked out.
const KINEMATIC_PARENT_ORG_ID = '11111111-1111-4111-8111-111111111111';

const CACHE_TTL_MS = 60 * 1000; // entitlement changes are rare; short TTL is fine

// Shown on the consent page when a non-entitled user tries to connect.
export const MCP_DISABLED_MESSAGE =
  'AI assistant access is not enabled for your account. Please contact your administrator to enable it.';

export interface ConnectorOrg {
  org_id: string;
  project_key: string | null;
  label: string | null;
  enabled: boolean;
  updated_at?: string | null;
}

function db() { return adminClientFor(OAUTH_PROJECT); }

// Cache: orgId → enabled. Whole-table snapshot refreshed on TTL; cleared on write.
let cache: { at: number; map: Map<string, boolean> } | null = null;

export function clearMcpEntitlementCache() { cache = null; }

async function enabledMap(): Promise<Map<string, boolean>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const map = new Map<string, boolean>();
  try {
    const { data, error } = await db().from('mcp_connector_orgs').select('org_id, enabled');
    if (error) throw new Error(error.message);
    for (const r of (data || []) as { org_id: string; enabled: boolean }[]) map.set(r.org_id, !!r.enabled);
  } catch (e: any) {
    logger.warn(`[mcp-entitlement] load failed: ${e?.message || e}`);
    // Safety net: never lock out the Kinematic parent if the table is unreachable.
    map.set(KINEMATIC_PARENT_ORG_ID, true);
  }
  cache = { at: Date.now(), map };
  return map;
}

/** Whether this org may use the AI assistant / MCP connector. Off unless enabled. */
export async function isMcpConnectorEnabled(orgId?: string | null): Promise<boolean> {
  if (!orgId) return false;
  return (await enabledMap()).get(orgId) === true;
}

// ── Admin management (super-admin dashboard) ─────────────────────────────────

export async function listConnectorOrgs(): Promise<ConnectorOrg[]> {
  const { data, error } = await db().from('mcp_connector_orgs')
    .select('org_id, project_key, label, enabled, updated_at')
    .order('enabled', { ascending: false })
    .order('label', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as ConnectorOrg[];
}

export async function upsertConnectorOrg(input: {
  org_id: string;
  enabled: boolean;
  project_key?: string | null;
  label?: string | null;
  updated_by?: string | null;
}): Promise<ConnectorOrg> {
  const row: Record<string, unknown> = {
    org_id: input.org_id,
    enabled: input.enabled,
    updated_by: input.updated_by ?? null,
    updated_at: new Date().toISOString(),
  };
  // Only overwrite label / project_key when provided, so a plain toggle keeps them.
  if (input.project_key !== undefined) row.project_key = input.project_key;
  if (input.label !== undefined) row.label = input.label;

  const { data, error } = await db().from('mcp_connector_orgs')
    .upsert(row, { onConflict: 'org_id' })
    .select('org_id, project_key, label, enabled, updated_at')
    .maybeSingle();
  if (error) throw new Error(error.message);
  clearMcpEntitlementCache();
  return data as ConnectorOrg;
}

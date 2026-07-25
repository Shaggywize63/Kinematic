// AI-assistant (MCP connector) entitlement — the connector is a paid add-on.
//
// Default: OFF for every tenant. ON only for:
//   1. the Kinematic parent org (the product's home tenant), and
//   2. any org_id listed in MCP_CONNECTOR_ORG_IDS (comma-separated) — that's how
//      you enable / charge an individual client without a code change, and
//   3. platform super-admins (internal staff), who are never locked out.
//
// Enforced in TWO places (see usages):
//   - POST /oauth/authorize — a non-entitled tenant can't even obtain a token.
//   - requireOAuth (the MCP tool layer) — defense-in-depth for tokens that were
//     already issued, or whose org later loses entitlement.

// The Kinematic parent org — always entitled. (Matches the platform tenant that
// owns the product; other tenants live in their own orgs/projects.)
const KINEMATIC_PARENT_ORG_ID = '11111111-1111-4111-8111-111111111111';

// Shown on the consent page when a non-entitled user tries to connect.
export const MCP_DISABLED_MESSAGE =
  'AI assistant access is not enabled for your account. Please contact your administrator to enable it.';

/** Org ids permitted to use the connector: the Kinematic parent + env additions. */
function entitledOrgIds(): Set<string> {
  const extra = (process.env.MCP_CONNECTOR_ORG_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return new Set<string>([KINEMATIC_PARENT_ORG_ID, ...extra]);
}

/** Whether this user's org may use the AI assistant / MCP connector. */
export function isMcpConnectorEnabled(opts: { role?: string | null; orgId?: string | null }): boolean {
  if ((opts.role || '').toLowerCase() === 'super_admin') return true;   // internal/platform staff
  return !!opts.orgId && entitledOrgIds().has(opts.orgId);
}

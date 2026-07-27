// Super-admin management of the WhatsApp Campaigns entitlement (paid add-on).
// Backs the dashboard "WhatsApp Campaigns Access" settings page. Reads/writes the
// central `broadcast_orgs` table via the entitlement lib (default project).

import { asyncHandler } from '../utils';
import { AuthRequest } from '../types';
import { ok, badRequest } from '../utils/response';
import { listBroadcastOrgs, upsertBroadcastOrg } from '../lib/broadcastEntitlement';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/v1/admin/broadcast-entitlement — list every org's campaigns entitlement.
export const listBroadcastEntitlement = asyncHandler<AuthRequest>(async (_req, res) => {
  return ok(res, await listBroadcastOrgs());
});

// PUT /api/v1/admin/broadcast-entitlement/:orgId — enable/disable (upsert) one org.
export const setBroadcastEntitlement = asyncHandler<AuthRequest>(async (req, res) => {
  const orgId = String(req.params.orgId || '');
  if (!UUID_RE.test(orgId)) return badRequest(res, 'A valid org id is required');

  const b = (req.body || {}) as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return badRequest(res, 'enabled (boolean) is required');

  const row = await upsertBroadcastOrg({
    org_id: orgId,
    enabled: b.enabled,
    project_key: typeof b.project_key === 'string' ? b.project_key : undefined,
    label: typeof b.label === 'string' ? b.label : undefined,
    updated_by: req.user?.id ?? null,
  });
  return ok(res, row, b.enabled ? 'WhatsApp Campaigns enabled' : 'WhatsApp Campaigns disabled');
});

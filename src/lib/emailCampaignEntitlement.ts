// Email Campaigns entitlement — bulk email is a paid per-client add-on, exactly
// like WhatsApp Broadcasts.
//
// Source of truth is the central `email_campaign_orgs` table (in the default
// project, alongside the other control-plane entitlements), managed from the
// dashboard by super-admins. An org may run email campaigns only if it has a row
// with enabled=true. OFF for everyone by default; the Kinematic parent org is
// seeded ON.
//
// Enforced on the /crm/email-campaigns mutation routes (create / launch / pause /
// resume / cancel / process). Reads stay open so an admin can see the feature and
// be upsold.

import { adminClientFor } from './projects';
import { logger } from './logger';

// Control-plane tables live in the default project — reached directly, never via
// the ALS-bound proxy, so lookups are project-independent.
const CONTROL_PROJECT = 'default';

// The product's home tenant. Safety fallback if the table can't be read, so the
// parent is never accidentally locked out.
const KINEMATIC_PARENT_ORG_ID = '11111111-1111-4111-8111-111111111111';

const CACHE_TTL_MS = 60 * 1000;

export const EMAIL_CAMPAIGN_DISABLED_MESSAGE =
  'Email Campaigns are not enabled for your account. Please contact your administrator to enable this add-on.';

export interface EmailCampaignOrg {
  org_id: string;
  project_key: string | null;
  label: string | null;
  enabled: boolean;
  updated_at?: string | null;
}

function db() { return adminClientFor(CONTROL_PROJECT); }

let cache: { at: number; map: Map<string, boolean> } | null = null;
export function clearEmailCampaignEntitlementCache() { cache = null; }

async function enabledMap(): Promise<Map<string, boolean>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const map = new Map<string, boolean>();
  try {
    const { data, error } = await db().from('email_campaign_orgs').select('org_id, enabled');
    if (error) throw new Error(error.message);
    for (const r of (data || []) as { org_id: string; enabled: boolean }[]) map.set(r.org_id, !!r.enabled);
  } catch (e: any) {
    logger.warn(`[email-campaign-entitlement] load failed: ${e?.message || e}`);
    map.set(KINEMATIC_PARENT_ORG_ID, true); // never lock out the parent if unreachable
  }
  cache = { at: Date.now(), map };
  return map;
}

/** Whether this org may run email campaigns. Off unless explicitly enabled. */
export async function isEmailCampaignEnabled(orgId?: string | null): Promise<boolean> {
  if (!orgId) return false;
  return (await enabledMap()).get(orgId) === true;
}

// ── Admin management (super-admin dashboard) ─────────────────────────────────
export async function listEmailCampaignOrgs(): Promise<EmailCampaignOrg[]> {
  const { data, error } = await db().from('email_campaign_orgs')
    .select('org_id, project_key, label, enabled, updated_at')
    .order('enabled', { ascending: false })
    .order('label', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as EmailCampaignOrg[];
}

export async function upsertEmailCampaignOrg(input: {
  org_id: string;
  enabled: boolean;
  project_key?: string | null;
  label?: string | null;
  updated_by?: string | null;
}): Promise<EmailCampaignOrg> {
  const row: Record<string, unknown> = {
    org_id: input.org_id,
    enabled: input.enabled,
    updated_by: input.updated_by ?? null,
    updated_at: new Date().toISOString(),
  };
  if (input.project_key !== undefined) row.project_key = input.project_key;
  if (input.label !== undefined) row.label = input.label;

  const { data, error } = await db().from('email_campaign_orgs')
    .upsert(row, { onConflict: 'org_id' })
    .select('org_id, project_key, label, enabled, updated_at')
    .maybeSingle();
  if (error) throw new Error(error.message);
  clearEmailCampaignEntitlementCache();
  return data as EmailCampaignOrg;
}

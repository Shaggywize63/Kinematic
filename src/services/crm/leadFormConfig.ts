/**
 * Reads a client's `crm_settings.config` (and its `lead_form` (the Dealer / Farmers lead-type labels and the
 * other per-client lead-form switches; validated on write by `leadFormConfigSchema`).
 *
 * Row resolution mirrors GET /crm/settings (`loadSettingsRow` in crm.routes.ts) so the server sees
 * exactly what the apps and the web dashboard see: the client's own row first, else the org-level
 * default row (client_id IS NULL).
 */
import { supabaseAdmin } from '../../lib/supabase';

export type LeadFormConfig = Record<string, unknown>;

async function configRow(org_id: string, client_id: string | null): Promise<Record<string, unknown> | null> {
  let q = supabaseAdmin.from('crm_settings').select('config').eq('org_id', org_id);
  q = client_id ? q.eq('client_id', client_id) : q.is('client_id', null);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(error.message);
  const row = (data as Array<{ config?: unknown }> | null)?.[0];
  return row && row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : null;
}

/**
 * The effective `crm_settings.config` for this scope — the client's own row, else the org-level default
 * row — or null when neither exists. Shared by every per-client opt-in that lives in that object
 * (`lead_form`, `targets`), so they all see exactly what GET /crm/settings serves.
 */
export async function loadCrmConfig(org_id: string, client_id: string | null): Promise<Record<string, unknown> | null> {
  const own = client_id ? await configRow(org_id, client_id) : null;
  return own ?? await configRow(org_id, null);
}

/** The effective `config.lead_form` object for this scope, or null when none is configured. */
export async function loadLeadFormConfig(org_id: string, client_id: string | null): Promise<LeadFormConfig | null> {
  const cfg = await loadCrmConfig(org_id, client_id);
  const lf = cfg?.lead_form;
  return lf && typeof lf === 'object' && !Array.isArray(lf) ? (lf as LeadFormConfig) : null;
}

/** Has the client named its lead types (e.g. "Dealer" / "Farmers")? At least one non-blank label. */
export function hasSegmentLabels(leadForm: LeadFormConfig | null | undefined): boolean {
  const labels = leadForm?.segment_labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return false;
  return (['b2b', 'b2c'] as const).some((k) => {
    const v = (labels as Record<string, unknown>)[k];
    return typeof v === 'string' && v.trim() !== '';
  });
}

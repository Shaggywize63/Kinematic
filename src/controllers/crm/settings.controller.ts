import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, clientId } from '../../utils';

// crm_settings has a NATURAL KEY of (org_id, client_id): an org can hold several
// rows — one org-level row (client_id null) plus one per client. A bare
// `.single()` on org_id alone therefore 406s ("multiple rows") for any org that
// has more than one row, which is exactly what silently broke field_overrides /
// hidden-field loading after the multi-project migration. Resolve the row the
// request is scoped to (X-Client-Id → req.user.client_id), preferring the
// client-specific row and falling back to the org-level (client_id null) row.
type SettingsRow = { id?: string; org_id?: string; client_id?: string | null; business_type?: string; config?: Record<string, unknown> };

async function fetchSettingsRow(org_id: string, client_id: string | null): Promise<SettingsRow | null> {
  let q = supabaseAdmin.from('crm_settings').select('*').eq('org_id', org_id);
  q = client_id ? q.eq('client_id', client_id) : q.is('client_id', null);
  const { data } = await q.order('created_at', { ascending: true }).limit(1).maybeSingle();
  return (data as SettingsRow | null) ?? null;
}

/** The effective settings row for this request: client-specific first, else org-level. */
async function resolveSettingsRow(org_id: string, client_id: string | null): Promise<SettingsRow | null> {
  const scoped = client_id ? await fetchSettingsRow(org_id, client_id) : null;
  return scoped ?? await fetchSettingsRow(org_id, null);
}

export const getSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const client_id = clientId(req);

  const row = await resolveSettingsRow(org_id, client_id);
  if (row) return ok(res, row);

  // Nothing yet — create the org-level base row (client_id null) so subsequent
  // reads/writes have something to hang off. Guarded against a race: if a
  // concurrent request created it, re-read instead of surfacing the conflict.
  const { data: created, error: ce } = await supabaseAdmin
    .from('crm_settings')
    .insert({ org_id, client_id: null, business_type: 'both', config: {} })
    .select()
    .single();
  if (ce) {
    const retry = await fetchSettingsRow(org_id, null);
    if (retry) return ok(res, retry);
    return badRequest(res, ce.message);
  }
  return ok(res, created);
});

export const updateSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const client_id = clientId(req);
  const { business_type, config } = req.body;

  // Write to the row this request is scoped to (client-specific if a client is
  // selected, else the org-level row). Explicit update-by-id or insert — NOT a
  // blind upsert — because (org_id, null) is not reliably a conflict target
  // (NULLs compare distinct), so an upsert would keep inserting duplicate
  // org-level rows and re-create the very multi-row mess this fix resolves.
  const existing = await fetchSettingsRow(org_id, client_id);
  const mergedConfig = config !== undefined
    ? { ...((existing?.config as Record<string, unknown>) || {}), ...config }
    : undefined;

  if (existing?.id) {
    const patch: Record<string, unknown> = {};
    if (business_type !== undefined) patch.business_type = business_type;
    if (mergedConfig !== undefined) patch.config = mergedConfig;
    const { data, error } = await supabaseAdmin
      .from('crm_settings')
      .update(patch)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }

  const { data, error } = await supabaseAdmin
    .from('crm_settings')
    .insert({
      org_id,
      client_id: client_id ?? null,
      business_type: business_type ?? 'both',
      config: mergedConfig ?? {},
    })
    .select()
    .single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const seedDefaults = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;

  // Create default pipeline with stages
  const { data: existing } = await supabaseAdmin
    .from('crm_pipelines')
    .select('id')
    .eq('org_id', org_id)
    .eq('is_default', true)
    .single();

  if (existing) return ok(res, { seeded: 0, message: 'Already seeded' });

  const { data: pipeline, error: pe } = await supabaseAdmin
    .from('crm_pipelines')
    .insert({ org_id, name: 'Default Pipeline', is_default: true, created_by: userId })
    .select()
    .single();
  if (pe) return badRequest(res, pe.message);

  const defaultStages = [
    { name: 'New', position: 0, stage_type: 'open', probability: 10, color: '#6b7280' },
    { name: 'Contacted', position: 1, stage_type: 'open', probability: 25, color: '#3b82f6' },
    { name: 'Qualified', position: 2, stage_type: 'open', probability: 50, color: '#8b5cf6' },
    { name: 'Proposal', position: 3, stage_type: 'open', probability: 70, color: '#f59e0b' },
    { name: 'Negotiation', position: 4, stage_type: 'open', probability: 85, color: '#ef4444' },
    { name: 'Won', position: 5, stage_type: 'won', probability: 100, color: '#10b981' },
    { name: 'Lost', position: 6, stage_type: 'lost', probability: 0, color: '#9ca3af' },
  ];

  await supabaseAdmin.from('crm_deal_stages').insert(
    defaultStages.map((s) => ({ ...s, org_id, pipeline_id: pipeline.id }))
  );

  // Default lead sources
  const defaultSources = ['Website', 'Referral', 'Cold Call', 'Social Media', 'Event', 'Email Campaign', 'Other'];
  await supabaseAdmin.from('crm_lead_sources').upsert(
    defaultSources.map((name) => ({ org_id, name, is_active: true })),
    { onConflict: 'org_id,name' }
  );

  return ok(res, { seeded: 1 });
});

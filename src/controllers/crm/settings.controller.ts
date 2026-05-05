import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest } from '../../utils';

export const getSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  let { data, error } = await supabaseAdmin
    .from('crm_settings')
    .select('*')
    .eq('org_id', org_id)
    .single();
  if (error && error.code === 'PGRST116') {
    // Auto-create default settings row
    const { data: created, error: ce } = await supabaseAdmin
      .from('crm_settings')
      .insert({ org_id, business_type: 'both', config: {} })
      .select()
      .single();
    if (ce) return badRequest(res, ce.message);
    return ok(res, created);
  }
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const updateSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { business_type, config } = req.body;

  // Upsert — create row if missing, then merge config
  const { data: existing } = await supabaseAdmin
    .from('crm_settings')
    .select('config')
    .eq('org_id', org_id)
    .single();

  const mergedConfig = config
    ? { ...(existing?.config || {}), ...config }
    : undefined;

  const updates: Record<string, unknown> = {};
  if (business_type !== undefined) updates.business_type = business_type;
  if (mergedConfig !== undefined) updates.config = mergedConfig;

  const { data, error } = await supabaseAdmin
    .from('crm_settings')
    .upsert({ org_id, ...updates })
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

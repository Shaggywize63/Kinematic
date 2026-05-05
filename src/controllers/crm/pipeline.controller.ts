import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';

// ── Pipelines ────────────────────────────────────────────────

export const listPipelines = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_pipelines')
    .select('*, stages:crm_deal_stages(*)')
    .eq('org_id', org_id)
    .order('created_at');
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createPipeline = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { name, is_default = false } = req.body;
  if (!name?.trim()) return badRequest(res, 'name is required');

  if (is_default) {
    await supabaseAdmin
      .from('crm_pipelines')
      .update({ is_default: false })
      .eq('org_id', org_id);
  }

  const { data, error } = await supabaseAdmin
    .from('crm_pipelines')
    .insert({ org_id, name: name.trim(), is_default, created_by: userId })
    .select('*, stages:crm_deal_stages(*)')
    .single();
  if (error) return badRequest(res, error.message);
  return created(res, data);
});

export const getPipeline = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_pipelines')
    .select('*, stages:crm_deal_stages(*)')
    .eq('id', req.params.id)
    .eq('org_id', org_id)
    .single();
  if (error || !data) return notFound(res, 'Pipeline not found');
  return ok(res, data);
});

export const updatePipeline = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { name, is_default, is_active } = req.body;

  if (is_default) {
    await supabaseAdmin
      .from('crm_pipelines')
      .update({ is_default: false })
      .eq('org_id', org_id);
  }

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (is_default !== undefined) updates.is_default = is_default;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabaseAdmin
    .from('crm_pipelines')
    .update(updates)
    .eq('id', req.params.id)
    .eq('org_id', org_id)
    .select('*, stages:crm_deal_stages(*)')
    .single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deletePipeline = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data: p } = await supabaseAdmin
    .from('crm_pipelines').select('is_default').eq('id', req.params.id).eq('org_id', org_id).single();
  if (p?.is_default) return badRequest(res, 'Cannot delete the default pipeline');
  const { error } = await supabaseAdmin
    .from('crm_pipelines').delete().eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

// ── Stages ───────────────────────────────────────────────────

export const listStages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const q = supabaseAdmin.from('crm_deal_stages').select('*').eq('org_id', org_id);
  if (req.query.pipeline_id) q.eq('pipeline_id', req.query.pipeline_id as string);
  const { data, error } = await q.order('position');
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createStage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { pipeline_id, name, position = 0, stage_type = 'open', probability = 0, color } = req.body;
  if (!pipeline_id || !name?.trim()) return badRequest(res, 'pipeline_id and name are required');
  const { data, error } = await supabaseAdmin
    .from('crm_deal_stages')
    .insert({ org_id, pipeline_id, name: name.trim(), position, stage_type, probability, color })
    .select().single();
  if (error) return badRequest(res, error.message);
  return created(res, data);
});

export const getStage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_deal_stages').select('*').eq('id', req.params.id).eq('org_id', org_id).single();
  if (error || !data) return notFound(res, 'Stage not found');
  return ok(res, data);
});

export const updateStage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { name, position, stage_type, probability, color } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (position !== undefined) updates.position = position;
  if (stage_type !== undefined) updates.stage_type = stage_type;
  if (probability !== undefined) updates.probability = probability;
  if (color !== undefined) updates.color = color;
  const { data, error } = await supabaseAdmin
    .from('crm_deal_stages').update(updates).eq('id', req.params.id).eq('org_id', org_id).select().single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteStage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin
    .from('crm_deal_stages').delete().eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';

export const listDeals = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { status, pipeline_id, stage_id, owner_id, limit = '100', page = '1' } = req.query as Record<string, string>;
  let q = supabaseAdmin.from('crm_deals')
    .select('*, stage:crm_deal_stages(id,name,stage_type,position,color,probability), account:crm_accounts(id,name)', { count: 'exact' })
    .eq('org_id', org_id).is('deleted_at', null);
  if (status) q = q.eq('status', status);
  if (pipeline_id) q = q.eq('pipeline_id', pipeline_id);
  if (stage_id) q = q.eq('stage_id', stage_id);
  if (owner_id) q = q.eq('owner_id', owner_id);
  const lim = Math.min(500, parseInt(limit) || 100);
  const pg = Math.max(1, parseInt(page) || 1);
  q = q.range((pg - 1) * lim, pg * lim - 1).order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createDeal = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const body = { ...req.body, org_id, created_by: userId, status: req.body.status || 'open' };
  delete body.id; delete body.created_at; delete body.deleted_at;

  // Auto-assign first stage of pipeline if none given
  if (body.pipeline_id && !body.stage_id) {
    const { data: firstStage } = await supabaseAdmin
      .from('crm_deal_stages').select('id').eq('pipeline_id', body.pipeline_id)
      .eq('stage_type', 'open').order('position').limit(1).single();
    if (firstStage) body.stage_id = firstStage.id;
  }

  const { data, error } = await supabaseAdmin.from('crm_deals').insert(body)
    .select('*, stage:crm_deal_stages(id,name,stage_type,position,color,probability), account:crm_accounts(id,name)').single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Deal created');
});

export const getDeal = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deals')
    .select('*, stage:crm_deal_stages(*), pipeline:crm_pipelines(id,name), account:crm_accounts(*), contact:crm_contacts(id,first_name,last_name,email,phone)')
    .eq('id', req.params.id).eq('org_id', org_id).is('deleted_at', null).single();
  if (error || !data) return notFound(res, 'Deal not found');
  return ok(res, data);
});

export const updateDeal = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const updates = { ...req.body, updated_by: userId };
  delete updates.org_id; delete updates.id; delete updates.created_at;
  const { data, error } = await supabaseAdmin.from('crm_deals')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id).is('deleted_at', null)
    .select('*, stage:crm_deal_stages(*)').single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteDeal = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_deals')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

export const moveStage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { stage_id, reason } = req.body;
  if (!stage_id) return badRequest(res, 'stage_id is required');

  // Both lookups are independent of each other — fetch in parallel.
  const [dealRes, stageRes] = await Promise.all([
    supabaseAdmin.from('crm_deals').select('stage_id,amount,probability')
      .eq('id', req.params.id).eq('org_id', org_id).single(),
    supabaseAdmin.from('crm_deal_stages').select('probability').eq('id', stage_id).single(),
  ]);
  const deal = dealRes.data;
  const stage = stageRes.data;
  if (!deal) return notFound(res, 'Deal not found');

  const { data, error } = await supabaseAdmin.from('crm_deals')
    .update({ stage_id, probability: stage?.probability ?? (deal as any).probability, updated_by: userId })
    .eq('id', req.params.id).eq('org_id', org_id).select('*, stage:crm_deal_stages(*)').single();
  if (error) return badRequest(res, error.message);

  await supabaseAdmin.from('crm_deal_history').insert({
    org_id, deal_id: req.params.id, from_stage_id: deal.stage_id, to_stage_id: stage_id,
    changed_by: userId, reason, amount_at_change: deal.amount,
  });
  return ok(res, data);
});

export const winDeal = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { reason, close_date } = req.body;
  const [dealRes, wonStageRes] = await Promise.all([
    supabaseAdmin.from('crm_deals').select('stage_id,amount,status')
      .eq('id', req.params.id).eq('org_id', org_id).single(),
    supabaseAdmin.from('crm_deal_stages').select('id')
      .eq('org_id', org_id).eq('stage_type', 'won').limit(1).single(),
  ]);
  const deal = dealRes.data;
  const wonStage = wonStageRes.data;
  if (!deal) return notFound(res, 'Deal not found');

  const { data, error } = await supabaseAdmin.from('crm_deals').update({
    status: 'won', win_reason: reason,
    close_date: close_date || new Date().toISOString().split('T')[0],
    stage_id: wonStage?.id || deal.stage_id, probability: 100, updated_by: userId,
  }).eq('id', req.params.id).eq('org_id', org_id).select('*, stage:crm_deal_stages(*)').single();
  if (error) return badRequest(res, error.message);

  await supabaseAdmin.from('crm_deal_history').insert({
    org_id, deal_id: req.params.id, from_status: deal.status, to_status: 'won',
    from_stage_id: deal.stage_id, to_stage_id: wonStage?.id, changed_by: userId, reason,
  });
  return ok(res, data);
});

export const loseDeal = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { reason, competitor } = req.body;
  const [dealRes, lostStageRes] = await Promise.all([
    supabaseAdmin.from('crm_deals').select('stage_id,amount,status')
      .eq('id', req.params.id).eq('org_id', org_id).single(),
    supabaseAdmin.from('crm_deal_stages').select('id')
      .eq('org_id', org_id).eq('stage_type', 'lost').limit(1).single(),
  ]);
  const deal = dealRes.data;
  const lostStage = lostStageRes.data;
  if (!deal) return notFound(res, 'Deal not found');

  const { data, error } = await supabaseAdmin.from('crm_deals').update({
    status: 'lost', lost_reason: reason ? `${reason}${competitor ? ` (${competitor})` : ''}` : undefined,
    stage_id: lostStage?.id || deal.stage_id, probability: 0, updated_by: userId,
    close_date: new Date().toISOString().split('T')[0],
  }).eq('id', req.params.id).eq('org_id', org_id).select('*, stage:crm_deal_stages(*)').single();
  if (error) return badRequest(res, error.message);

  await supabaseAdmin.from('crm_deal_history').insert({
    org_id, deal_id: req.params.id, from_status: deal.status, to_status: 'lost',
    from_stage_id: deal.stage_id, to_stage_id: lostStage?.id, changed_by: userId,
    reason: reason || competitor,
  });
  return ok(res, data);
});

export const getDealHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deal_history').select('*')
    .eq('org_id', org_id).eq('deal_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getDealActivities = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', org_id).eq('deal_id', req.params.id).is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getDealContacts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deal_contacts')
    .select('*, contact:crm_contacts(id,first_name,last_name,email,phone,title)')
    .eq('org_id', org_id).eq('deal_id', req.params.id);
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getDealNotes = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_notes').select('*')
    .eq('org_id', org_id).eq('deal_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

// ── Line Items ───────────────────────────────────────────────

export const listLineItems = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items')
    .select('*, product:crm_products(id,name,code,unit_price,unit)')
    .eq('org_id', org_id).eq('deal_id', req.params.id).order('created_at');
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const addLineItem = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { product_id, name, quantity = 1, unit_price = 0, discount_pct = 0, currency = 'INR' } = req.body;
  let itemName = name;
  let itemPrice = unit_price;
  if (product_id) {
    const { data: prod } = await supabaseAdmin.from('crm_products').select('name,unit_price')
      .eq('id', product_id).single();
    if (prod) { itemName = itemName || prod.name; itemPrice = itemPrice || prod.unit_price; }
  }
  if (!itemName) return badRequest(res, 'name or product_id is required');
  const lineTotal = itemPrice * quantity * (1 - (discount_pct / 100));
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items').insert({
    org_id, deal_id: req.params.id, product_id: product_id || null,
    name: itemName, quantity, unit_price: itemPrice, discount_pct, line_total: lineTotal, currency,
  }).select('*, product:crm_products(id,name)').single();
  if (error) return badRequest(res, error.message);
  return created(res, data);
});

export const updateLineItem = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { quantity, unit_price, discount_pct, name } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (quantity !== undefined) updates.quantity = quantity;
  if (unit_price !== undefined) updates.unit_price = unit_price;
  if (discount_pct !== undefined) updates.discount_pct = discount_pct;
  if (quantity !== undefined || unit_price !== undefined || discount_pct !== undefined) {
    const { data: li } = await supabaseAdmin.from('crm_deal_line_items').select('*').eq('id', req.params.id).single();
    if (li) {
      const q = quantity ?? li.quantity;
      const up = unit_price ?? li.unit_price;
      const dp = discount_pct ?? li.discount_pct;
      updates.line_total = up * q * (1 - (dp / 100));
    }
  }
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id).select().single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const removeLineItem = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_deal_line_items')
    .delete().eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

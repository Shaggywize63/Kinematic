import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';

export const listAccounts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { owner_id, industry, limit = '100', page = '1' } = req.query as Record<string, string>;
  let q = supabaseAdmin.from('crm_accounts').select('*', { count: 'exact' })
    .eq('org_id', org_id).is('deleted_at', null);
  if (owner_id) q = q.eq('owner_id', owner_id);
  if (industry) q = q.eq('industry', industry);
  const lim = Math.min(500, parseInt(limit) || 100);
  const pg = Math.max(1, parseInt(page) || 1);
  q = q.range((pg - 1) * lim, pg * lim - 1).order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const body = { ...req.body, org_id, created_by: userId };
  delete body.id; delete body.created_at; delete body.deleted_at;
  const { data, error } = await supabaseAdmin.from('crm_accounts').insert(body).select().single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Account created');
});

export const getAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_accounts').select('*')
    .eq('id', req.params.id).eq('org_id', org_id).is('deleted_at', null).single();
  if (error || !data) return notFound(res, 'Account not found');
  return ok(res, data);
});

export const updateAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const updates = { ...req.body, updated_by: userId };
  delete updates.org_id; delete updates.id; delete updates.created_at;
  const { data, error } = await supabaseAdmin.from('crm_accounts')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id)
    .is('deleted_at', null).select().single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_accounts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

export const getAccountContacts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_contacts').select('*')
    .eq('org_id', org_id).eq('account_id', req.params.id).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getAccountDeals = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deals').select('*')
    .eq('org_id', org_id).eq('account_id', req.params.id).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getAccountActivities = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', org_id).eq('account_id', req.params.id).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getAccountNotes = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_notes').select('*')
    .eq('org_id', org_id).eq('account_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

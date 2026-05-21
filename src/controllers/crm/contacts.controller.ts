import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';
import { getEffectiveCityNames } from '../../middleware/rbac';

export const listContacts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { account_id, owner_id, city, limit = '100', page = '1' } = req.query as Record<string, string>;
  let q = supabaseAdmin.from('crm_contacts')
    .select('*, account:crm_accounts(id,name)', { count: 'exact' })
    .eq('org_id', org_id).is('deleted_at', null);
  if (account_id) q = q.eq('account_id', account_id);
  if (owner_id) q = q.eq('owner_id', owner_id);
  // City geo-tag enforcement (role ∩ user). Empty intersection → 0 rows;
  // null → no restriction. Mirrors listLeads.
  const effectiveCities = getEffectiveCityNames(req.user);
  if (effectiveCities !== null) {
    if (effectiveCities.length === 0) return ok(res, []);
    q = q.in('city', effectiveCities);
  }
  // Per-request city narrow — picker on the dashboard sends ?city=<name>;
  // intersects with the user's allowed scope above so a malicious value
  // can never escape the cap.
  if (city) q = q.eq('city', city);
  const lim = Math.min(500, parseInt(limit) || 100);
  const pg = Math.max(1, parseInt(page) || 1);
  q = q.range((pg - 1) * lim, pg * lim - 1).order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createContact = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const body = { ...req.body, org_id, created_by: userId };
  delete body.id; delete body.created_at; delete body.deleted_at;
  const { data, error } = await supabaseAdmin.from('crm_contacts').insert(body)
    .select('*, account:crm_accounts(id,name)').single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Contact created');
});

export const getContact = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_contacts')
    .select('*, account:crm_accounts(id,name)')
    .eq('id', req.params.id).eq('org_id', org_id).is('deleted_at', null).single();
  if (error || !data) return notFound(res, 'Contact not found');
  return ok(res, data);
});

export const updateContact = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const updates = { ...req.body, updated_by: userId };
  delete updates.org_id; delete updates.id; delete updates.created_at;
  const { data, error } = await supabaseAdmin.from('crm_contacts')
    .update(updates).eq('id', req.params.id).eq('org_id', org_id).is('deleted_at', null)
    .select('*, account:crm_accounts(id,name)').single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteContact = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin.from('crm_contacts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

export const getContactActivities = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', org_id).eq('contact_id', req.params.id).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getContactDeals = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deals').select('*')
    .eq('org_id', org_id).eq('contact_id', req.params.id).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getContactNotes = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_notes').select('*')
    .eq('org_id', org_id).eq('contact_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

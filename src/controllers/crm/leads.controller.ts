import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';

function computeLeadScore(lead: Record<string, unknown>, config?: Record<string, unknown>): { score: number; grade: string; breakdown: Record<string, number> } {
  const weights: Record<string, number> = {
    has_company: 8, has_title: 5, has_industry: 4, has_phone: 4, has_email: 4,
    ...(((config as any)?.scoring?.weights) || {}),
  };
  const breakdown: Record<string, number> = {};
  let score = 0;
  const add = (key: string, val: number) => { breakdown[key] = val; score += val; };
  if (lead.company) add('has_company', weights.has_company ?? 8);
  if (lead.title) add('has_title', weights.has_title ?? 5);
  if (lead.industry) add('has_industry', weights.has_industry ?? 4);
  if (lead.phone) add('has_phone', weights.has_phone ?? 4);
  if (lead.email) add('has_email', weights.has_email ?? 4);
  score = Math.max(0, Math.min(100, score));
  const thresholds = ((config as any)?.scoring?.grade_thresholds) || { A: 75, B: 55, C: 35 };
  const grade = score >= thresholds.A ? 'A' : score >= thresholds.B ? 'B' : score >= thresholds.C ? 'C' : 'D';
  return { score, grade, breakdown };
}

export const listLeads = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { status, owner_id, source_id, score_grade, is_converted, limit = '100', page = '1' } = req.query as Record<string, string>;
  let q = supabaseAdmin
    .from('crm_leads')
    .select('*, source:crm_lead_sources(id,name)', { count: 'exact' })
    .eq('org_id', org_id)
    .is('deleted_at', null);
  if (status) q = q.eq('status', status);
  if (owner_id) q = q.eq('owner_id', owner_id);
  if (source_id) q = q.eq('source_id', source_id);
  if (score_grade) q = q.eq('score_grade', score_grade);
  if (is_converted !== undefined) q = q.eq('is_converted', is_converted === 'true');
  const lim = Math.min(500, parseInt(limit) || 100);
  const pg = Math.max(1, parseInt(page) || 1);
  q = q.range((pg - 1) * lim, pg * lim - 1).order('created_at', { ascending: false });
  const { data, error, count } = await q;
  if (error) return badRequest(res, error.message);
  return ok(res, data, `${count ?? 0} leads`);
});

export const createLead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { first_name, last_name, email, phone, company, title, industry, is_b2c = true,
    status = 'new', source_id, owner_id, territory_id,
    date_of_birth, gender, address_line1, address_line2, city, state, postal_code, country,
    preferred_contact_method, marketing_consent, whatsapp_consent, custom_fields } = req.body;

  if (!first_name?.trim() && !email?.trim() && !phone?.trim()) {
    return badRequest(res, 'At least one of first_name, email, or phone is required');
  }

  // Load scoring config
  const { data: settings } = await supabaseAdmin
    .from('crm_settings').select('config').eq('org_id', org_id).single();
  const scoringResult = computeLeadScore({ company, title, industry, phone, email }, settings?.config || {});

  const payload: Record<string, unknown> = {
    org_id, first_name, last_name, email, phone, company, title, industry,
    is_b2c, status, source_id, owner_id, territory_id,
    score: scoringResult.score, score_grade: scoringResult.grade,
    score_breakdown: scoringResult.breakdown, score_updated_at: new Date().toISOString(),
    custom_fields: custom_fields || {},
    created_by: userId,
  };
  if (is_b2c) {
    Object.assign(payload, { date_of_birth, gender, address_line1, address_line2,
      city, state, postal_code, country: country || 'India',
      preferred_contact_method, marketing_consent, whatsapp_consent });
  }

  const { data, error } = await supabaseAdmin
    .from('crm_leads').insert(payload).select('*, source:crm_lead_sources(id,name)').single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Lead created');
});

export const getLead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_leads')
    .select('*, source:crm_lead_sources(id,name)')
    .eq('id', req.params.id).eq('org_id', org_id).is('deleted_at', null).single();
  if (error || !data) return notFound(res, 'Lead not found');
  return ok(res, data);
});

export const updateLead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const updates = { ...req.body, updated_by: userId };
  delete updates.org_id; delete updates.id; delete updates.created_at;
  const { data, error } = await supabaseAdmin
    .from('crm_leads').update(updates).eq('id', req.params.id).eq('org_id', org_id)
    .is('deleted_at', null).select('*, source:crm_lead_sources(id,name)').single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const deleteLead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { error } = await supabaseAdmin
    .from('crm_leads').update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', org_id);
  if (error) return badRequest(res, error.message);
  return ok(res, { success: true });
});

export const scoreLead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data: lead, error: le } = await supabaseAdmin
    .from('crm_leads').select('*').eq('id', req.params.id).eq('org_id', org_id).single();
  if (le || !lead) return notFound(res, 'Lead not found');

  const { data: settings } = await supabaseAdmin
    .from('crm_settings').select('config').eq('org_id', org_id).single();
  const result = computeLeadScore(lead, settings?.config || {});

  await supabaseAdmin.from('crm_leads').update({
    score: result.score, score_grade: result.grade,
    score_breakdown: result.breakdown, score_updated_at: new Date().toISOString(),
  }).eq('id', lead.id);
  await supabaseAdmin.from('crm_lead_scores').insert({
    org_id, lead_id: lead.id, score: result.score, grade: result.grade,
    breakdown: result.breakdown, model: 'heuristic',
  });
  return ok(res, { id: lead.id, ...result });
});

export const getLeadActivities = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_activities').select('*').eq('org_id', org_id)
    .eq('lead_id', req.params.id).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getLeadScoreHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_lead_scores').select('*').eq('org_id', org_id)
    .eq('lead_id', req.params.id).order('created_at', { ascending: false }).limit(20);
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const convertLead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id, id: userId } = req.user!;
  const { create_account = true, create_deal = false, deal_name, deal_amount, account_id: existingAccountId } = req.body;

  const { data: lead, error: le } = await supabaseAdmin
    .from('crm_leads').select('*').eq('id', req.params.id).eq('org_id', org_id).single();
  if (le || !lead) return notFound(res, 'Lead not found');
  if (lead.is_converted) return badRequest(res, 'Lead is already converted');

  let accountId = existingAccountId;
  let contactId: string | null = null;
  let dealId: string | null = null;

  // Create/find account
  if (create_account && !existingAccountId && lead.company) {
    const { data: acct } = await supabaseAdmin
      .from('crm_accounts').insert({
        org_id, name: lead.company, industry: lead.industry,
        owner_id: lead.owner_id, created_by: userId,
      }).select().single();
    if (acct) accountId = acct.id;
  }

  // Create contact
  const { data: contact } = await supabaseAdmin
    .from('crm_contacts').insert({
      org_id, first_name: lead.first_name, last_name: lead.last_name,
      email: lead.email, phone: lead.phone, title: lead.title,
      account_id: accountId, owner_id: lead.owner_id, created_by: userId,
      marketing_consent: lead.marketing_consent, whatsapp_consent: lead.whatsapp_consent,
    }).select().single();
  if (contact) contactId = contact.id;

  // Create deal
  if (create_deal) {
    const { data: deal } = await supabaseAdmin
      .from('crm_deals').insert({
        org_id, name: deal_name || `Deal — ${lead.first_name || lead.company || 'Lead'}`,
        amount: deal_amount, lead_id: lead.id, account_id: accountId,
        contact_id: contactId, owner_id: lead.owner_id, created_by: userId, status: 'open',
      }).select().single();
    if (deal) dealId = deal.id;
  }

  await supabaseAdmin.from('crm_leads').update({
    is_converted: true, converted_at: new Date().toISOString(), status: 'converted',
    converted_account_id: accountId, converted_contact_id: contactId,
    converted_deal_id: dealId, updated_by: userId,
  }).eq('id', lead.id);

  return ok(res, { account_id: accountId, contact_id: contactId, deal_id: dealId });
});

export const getLeadDeals = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_deals').select('*').eq('org_id', org_id)
    .eq('lead_id', req.params.id).is('deleted_at', null).order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

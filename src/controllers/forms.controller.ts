import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, parseAppDate, getISTSearchRange, sendSuccess, buildPaginatedResult } from '../utils';
import { getPagination } from '../utils/pagination';
import { logger } from '../lib/logger';

export const getTemplates = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { is_active } = req.query;
  let q = supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('org_id', user.org_id);
  if (is_active !== undefined) q = q.eq('is_active', is_active === 'true');
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getTemplate = asyncHandler<AuthRequest>(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('id', req.params.id).single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createTemplate = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { title, description } = req.body;
  const { data, error } = await supabaseAdmin.from('builder_forms').insert({ title, description, org_id: user.org_id, created_by: user.id }).select().single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Template created');
});

export const addField = asyncHandler<AuthRequest>(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('builder_questions').insert({ ...req.body, form_id: req.params.id }).select().single();
  if (error) return badRequest(res, error.message);
  return created(res, data, 'Field added');
});

export const submitForm = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { template_id, activity_id, outlet_id, outlet_name, latitude, longitude, responses } = req.body;
  const { data: sub, error: subErr } = await supabaseAdmin.from('form_submissions').insert({
    user_id: user.id, org_id: user.org_id, template_id, activity_id, outlet_id, outlet_name, latitude, longitude, submitted_at: new Date().toISOString()
  }).select().single();
  if (subErr) return badRequest(res, subErr.message);
  const respRows = (responses || []).map((r: any) => ({
    submission_id: sub.id, question_id: r.question_id, 
    value_text: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
    value_number: typeof r.value === 'number' ? r.value : null,
    value_bool: typeof r.value === 'boolean' ? r.value : null
  }));
  const { error: respErr } = await supabaseAdmin.from('form_responses').insert(respRows);
  if (respErr) return badRequest(res, respErr.message);
  return created(res, sub, 'Submission successful');
});

export const getMySubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  const { data, error, count } = await supabaseAdmin.from('form_submissions').select('*, builder_forms!left(title), houses!left(name)', { count: 'exact' }).eq('user_id', user.id).order('submitted_at', { ascending: false }).range(from, to);
  if (error) return badRequest(res, error.message);
  return ok(res, buildPaginatedResult(data || [], count || 0, page, limit));
});

export const getSubmission = asyncHandler<AuthRequest>(async (req, res) => {
  const { id } = req.params;
  const { data: sub } = await supabaseAdmin.from('form_submissions').select('*, builder_forms(title), activities(name)').eq('id', id).single();
  if (sub) {
    const { data: resp } = await supabaseAdmin.from('form_responses').select('*, builder_questions(*)').eq('submission_id', id);
    return ok(res, { ...sub, form_responses: resp || [] });
  }
  const { data: bSub } = await supabaseAdmin.from('builder_submissions').select('*, builder_forms(title), users(name)').eq('id', id).single();
  if (bSub) return ok(res, { ...bSub, activities: { name: bSub.builder_forms?.title }, form_responses: bSub.responses || [] });
  return notFound(res);
});

export const getAllSubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  const { client_id, date_from, date_to, search, user_id, template_id, activity_id } = req.query;

  const effectiveOrgId = (client_id && client_id !== 'undefined') ? (client_id as string) : user.org_id;
  const isGlobal = effectiveOrgId === 'Kinematic' || effectiveOrgId === '00000000-0000-0000-0000-000000000000';

  // Always use the IST Range helper for the "definitve" fix
  const istDateFrom = parseAppDate(date_from as string);
  const istDateTo = date_to ? parseAppDate(date_to as string) : istDateFrom;
  
  const rangeFrom = getISTSearchRange(istDateFrom);
  const rangeTo = getISTSearchRange(istDateTo);
  const utcStart = rangeFrom.start;
  const utcEnd = rangeTo.end;

  logger.info(`[Forms] IST=${istDateFrom}-${istDateTo}, UTC Range=${utcStart} to ${utcEnd}`);

  // --- QUERY 1: Traditional ---
  let q1 = supabaseAdmin.from('form_submissions').select('*, form_templates:builder_forms!left(title), activities!left(name), profile:users!left(name, employee_id, role)', { count: 'exact' });
  if (!isGlobal) q1 = q1.eq('org_id', effectiveOrgId);
  q1 = q1.gte('submitted_at', utcStart).lte('submitted_at', utcEnd);
  if (user_id) q1 = q1.eq('user_id', user_id);
  
  // Flexibly handle ID column mismatch
  const tid = (template_id || activity_id) as string;
  if (tid) q1 = q1.or(`template_id.eq.${tid},activity_id.eq.${tid}`);
  
  if (search) q1 = q1.or(`outlet_name.ilike.%${search}%,store_name.ilike.%${search}%`);
  const { data: fData, count: fCount, error: fErr } = await q1.order('submitted_at', { ascending: false }).range(from, to);

  // --- QUERY 2: Builder ---
  let q2 = supabaseAdmin.from('builder_submissions').select('*, users!inner(name, employee_id), builder_forms!inner(title)', { count: 'exact' });
  if (!isGlobal) q2 = q2.eq('org_id', effectiveOrgId);
  q2 = q2.gte('submitted_at', utcStart).lte('submitted_at', utcEnd);
  if (user_id) q2 = q2.eq('user_id', user_id);
  if (tid) q2 = q2.eq('form_id', tid);
  if (search) q2 = q2.or(`outlet_name.ilike.%${search}%,users.name.ilike.%${search}%`);
  const { data: bData, count: bCount, error: bErr } = await q2.order('submitted_at', { ascending: false }).range(from, to);

  const normalizedF = (fData || []).map(f => ({
      ...f, 
      type: 'traditional',
      outlet_name: f.outlet_name || f.store_name || 'Individual Submission',
      users: f.profile || { name: 'FE' },
      activities: f.activities || { name: f.form_templates?.title || 'Form' }
  }));

  const normalizedB = (bData || []).map(b => ({
      ...b, 
      type: 'builder',
      outlet_name: b.outlet_name || 'Individual Submission',
      users: b.users || { name: 'FE' },
      activities: { name: b.builder_forms?.title || 'Form' }
  }));

  const merged = [...normalizedF, ...normalizedB].sort((a, b) => 
      new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
  ).slice(0, limit);

  return sendSuccess(res, {
    ...buildPaginatedResult(merged, (fCount || 0) + (bCount || 0), page, limit),
    debug: { istDateFrom, utcStart, utcEnd, fCount, bCount }
  });
});

import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, parseAppDate, getISTSearchRange } from '../utils';
import { getPagination, buildPaginatedResult } from '../utils/pagination';
import { logger } from '../lib/logger';

// --- Controllers ---

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

  // --- Date Range for IST ---
  const df = date_from ? parseAppDate(date_from as string) : null;
  const dt = date_to ? parseAppDate(date_to as string) : (df || null);
  
  let utcStart = null, utcEnd = null;
  if (df) {
    const range = getISTSearchRange(df);
    utcStart = range.start;
    if (dt) utcEnd = getISTSearchRange(dt).end;
    else utcEnd = range.end;
  }

  logger.info(`[Forms] Search: org=${effectiveOrgId}, IST=(${df} to ${dt}), UTC=(${utcStart} to ${utcEnd})`);

  // --- QUERY 1: Traditional ---
  let q1 = supabaseAdmin.from('form_submissions').select('*, form_templates:builder_forms!left(title), activities!left(name), profile:users!left(name, role)', { count: 'exact' });
  if (!isGlobal) q1 = q1.eq('org_id', effectiveOrgId);
  if (utcStart) q1 = q1.gte('submitted_at', utcStart);
  if (utcEnd) q1 = q1.lte('submitted_at', utcEnd);
  if (user_id) q1 = q1.eq('user_id', user_id);
  const tid = template_id || activity_id;
  if (tid) q1 = q1.eq('template_id', tid);
  if (search) q1 = q1.or(`outlet_name.ilike.%${search}%,store_name.ilike.%${search}%`);
  const { data: fData, count: fCount } = await q1.order('submitted_at', { ascending: false }).range(from, to);

  // --- QUERY 2: Builder ---
  let q2 = supabaseAdmin.from('builder_submissions').select('*, users!inner(name, employee_id), builder_forms!inner(title)', { count: 'exact' });
  if (!isGlobal) q2 = q2.eq('org_id', effectiveOrgId);
  if (utcStart) q2 = q2.gte('submitted_at', utcStart);
  if (utcEnd) q2 = q2.lte('submitted_at', utcEnd);
  if (user_id) q2 = q2.eq('user_id', user_id);
  if (tid) q2 = q2.eq('form_id', tid);
  if (search) q2 = q2.or(`outlet_name.ilike.%${search}%,users.name.ilike.%${search}%`);
  const { data: bData, count: bCount } = await q2.order('submitted_at', { ascending: false }).range(from, to);

  const totalPossible = (fCount || 0) + (bCount || 0);
  let finalRows = [];
  if (bCount && (bCount || 0) > 0) {
    finalRows = (bData || []).map(b => ({
      ...b, users: b.users, 
      submitted_at: b.submitted_at, 
      outlet_name: b.outlet_name || 'Outlet',
      activities: { name: b.builder_forms?.title || 'Form' }
    }));
  } else {
    finalRows = fData || [];
  }

  return res.status(200).json({ 
    ...buildPaginatedResult(finalRows, totalPossible, page, limit), 
    debug: { df, dt, utcStart, utcEnd, fCount, bCount, isGlobal } 
  });
});

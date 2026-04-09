import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, parseAppDate } from '../utils';
import { getPagination, buildPaginatedResult } from '../utils/pagination';
import { logger } from '../lib/logger';

const submissionSchema = z.object({
  template_id: z.string().uuid(),
  activity_id: z.string().uuid().optional(),
  outlet_id: z.string().uuid().optional(),
  outlet_name: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  responses: z.array(z.object({
    question_id: z.string().uuid(),
    value: z.any()
  }))
});

// --- Template Management ---

export const getTemplates = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { is_active } = req.query;
  let query = supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('org_id', user.org_id);
  if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const getTemplate = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('id', req.params.id).single();
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

export const createTemplate = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { title, description } = req.body;
  const { data, error } = await supabaseAdmin
    .from('builder_forms')
    .insert({ title, description, org_id: user.org_id, created_by: user.id })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Template created');
});

export const addField = asyncHandler<AuthRequest>(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('builder_questions')
    .insert({ ...req.body, form_id: req.params.id })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Field added');
});

// --- Submission Flow ---

export const submitForm = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const validated = submissionSchema.parse(req.body);

  const { data: sub, error: subErr } = await supabaseAdmin
    .from('form_submissions')
    .insert({
      user_id: user.id,
      org_id: user.org_id,
      template_id: validated.template_id,
      activity_id: validated.activity_id,
      outlet_id: validated.outlet_id,
      outlet_name: validated.outlet_name,
      latitude: validated.latitude,
      longitude: validated.longitude,
      submitted_at: new Date().toISOString()
    })
    .select()
    .single();

  if (subErr) return badRequest(res, subErr.message);

  const responses = validated.responses.map(r => ({
    submission_id: sub.id,
    question_id: r.question_id,
    value_text: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
    value_number: typeof r.value === 'number' ? r.value : null,
    value_bool: typeof r.value === 'boolean' ? r.value : null
  }));

  const { error: respErr } = await supabaseAdmin.from('form_responses').insert(responses);
  if (respErr) return badRequest(res, respErr.message);

  return created(res, sub, 'Submission successful');
});

export const getMySubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  
  const { data, error, count } = await supabaseAdmin
    .from('form_submissions')
    .select('*, builder_forms!left(title), activities!left(name)', { count: 'exact' })
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: false })
    .range(from, to);

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
  if (bSub) {
    return ok(res, { ...bSub, activities: { name: bSub.builder_forms?.title }, form_responses: bSub.responses || [] });
  }
  return notFound(res);
});

// --- Main Unified Admin Query ---

export const getAllSubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  const { client_id, date_from, date_to, search, user_id, activity_id, template_id } = req.query;

  const isAdmin = user.role === 'admin' || user.role === 'super_admin' || (user.role as string) === 'main_admin';
  const effectiveOrgId = (client_id && client_id !== 'undefined') ? (client_id as string) : user.org_id;

  const df = date_from ? parseAppDate(date_from as string) : null;
  const dt = date_to ? parseAppDate(date_to as string) : null;

  logger.info(`[Forms] SEARCH: org=${effectiveOrgId}, from=${df}, to=${dt}`);

  // --- QUERY 1: TRADITIONAL ---
  let q1 = supabaseAdmin
    .from('form_submissions')
    .select('*, form_templates:builder_forms!left(title), activities!left(name), profile:users!left(name, role), form_responses(*, builder_questions(*))', { count: 'exact' });

  if (effectiveOrgId && effectiveOrgId !== 'Kinematic') q1 = q1.eq('org_id', effectiveOrgId);
  if (df) q1 = q1.filter('submitted_at', 'gte', `${df}T00:00:00`);
  if (dt) q1 = q1.filter('submitted_at', 'lte', `${dt}T23:59:59`);
  if (user_id) q1 = q1.eq('user_id', user_id);
  const tid = template_id || activity_id;
  if (tid) q1 = q1.eq('template_id', tid);
  if (search) q1 = q1.or(`outlet_name.ilike.%${search}%,store_name.ilike.%${search}%`);

  const { data: fData, count: fCount } = await q1.order('submitted_at', { ascending: false }).range(from, to);

  // --- QUERY 2: BUILDER ---
  let q2 = supabaseAdmin
    .from('builder_submissions')
    .select('*, users!inner(name, employee_id), builder_forms!inner(title)', { count: 'exact' });

  if (effectiveOrgId && effectiveOrgId !== 'Kinematic') q2 = q2.eq('org_id', effectiveOrgId);
  if (df) q2 = q2.filter('submitted_at', 'gte', `${df}T00:00:00`);
  if (dt) q2 = q2.filter('submitted_at', 'lte', `${dt}T23:59:59`);
  if (user_id) q2 = q2.eq('user_id', user_id);
  if (tid) q2 = q2.eq('form_id', tid);
  if (search) q2 = q2.or(`outlet_name.ilike.%${search}%,users.name.ilike.%${search}%`);

  const { data: bData, count: bCount } = await q2.order('submitted_at', { ascending: false }).range(from, to);

  const totalPossible = (fCount || 0) + (bCount || 0);
  let finalRows = [];
  if (bCount && bCount > 0) {
    finalRows = (bData || []).map(b => ({
      ...b,
      users: b.users,
      submitted_at: b.submitted_at,
      outlet_name: b.outlet_name || 'Dynamic Outlet',
      activities: { name: b.builder_forms?.title || 'Form' },
      form_responses: b.responses || []
    }));
  } else {
    finalRows = fData || [];
  }

  const result = buildPaginatedResult(finalRows, totalPossible, page, limit);
  return res.status(200).json({ 
    ...result, 
    debug: { parsed_from: df, parsed_to: dt, fCount, bCount, org: effectiveOrgId } 
  });
});

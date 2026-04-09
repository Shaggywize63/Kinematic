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

export const getTemplates = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { is_active } = req.query;

  let query = supabaseAdmin
    .from('builder_forms')
    .select('*, builder_questions(*)')
    .eq('org_id', user.org_id);

  if (is_active !== undefined) {
    query = query.eq('is_active', is_active === 'true');
  }

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);

  return ok(res, data);
});

export const getTemplate = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin
    .from('builder_forms')
    .select('*, builder_questions(*)')
    .eq('id', req.params.id)
    .eq('org_id', user.org_id)
    .single();

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

export const submitForm = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const validated = submissionSchema.parse(req.body);

  // 1. Create Submission record
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

  // 2. Create Responses
  const responses = validated.responses.map(r => ({
    submission_id: sub.id,
    question_id: r.question_id,
    value_text: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
    value_number: typeof r.value === 'number' ? r.value : null,
    value_bool: typeof r.value === 'boolean' ? r.value : null
  }));

  const { error: respErr } = await supabaseAdmin
    .from('form_responses')
    .insert(responses);

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
  return ok(res, buildPaginatedResult(data || [], count || 0, (page as any), (limit as any)));
});

export const getSubmissionById = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { id } = req.params;

  const { data: submission, error: subError } = await supabaseAdmin
    .from('form_submissions')
    .select('*, builder_forms(title), activities(name)')
    .eq('id', id)
    .eq('org_id', user.org_id)
    .single();

  if (subError) return badRequest(res, subError.message);

  const { data: responses, error: respError } = await supabaseAdmin
    .from('form_responses')
    .select('*, builder_questions(*)')
    .eq('submission_id', id);

  if (respError) return badRequest(res, respError.message);

  return ok(res, { ...submission, responses: responses || [] });
});

export const getSubmission = getSubmissionById;

export const getAllSubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  const { date, user_id, template_id, activity_id, outlet_id, client_id, date_from, date_to, search } = req.query;

  const isAdmin = user.role === 'admin' || user.role === 'super_admin' || (user.role as string) === 'main_admin';
  const effectiveOrgId = (client_id && client_id !== 'undefined' && client_id !== 'null' && client_id !== '') ? client_id : user.org_id;

  logger.info(`[Forms] ALL-SUBMISSIONS: user=${user.id}, org=${effectiveOrgId}, admin=${isAdmin}, from=${date_from}, to=${date_to}`);

  // --- QUERY 1: TRADITIONAL FORM SUBMISSIONS ---
  let query = supabaseAdmin
    .from('form_submissions')
    .select('*, form_templates:builder_forms!left(title), activities!left(name), profile:users!left(name, role), form_responses(*, builder_questions(*))', { count: 'exact' });

  if (isAdmin && client_id && client_id !== 'undefined') {
    query = query.eq('org_id', client_id);
  } else if (!isAdmin) {
    query = query.eq('org_id', user.org_id);
  }

  if (date) {
    const d = parseAppDate(date as string);
    query = query.filter('submitted_at', 'gte', `${d}T00:00:00`).filter('submitted_at', 'lte', `${d}T23:59:59`);
  } else if (date_from || date_to) {
    if (date_from) query = query.filter('submitted_at', 'gte', `${parseAppDate(date_from as string)}T00:00:00`);
    if (date_to) query = query.filter('submitted_at', 'lte', `${parseAppDate(date_to as string)}T23:59:59`);
  }

  if (user_id) query = query.eq('user_id', user_id);
  const tid = template_id || activity_id;
  if (tid) query = query.eq('template_id', tid);
  if (outlet_id) query = query.eq('outlet_id', outlet_id);
  if (search) query = query.or(`outlet_name.ilike.%${search}%,store_name.ilike.%${search}%`);

  const { data: fData, count: fCount, error: fError } = await query.order('submitted_at', { ascending: false }).range(from, to);

  // --- QUERY 2: NEW BUILDER SUBMISSIONS ---
  let bQuery = supabaseAdmin
    .from('builder_submissions')
    .select('*, users!inner(name, employee_id), builder_forms!inner(title)', { count: 'exact' });

  if (isAdmin && client_id && client_id !== 'undefined') {
    bQuery = bQuery.eq('org_id', client_id);
  } else if (!isAdmin) {
    bQuery = bQuery.eq('org_id', user.org_id);
  }

  if (date) {
    const bd = parseAppDate(date as string);
    bQuery = bQuery.filter('submitted_at', 'gte', `${bd}T00:00:00`).filter('submitted_at', 'lte', `${bd}T23:59:59`);
  } else if (date_from || date_to) {
    if (date_from) bQuery = bQuery.filter('submitted_at', 'gte', `${parseAppDate(date_from as string)}T00:00:00`);
    if (date_to) bQuery = bQuery.filter('submitted_at', 'lte', `${parseAppDate(date_to as string)}T23:59:59`);
  }

  if (user_id) bQuery = bQuery.eq('user_id', user_id);
  if (tid) bQuery = bQuery.eq('form_id', tid);
  if (search) bQuery = bQuery.or(`outlet_name.ilike.%${search}%,users.name.ilike.%${search}%`);

  const { data: bData, count: bCount, error: bError } = await bQuery.order('submitted_at', { ascending: false }).range(from, to);

  logger.info(`[Forms] Results: form_submissions=${fCount || 0}, builder_submissions=${bCount || 0}`);

  // --- MERGE & RESPOND ---
  // If either has data, prioritize the one with more or just merge if they are active simultaneously.
  // For Kinematic, usually one table is "active".
  if ((bCount || 0) > 0) {
    const mappedBData = (bData || []).map(b => ({
      ...b,
      users: b.users,
      submitted_at: b.submitted_at,
      outlet_name: b.outlet_name || 'Dynamic Outlet',
      activities: { name: b.builder_forms?.title || 'Form Builder Activity' },
      form_responses: b.responses || [] // Map responses if they exist in builder_submissions
    }));
    return ok(res, buildPaginatedResult(mappedBData, bCount || 0, page, limit));
  }

  if (fError) {
    logger.error(`[Forms] Traditional Query Error: ${fError.message}`);
    return badRequest(res, fError.message);
  }

  return ok(res, buildPaginatedResult(fData || [], fCount || 0, page, limit));
});

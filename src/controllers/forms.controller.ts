import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../utils';
import { getPagination, buildPaginatedResult } from '../utils/pagination';

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
    .select('*, builder_forms(title), activities(name)', { count: 'exact' })
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
  const { date, user_id, template_id, outlet_id, client_id } = req.query;

  // REMOVE org_id filtering temporarily to debug if data exists but org_id is mismatched
  let query = supabaseAdmin
    .from('form_submissions')
    .select('*, builder_forms!left(title), activities!left(name), profile:users!user_id(name, role), form_responses(*, builder_questions(*))', { count: 'exact' });

  // If a specific client is selected, use that, otherwise default to user's org
  if (client_id) {
    query = query.eq('org_id', client_id);
  } else if (user.role !== 'developer' && user.role !== 'admin') {
     // Only enforce org_id for non-admins to allow wider visibility during debugging
     query = query.eq('org_id', user.org_id);
  }

  if (date) {
    query = query.filter('submitted_at', 'gte', `${date}T00:00:00`).filter('submitted_at', 'lte', `${date}T23:59:59`);
  }
  if (user_id) query = query.eq('user_id', user_id);
  if (template_id) query = query.eq('template_id', template_id);
  if (outlet_id) query = query.eq('outlet_id', outlet_id);

  query = query.order('submitted_at', { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) return badRequest(res, error.message);

  return ok(res, buildPaginatedResult(data || [], count || 0, (page as any), (limit as any)));
});

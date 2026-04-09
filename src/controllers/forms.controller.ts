import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, isUUID, getPagination } from '../utils';
import { buildPaginatedResult } from '../utils/pagination';

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

export const submitForm = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const result = submissionSchema.safeParse(req.body);
  if (!result.success) {
    const errorMsg = JSON.stringify(result.error.format(), null, 2);
    console.error('Validation failed:', errorMsg);
    return badRequest(res, 'Validation failed: ' + errorMsg, result.error.errors);
  }
  const { responses, ...submissionData } = result.data;

  // 1. Verify template exists in builder_forms
  const { data: template } = await supabaseAdmin
    .from('builder_forms')
    .select('id, org_id')
    .eq('id', submissionData.template_id)
    .single();

  if (!template) return badRequest(res, 'Form template not found');

  // 2. Create the submission record
  const { data: submission, error: subError } = await supabaseAdmin
    .from('form_submissions')
    .insert({
      ...submissionData,
      user_id: user.id,
      org_id: user.org_id,
      submitted_at: new Date().toISOString()
    })
    .select()
    .single();

  if (subError) return badRequest(res, subError.message);

  // 3. Create the responses
  if (responses && responses.length > 0) {
    const responseData = responses.map(r => ({
      submission_id: submission.id,
      question_id: r.question_id,
      value: r.value
    }));

    const { error: respError } = await supabaseAdmin
      .from('form_responses')
      .insert(responseData);

    if (respError) {
      // rollback submission?
      await supabaseAdmin.from('form_submissions').delete().eq('id', submission.id);
      return badRequest(res, respError.message);
    }
  }

  return created(res, submission, 'Form submitted');
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

// GET /api/v1/forms/all-submissions (admin+)
export const getAllSubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as string, req.query.limit as string);
  const { date, user_id, template_id, outlet_id } = req.query;

  // CRITICAL FIX: .select() MUST be first in the chain for postgrest-js to return a query object
  let query = supabaseAdmin
    .from('form_submissions')
    .select('*, form_templates:builder_forms!fk_submission_template(title), activities(name), profile:users!user_id(name, role), form_responses(*, builder_questions(*))', { count: 'exact' });

  query = query.eq('org_id', user.org_id);

  if (date) {
    query = query.filter('submitted_at', 'gte', `${date}T00:00:00`).filter('submitted_at', 'lte', `${date}T23:59:59`);
  }
  if (user_id) query = query.eq('user_id', user_id);
  if (template_id) query = query.eq('template_id', template_id);
  if (outlet_id) query = query.eq('outlet_id', outlet_id);

  query = query.order('submitted_at', { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) return badRequest(res, error.message);

  const result = buildPaginatedResult(data || [], count || 0, page, limit);
  return ok(res, result);
});

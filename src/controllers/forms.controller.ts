import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound, forbidden } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { getPagination, buildPaginatedResult } from '../utils/pagination';

const fieldSchema = z.object({
  label: z.string().min(1),
  field_key: z.string().min(1).regex(/^[a-z_]+$/),
  field_type: z.enum(['text','textarea','number','select','multi_select','radio','checkbox','photo','date','rating']),
  placeholder: z.string().optional(),
  help_text: z.string().optional(),
  is_required: z.boolean().default(false),
  sort_order: z.number().int().default(0),
  options: z.array(z.object({ label: z.string(), value: z.string(), is_correct: z.boolean().optional() })).default([]),
  validation: z.record(z.unknown()).default({}),
});

const templateSchema = z.object({
  activity_id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  requires_photo: z.boolean().default(false),
  requires_gps: z.boolean().default(true),
  fields: z.array(fieldSchema).optional(),
});

const responseSchema = z.object({
  field_id: z.string().uuid(),
  field_key: z.string(),
  value_text: z.string().optional(),
  value_number: z.number().optional(),
  value_bool: z.boolean().optional(),
  value_json: z.unknown().optional(),
  photo_url: z.string().url().optional(),
});

const submissionSchema = z.object({
  template_id: z.string().uuid(),
  activity_id: z.string().uuid().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
  is_converted: z.boolean().default(false),
  outlet_name: z.string().optional(),
  consumer_age: z.string().optional(),
  consumer_gender: z.string().optional(),
  responses: z.array(responseSchema).min(1),
});

// ── Templates ──────────────────────────────────────────────

// GET /api/v1/forms/templates
export const getTemplates = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const activityId = req.query.activity_id as string | undefined;

  let query = supabaseAdmin
    .from('form_templates')
    .select('*, form_fields(*), activities(id, name, type, color)')
    .eq('org_id', user.org_id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (activityId) query = query.eq('activity_id', activityId);

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

// GET /api/v1/forms/templates/:id
export const getTemplate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;

  const { data, error } = await supabaseAdmin
    .from('form_templates')
    .select('*, form_fields(*), activities(id, name, type)')
    .eq('id', id)
    .eq('org_id', user.org_id)
    .single();

  if (error || !data) return notFound(res, 'Template not found');
  return ok(res, data);
});

// POST /api/v1/forms/templates  (admin+)
export const createTemplate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = templateSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { fields, ...templateData } = body.data;

  const { data: template, error } = await supabaseAdmin
    .from('form_templates')
    .insert({ ...templateData, org_id: user.org_id, created_by: user.id })
    .select()
    .single();

  if (error) return badRequest(res, error.message);

  // Insert fields if provided
  if (fields?.length) {
    const { error: fieldsError } = await supabaseAdmin
      .from('form_fields')
      .insert(fields.map((f) => ({ ...f, template_id: template.id })));
    if (fieldsError) return badRequest(res, fieldsError.message);
  }

  const { data: full } = await supabaseAdmin
    .from('form_templates')
    .select('*, form_fields(*)')
    .eq('id', template.id)
    .single();

  return created(res, full, 'Template created');
});

// POST /api/v1/forms/templates/:id/fields  (admin+)
export const addField = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const body = fieldSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  // Verify template belongs to org
  const { data: tmpl } = await supabaseAdmin
    .from('form_templates')
    .select('id')
    .eq('id', id)
    .eq('org_id', user.org_id)
    .single();
  if (!tmpl) return notFound(res, 'Template not found');

  const { data, error } = await supabaseAdmin
    .from('form_fields')
    .insert({ ...body.data, template_id: id })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Field added');
});

// ── Submissions ────────────────────────────────────────────

// POST /api/v1/forms/submit
export const submitForm = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = submissionSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { responses, ...submissionData } = body.data;

  // Verify template exists in org
  const { data: template } = await supabaseAdmin
    .from('form_templates')
    .select('id, form_fields(id, field_key, is_required)')
    .eq('id', submissionData.template_id)
    .eq('org_id', user.org_id)
    .single();

  if (!template) return notFound(res, 'Form template not found');

  // Validate required fields are present
  const requiredFields = (template.form_fields as { id: string; field_key: string; is_required: boolean }[])
    .filter((f) => f.is_required)
    .map((f) => f.field_key);
  const submittedKeys = responses.map((r) => r.field_key);
  const missing = requiredFields.filter((k) => !submittedKeys.includes(k));
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(', ')}`);

  // Get today's attendance
  const today = new Date().toISOString().split('T')[0];
  const { data: attendance } = await supabaseAdmin
    .from('attendance')
    .select('id')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  // Insert submission
  const { data: submission, error: subError } = await supabaseAdmin
    .from('form_submissions')
    .insert({
      ...submissionData,
      org_id: user.org_id,
      user_id: user.id,
      attendance_id: attendance?.id,
    })
    .select()
    .single();

  if (subError) return badRequest(res, subError.message);

  // Insert responses
  const { error: respError } = await supabaseAdmin
    .from('form_responses')
    .insert(responses.map((r) => ({ ...r, submission_id: submission.id })));

  if (respError) return badRequest(res, respError.message);

  return created(res, { submission_id: submission.id, is_converted: submission.is_converted },
    'Form submitted successfully');
});

// GET /api/v1/forms/submissions
export const getMySubmissions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as string, req.query.limit as string);
  const date = req.query.date as string | undefined;

  let query = supabaseAdmin
    .from('form_submissions')
    .select('*, form_templates(name), activities(name)', { count: 'exact' })
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: false })
    .range(from, to);

  if (date) query = query.eq('submitted_at::date', date);

  const { data, error, count } = await query;
  if (error) return badRequest(res, error.message);
  return ok(res, buildPaginatedResult(data || [], count || 0, page, limit));
});

// GET /api/v1/forms/submissions/:id
export const getSubmission = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('*, form_responses(*, form_fields(label, field_type)), form_templates(name), activities(name)')
    .eq('id', id)
    .single();

  if (error || !data) return notFound(res, 'Submission not found');

  // Execs can only see their own; supervisors+ see org
  if (data.user_id !== user.id && !['admin','city_manager','supervisor','super_admin'].includes(user.role)) {
    return forbidden(res);
  }

  return ok(res, data);
});

// GET /api/v1/admin/submissions  (supervisor+)
export const getAllSubmissions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as string, req.query.limit as string);
  const { date, zone_id, activity_id, user_id } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('form_submissions')
    .select(`
      id, submitted_at, is_converted, outlet_name, user_id, activity_id,
      users(name, employee_id),
      activities(name),
      form_templates(name)
    `, { count: 'exact' })
    .eq('org_id', user.org_id)
    .order('submitted_at', { ascending: false })
    .range(from, to);

  if (date) query = query.gte('submitted_at', `${date}T00:00:00`).lte('submitted_at', `${date}T23:59:59`);
  if (activity_id) query = query.eq('activity_id', activity_id);
  if (user_id) query = query.eq('user_id', user_id);

  const { data, error, count } = await query;
  if (error) return badRequest(res, error.message);
  return ok(res, buildPaginatedResult(data || [], count || 0, page, limit));
});

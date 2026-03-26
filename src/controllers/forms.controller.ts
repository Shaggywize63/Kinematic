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
  field_key: z.string().optional().nullable(),
  value: z.any().optional().nullable(),
  photo: z.string().optional().nullable(),
  gps: z.string().optional().nullable(),
});

const submissionSchema = z.object({
  template_id: z.string().uuid(),
  activity_id: z.string().uuid().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
  is_converted: z.boolean().default(false),
  outlet_id: z.string().uuid().optional(),
  outlet_name: z.string().optional(),
  consumer_age: z.string().nullable().optional(),
  consumer_gender: z.string().nullable().optional(),
  responses: z.array(responseSchema).min(1),
});

// ── Templates ──────────────────────────────────────────────

// GET /api/v1/forms/templates
export const getTemplates = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const activityId = req.query.activity_id as string | undefined;

  // 1. Fetch from builder_forms (Dynamic Form Builder)
  let query = supabaseAdmin
    .from('builder_forms')
    .select('*')
    .eq('org_id', user.org_id)
    .eq('status', 'published')
    .order('created_at', { ascending: false });

  if (activityId) query = query.eq('activity_id', activityId);

  const { data: forms, error: formsError } = await query;
  if (formsError) return badRequest(res, formsError.message);
  if (!forms || forms.length === 0) return ok(res, []);

  // 2. Fetch all questions for these forms separately to avoid nested join issues
  const formIds = forms.map(f => f.id);
  const { data: allQuestions, error: qError } = await supabaseAdmin
    .from('builder_questions')
    .select('*')
    .in('form_id', formIds)
    .order('q_order', { ascending: true });

  if (qError) return badRequest(res, qError.message);

  // 3. Map builder_forms to FormTemplate format for the mobile app
  const mappedTemplates = forms.map((f: any) => {
    const formQuestions = (allQuestions || []).filter(q => q.form_id === f.id);
    
    return {
      id: f.id,
      activity_id: f.activity_id,
      name: f.title,
      description: f.description,
      requires_photo: f.requires_photo || false, 
      requires_gps: f.requires_gps !== false,    
      form_fields: formQuestions.map((q: any) => {
        // Map qtype to field_type for mobile app compatibility
        let fieldType = 'text';
        const qt = (q.type || q.qtype || '').toLowerCase();
        if (['short_text', 'text', 'email', 'phone', 'url'].includes(qt)) fieldType = 'text';
        else if (['long_text', 'textarea'].includes(qt)) fieldType = 'textarea';
        else if (['number', 'integer', 'decimal'].includes(qt)) fieldType = 'number';
        else if (['single_select', 'choice', 'select', 'dropdown', 'dropdown_search', 'radio'].includes(qt)) fieldType = 'select';
        else if (['multi_select', 'checkbox_group', 'tags', 'checkbox'].includes(qt)) fieldType = 'multi_select';
        else if (['yes_no', 'boolean', 'toggle'].includes(qt)) fieldType = 'yes_no';
        else if (['rating', 'star_rating'].includes(qt)) fieldType = 'rating';
        else if (['image_upload', 'photo', 'image', 'camera'].includes(qt)) fieldType = 'photo';
        else if (['date'].includes(qt)) fieldType = 'date';
        else if (['time'].includes(qt)) fieldType = 'time';
        else if (['date_time', 'datetime'].includes(qt)) fieldType = 'datetime';
        else if (['location', 'gps', 'map'].includes(qt)) fieldType = 'gps';
        else if (['signature'].includes(qt)) fieldType = 'signature';
        else if (['file_upload', 'file'].includes(qt)) fieldType = 'file';
        else if (['consent'].includes(qt)) fieldType = 'consent';
        else if (['section', 'section_header'].includes(qt)) fieldType = 'section';
        else fieldType = 'text';

        console.log(`Mapping question ${q.id}: qtype="${q.qtype}", type="${q.type}", resolved qt="${qt}", mapped to fieldType="${fieldType}"`);
        
        // Map options
        let options: any[] = [];
        if (q.options) {
          try {
            const opts = typeof q.options === 'string' ? JSON.parse(q.options) : q.options;
            if (Array.isArray(opts)) {
              options = opts.map((opt: any, i: number) => {
                if (typeof opt === 'string') return { id: `opt_${i}`, label: opt, value: opt };
                return {
                  id: opt.id || `opt_${i}`,
                  label: opt.label || opt.text || opt.value || `Option ${i+1}`,
                  value: opt.value || opt.id || opt.label || ''
                };
              });
            } else if (typeof opts === 'object' && opts !== null) {
              // Handle object-based options { "key": "label" }
              options = Object.entries(opts).map(([val, label], i) => ({
                id: `opt_${i}`,
                label: String(label),
                value: String(val)
              }));
            }
          } catch (e) {
            console.error(`Error parsing options for question ${q.id}:`, e);
          }
        }

        // Fallback for yes_no
        if (options.length === 0 && qt === 'yes_no') {
          options = [
            { id: 'opt_yes', label: 'Yes', value: 'Yes' },
            { id: 'opt_no', label: 'No', value: 'No' },
          ];
        }
        
        return {
          id: q.id,
          field_key: q.field_key || `field_${q.id}`,
          label: q.title || q.label || "",
          field_type: fieldType,
          is_required: q.required || q.is_required || false,
          options: options,
          placeholder: q.placeholder || "",
          helper_text: q.helper_text || ""
        };
      })
    };
  });

  return ok(res, mappedTemplates);
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
  console.log("Received form submission:", JSON.stringify(req.body, null, 2));
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
    .select('id')
    .eq('id', submissionData.template_id)
    .eq('org_id', user.org_id)
    .single();
  if (!template) return notFound(res, 'Form template not found');

  // 2. Fetch questions for validation
  const { data: questions } = await supabaseAdmin
    .from('builder_questions')
    .select('id, field_key, required')
    .eq('form_id', template.id);

  // 3. Map responses to DB format
  const submittedResponses = responses.map(r => {
    const q = (questions || []).find(q => q.id === r.field_id);
    return {
      submission_id: '', // Will be set after insert
      question_id: r.field_id,
      field_key: r.field_key || q?.field_key || '',
      value: r.value,
      photo_url: r.photo,
      gps: r.gps
    };
  });

  // 4. Get today's attendance
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

  // 5. Insert responses
  const { error: respError } = await supabaseAdmin
    .from('form_responses')
    .insert(submittedResponses.map((r) => ({ ...r, submission_id: submission.id })));

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

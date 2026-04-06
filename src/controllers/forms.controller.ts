import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound, forbidden, todayDate } from '../utils';
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
  gps: z.string().optional(),
  consumer_age: z.string().nullable().optional(),
  consumer_gender: z.string().nullable().optional(),
  photo_url: z.string().optional(),
  submitted_at: z.string().optional(),
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

        console.log(`Mapped question ${q.id}: type=${fieldType}, optionsCount=${options.length}`);
        if (options.length > 0) {
          console.log(`Options for ${q.id}:`, JSON.stringify(options));
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
          help_text: q.helper_text || q.help_text || "",
          keyboard_type: q.keyboard_type || null,
          image_count: q.image_count || 1,
          camera_only: q.camera_only || false,
          depends_on_id: q.depends_on_id || null,
          depends_on_value: q.depends_on_value || null,
          is_consent: q.is_consent || false
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
    
    // Determine which value column to use based on the value type
    let value_text: string | null = null;
    let value_number: number | null = null;
    let value_bool: boolean | null = null;
    let value_json: any | null = null;

    if (typeof r.value === 'number') value_number = r.value;
    else if (typeof r.value === 'boolean') value_bool = r.value;
    else if (typeof r.value === 'object' && r.value !== null) value_json = r.value;
    else value_text = r.value ? String(r.value) : null;

    return {
      submission_id: '', // Will be set after insert
      field_id: r.field_id,
      field_key: r.field_key || q?.field_key || '',
      value_text,
      value_number,
      value_bool,
      value_json,
      photo_url: r.photo,
      gps: r.gps
    };
  });

  // 4. Get today's attendance
  const today = todayDate();
  const { data: attendance } = await supabaseAdmin
    .from('attendance')
    .select('id')
    .eq('user_id', user.id)
    .eq('date', today)
    .maybeSingle();

  // Insert submission
  const { data: submission, error: subError } = await supabaseAdmin
    .from('form_submissions')
    .insert({
      ...submissionData,
      template_id: submissionData.template_id || (submissionData as any).templateId,
      activity_id: submissionData.activity_id || (submissionData as any).activityId,
      outlet_id: submissionData.outlet_id || (submissionData as any).outletId,
      outlet_name: submissionData.outlet_name || (submissionData as any).outletName,
      gps: submissionData.gps || (submissionData.latitude && submissionData.longitude ? `${submissionData.latitude},${submissionData.longitude}` : null),
      client_id: user.client_id,
      org_id: user.org_id,
      user_id: user.id,
      attendance_id: attendance?.id,
      submitted_at: submissionData.submitted_at || new Date().toISOString(),
      date: (submissionData as any).date || today,
      is_converted: submissionData.is_converted !== undefined ? submissionData.is_converted : (submissionData as any).isConverted ?? true,
    })
    .select()
    .single();

  if (subError) return badRequest(res, subError.message);

  // 5. Insert responses
  const { error: respError } = await supabaseAdmin
    .from('form_responses')
    .insert(submittedResponses.map((r) => ({ ...r, submission_id: submission.id })));

  if (respError) return badRequest(res, respError.message);
  
  // 6. Update route plan outlet status to 'visited' if outlet_id is provided
  const oid = submissionData.outlet_id || (submissionData as any).outletId;
  if (oid) {
    await supabaseAdmin
      .from('route_plan_outlets')
      .update({ 
        status: 'visited',
        checkout_at: new Date().toISOString() 
      })
      .eq('id', oid);
  }

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
    .select('*, form_templates:builder_forms!fk_submission_template(title), activities(name)', { count: 'exact' })
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: false })
    .range(from, to);

  if (date) query = query.eq('submitted_at::date', date);

  const { data, error, count } = await query;
  if (error) return badRequest(res, error.message);
  const result = buildPaginatedResult(data || [], count || 0, page, limit); return res.status(200).json({ success: true, ...result });
});

// GET /api/v1/forms/submissions/:id
export const getSubmission = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;

  const { data: submission, error } = await supabaseAdmin
    .from('form_submissions')
    .select('*, builder_forms:builder_forms!fk_submission_template(title), activities(name)')
    .eq('id', id)
    .single();

  if (error || !submission) return notFound(res, 'Submission not found');

  // Execs can only see their own; supervisors+ see org
  if (submission.user_id !== user.id && !['admin','city_manager','supervisor','super_admin'].includes(user.role)) {
    return forbidden(res);
  }

  // Decoupled fetch for responses first to ensure data visibility even if join fails
  const { data: responses, error: respError } = await supabaseAdmin
    .from('form_responses')
    .select('id, value_text, value_number, value_bool, photo_url, field_key, field_id')
    .eq('submission_id', id);

  if (respError) {
    console.error('Error fetching responses:', respError);
    return ok(res, { ...submission, form_responses: [] });
  }

  // Fetch questions separately to avoid PostgREST relationship ambiguity
  const { data: questions } = await supabaseAdmin
    .from('builder_questions')
    .select('id, label, qtype')
    .eq('form_id', submission.template_id);

  // Map questions to responses manually
  const mappedResponses = (responses || []).map(r => {
    const q = (questions || []).find(q => q.id === r.field_id);
    const fallbackTitle = r.field_key || 'Captured Data';
    return {
      ...r,
      builder_questions: q || { label: fallbackTitle, qtype: 'text' },
      form_fields: q ? { ...q, field_type: q.qtype || 'text' } : { label: fallbackTitle, field_type: 'text', qtype: 'text' }
    };
  });

  return ok(res, { ...submission, form_responses: mappedResponses });
});

// GET /api/v1/admin/submissions  (supervisor+)
export const getAllSubmissions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { page, limit, from, to } = getPagination(req.query.page as string, req.query.limit as string);
  const { date, date_from, date_to, zone_id, activity_id, user_id, fe_id, outlet_id, city, city_id } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('form_submissions')
    .select(`
      id, submitted_at, is_converted, outlet_id, outlet_name, user_id, activity_id, template_id, gps, latitude, longitude, photo_url,
      users!user_id(name, employee_id, city, zone_id),
      builder_forms:builder_forms!fk_submission_template(title),
      activities(name)
    `, { count: 'exact' })
    .eq('org_id', user.org_id)
    .order('submitted_at', { ascending: false })
    .range(from, to);

  if (date) query = query.gte('submitted_at', `${date}T00:00:00`).lte('submitted_at', `${date}T23:59:59`);
  if (date_from) query = query.gte('submitted_at', `${date_from}T00:00:00`);
  if (date_to) query = query.lte('submitted_at', `${date_to}T23:59:59`);
  
  if (activity_id) query = query.eq('activity_id', activity_id);
  if (user_id || fe_id) query = query.eq('user_id', user_id || fe_id);
  if (outlet_id) query = query.eq('outlet_id', outlet_id);
  if (zone_id) query = query.eq('users.zone_id', zone_id);

  if (city) query = query.eq('users.city', city);
  if (city_id) {
    const { data: cityData } = await supabaseAdmin.from('cities').select('name').eq('id', city_id).single();
    if (cityData?.name) query = query.eq('users.city', cityData.name);
  }

  const { data, error, count } = await query;
  if (error) return badRequest(res, error.message);

  const submissions = data || [];
  const submissionIds = submissions.map(s => s.id);

  // Decoupled fetch for all responses to ensure visibility even if join fails
  const { data: allResponses } = submissionIds.length
    ? await supabaseAdmin
        .from('form_responses')
        .select('id, submission_id, value_text, value_number, value_bool, photo_url, field_key, field_id')
        .in('submission_id', submissionIds)
    : { data: [] };

  // Fetch all questions for these templates to map labels
  const templateIds = Array.from(new Set(submissions.map(s => s.template_id)));
    const { data: allQuestions } = templateIds.length
    ? await supabaseAdmin
        .from('builder_questions')
        .select('id, label, qtype, form_id')
        .in('form_id', templateIds)
    : { data: [] };

  // Map responses back to submissions with metadata
  const enriched = submissions.map((s) => {
    const sResponses = (allResponses || []).filter(r => r.submission_id === s.id);
    const mappedSResponses = sResponses.map(r => {
      const q = (allQuestions || []).find(q => q.id === r.field_id);
      const fallbackTitle = r.field_key || 'Captured Data';
      
      return {
        ...r,
        builder_questions: q || { label: fallbackTitle, qtype: 'text' },
        form_fields: q ? { 
          ...q, 
          label: q.label || fallbackTitle, 
          field_type: q.qtype || 'text' 
        } : { 
          label: fallbackTitle, 
          field_type: 'text', 
          qtype: 'text' 
        }
      };
    });

    return {
      ...s,
      form_responses: mappedSResponses,
      store_name: s.outlet_name || null,
      checkin_photo: s.photo_url || null,
      checkin_at: s.submitted_at || null,
      checkin_lat: s.latitude || null,
      checkin_lng: s.longitude || null,
    };
  });

  const result = buildPaginatedResult(enriched, count || 0, page, limit);
  return res.status(200).json({ success: true, ...result });
});

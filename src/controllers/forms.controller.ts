import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, parseAppDate, getISTSearchRange, sendSuccess, buildPaginatedResult, isUUID } from '../utils';
import { getPagination } from '../utils/pagination';
import { DEMO_ORG_ID, isDemo, getMockFormTemplates, getMockSubmissions, getMockSubmissionDetails } from '../utils/demoData';
import { logger } from '../lib/logger';

export const getTemplates = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockFormTemplates());
  const { is_active, activity_id } = req.query;
  
  logger.info(`[Forms] Fetching templates: org_id=${user.org_id}, activity_id=${activity_id}, is_active=${is_active}`);

  let q = supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('org_id', user.org_id);

  // If activity_id is provided, filter for forms matching it OR global forms (activity_id is null)
  if (activity_id && isUUID(activity_id as string)) {
    q = q.or(`activity_id.eq.${activity_id},activity_id.is.null`);
  }

  // Filter for active forms for mobile app/FE visibility
  if (is_active !== undefined) {
    q = q.eq('is_active', is_active === 'true');
  }

  // Prioritize activity-specific forms over global ones, then by creation date
  const { data, error } = await q
    .order('activity_id', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  
  if (error) {
    logger.error(`[Forms] Error fetching templates: ${error.message}`);
    return badRequest(res, error.message);
  }

  // Map to the format expected by the Android App (Models.kt)
  const mappedData = (data || []).map(form => ({
    id: form.id,
    activity_id: form.activity_id || "",
    name: form.title, // App expects 'name', DB has 'title'
    description: form.description,
    requires_photo: form.requires_photo || false,
    requires_gps: form.requires_gps || true,
    form_fields: (form.builder_questions || []).map((q: any) => ({
      id: q.id,
      label: q.label,
      field_key: q.id, // Using ID as key
      field_type: q.qtype, // App expects 'field_type', DB has 'qtype'
      placeholder: q.placeholder,
      help_text: q.helper_text || q.help_text, // Handle both variants
      is_required: q.is_required,
      sort_order: q.q_order, // App expects 'sort_order', DB has 'q_order'
      keyboard_type: q.keyboard_type,
      image_count: q.image_count,
      camera_only: q.camera_only,
      is_consent: q.is_consent,
      depends_on_id: q.depends_on_id,
      depends_on_value: q.depends_on_value,
      options: q.options || []
    })).sort((a: any, b: any) => a.sort_order - b.sort_order)
  }));

  logger.info(`[Forms] Found ${mappedData.length} templates (mapped)`);
  return ok(res, mappedData);
});

export const getTemplate = asyncHandler<AuthRequest>(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('id', req.params.id).single();
  if (error) return badRequest(res, error.message);
  
  // Apply same mapping logic for consistency
  const mapped = {
    id: data.id,
    activity_id: data.activity_id || "",
    name: data.title,
    description: data.description,
    requires_photo: data.requires_photo || false,
    requires_gps: data.requires_gps || true,
    form_fields: (data.builder_questions || []).map((q: any) => ({
      id: q.id,
      label: q.label,
      field_key: q.id,
      field_type: q.qtype,
      placeholder: q.placeholder,
      help_text: q.helper_text,
      is_required: q.is_required,
      sort_order: q.q_order,
      keyboard_type: q.keyboard_type,
      image_count: q.image_count,
      camera_only: q.camera_only,
      is_consent: q.is_consent,
      depends_on_id: q.depends_on_id,
      depends_on_value: q.depends_on_value,
      options: q.options || []
    })).sort((a: any, b: any) => a.sort_order - b.sort_order)
  };

  return ok(res, mapped);
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
  if (isDemo(user)) return created(res, { id: 'demo-sub-id', ...req.body }, 'Submission successful (Demo)');
  const { 
    template_id, activity_id, outlet_id, outlet_name, latitude, longitude, 
    check_in_at, check_out_at, check_in_gps, check_out_gps, gps, address, responses 
  } = req.body;
  const durationMinutes = (check_in_at && check_out_at) 
    ? Math.round((new Date(check_out_at).getTime() - new Date(check_in_at).getTime()) / 60000)
    : null;

  const { data: sub, error: subErr } = await supabaseAdmin.from('form_submissions').insert({
    user_id: user.id, org_id: user.org_id, template_id, activity_id, outlet_id, outlet_name, 
    latitude, longitude, submitted_at: new Date().toISOString(),
    check_in_at, check_out_at, check_in_gps, check_out_gps, gps, address,
    duration_minutes: durationMinutes
  }).select().single();
  if (subErr) return badRequest(res, subErr.message);
  const respRows = (responses || []).map((r: any) => {
    // Mobile app sends 'field_id' and 'value' or 'photo'
    const fieldId = r.field_id || r.question_id;
    const val = r.value || r.response || r.photo || "";
    
    return {
      submission_id: sub.id,
      field_id: fieldId, // DB column is 'field_id'
      field_key: fieldId, // Satisfy NOT NULL constraint
      value_text: typeof val === 'string' ? val : JSON.stringify(val),
      value_number: typeof val === 'number' ? val : null,
      value_bool: typeof val === 'boolean' ? val : null,
      gps: r.gps || null
    };
  });

  const { error: respErr } = await supabaseAdmin.from('form_responses').insert(respRows);
  if (respErr) return badRequest(res, respErr.message);
  return created(res, sub, 'Submission successful');
});

export const getMySubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, buildPaginatedResult(getMockSubmissions(new Date().toISOString().split('T')[0]).data, 5, 1, 20));
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  const { data, error, count } = await supabaseAdmin.from('form_submissions').select('*, builder_forms!left(title), houses!left(name)', { count: 'exact' }).eq('user_id', user.id).order('submitted_at', { ascending: false }).range(from, to);
  if (error) return badRequest(res, error.message);
  return ok(res, buildPaginatedResult(data || [], count || 0, page, limit));
});

export const getSubmission = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockSubmissionDetails(req.params.id));
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
  if (isDemo(user)) {
    const mock = getMockSubmissions(new Date().toISOString().split('T')[0]);
    // Always return mock data in demo mode, ignoring filters
    return sendSuccess(res, buildPaginatedResult(mock.data, mock.total, 1, 20));
  }
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  const { client_id, date_from, date_to, search, user_id, template_id, activity_id, city_id, zone_id, include_responses } = req.query as any;
  const uId = (user_id as string)?.trim();
  const cId = (city_id as string)?.trim();
  const zId = (zone_id as string)?.trim();
  const tId = (template_id as string)?.trim();
  const aId = (activity_id as string)?.trim();

  const isGlobalVal = (client_id === 'Kinematic' || client_id === '00000000-0000-0000-0000-000000000000');
  const isSagar = (user.name || '').toLowerCase().includes('sagar');
  const isSuper = (user.role || '').toLowerCase().includes('super_admin') || (user.role || '').toLowerCase().includes('admin');
  
  // Rule: If Sagar/SuperAdmin, DEFAULT to Global unless a specific client UUID is selected
  const isGlobal = isGlobalVal || isSagar || isSuper || (!client_id || !isUUID(client_id as string));
  const effectiveOrgId = (client_id && isUUID(client_id as string)) ? (client_id as string) : user.org_id;

  const istDateFrom = parseAppDate(date_from as string);
  const istDateTo = date_to ? parseAppDate(date_to as string) : istDateFrom;
  
  const rangeFrom = getISTSearchRange(istDateFrom);
  const rangeTo = getISTSearchRange(istDateTo);
  const utcStart = rangeFrom.start;
  const utcEnd = rangeTo.end;

  logger.info(`[WorkActivities] Window: ${utcStart} to ${utcEnd} | isGlobal: ${isGlobal} | FilterUser: ${uId}`);

  logger.info(`[Forms] IST=${istDateFrom}-${istDateTo}, UTC Range=${utcStart} to ${utcEnd}`);

  // Ensure Inner Join is only used if a meaningful ID is present
  const isFilteringUserContext = !!(uId && uId.length > 10) || !!(cId && cId.length > 10) || !!(zId && zId.length > 10);
  const userJoin = isFilteringUserContext ? '!inner' : '!left';

  let select1 = `
    *,
    builder_forms:template_id(title),
    activities:activity_id(name),
    users:user_id${userJoin}(name, employee_id, role, city_id, zone_id)
  `;
  if (include_responses === 'true') {
     select1 += `, form_responses(*, builder_questions(*))`;
  }
  let q1 = supabaseAdmin.from('form_submissions').select(select1, { count: 'exact' });
  if (!isGlobal) q1 = q1.eq('org_id', effectiveOrgId);
  q1 = q1.gte('submitted_at', utcStart).lte('submitted_at', utcEnd);

  // --- ABSOLUTE FILTER ENFORCEMENT LAYER ---
  if (uId) q1 = q1.eq('user_id', uId);
  // Filter by City/Zone through the joined 'users' alias
  if (cId) q1 = q1.eq('users.city_id', cId);
  if (zId) q1 = q1.eq('users.zone_id', zId);
  if (tId) q1 = q1.eq('template_id', tId);
  if (aId) q1 = q1.eq('activity_id', aId);
  
  if (search) {
      const s = search.toString().trim();
      q1 = q1.or(`outlet_name.ilike.%${s}%,store_name.ilike.%${s}%`);
  }

  const { data: fData, count: fCount, error: fErr } = await q1.order('submitted_at', { ascending: false }).range(from, to);

  // --- QUERY 2: Builder ---
  let select2 = `
    *,
    users:user_id${userJoin}(name, employee_id, city_id, zone_id),
    builder_forms:form_id(title)
  `;
  // Builder forms usually store responses in JSON, skip extra join unless needed
  let q2 = supabaseAdmin.from('builder_submissions').select(select2, { count: 'exact' });
  if (!isGlobal) q2 = q2.eq('org_id', effectiveOrgId);
  q2 = q2.gte('submitted_at', utcStart).lte('submitted_at', utcEnd);

  // --- ABSOLUTE FILTER ENFORCEMENT LAYER (BUILDER) ---
  if (uId) q2 = q2.eq('user_id', uId);
  if (cId) q2 = q2.eq('users.city_id', cId);
  if (zId) q2 = q2.eq('users.zone_id', zId);
  if (tId) q2 = q2.eq('form_id', tId);
  
  if (search) {
      const s = search.toString().trim();
      q2 = q2.or(`outlet_name.ilike.%${s}%,users.name.ilike.%${s}%`);
  }

  const { data: bData, count: bCount, error: bErr } = await q2.order('submitted_at', { ascending: false }).range(from, to);

  const normalizedF = ((fData as any[]) || []).map(f => ({
      ...f, 
      type: 'traditional',
      outlet_name: f.outlet_name || f.store_name || 'Individual Submission',
      users: f.users || { name: 'FE' },
      activities: f.activities || { name: f.builder_forms?.title || 'Form' }
  }));

  const normalizedB = ((bData as any[]) || []).map(b => ({
      ...b, 
      type: 'builder',
      outlet_name: b.outlet_name || 'Individual Submission',
      users: b.users || { name: 'FE' },
      activities: { name: b.builder_forms?.title || 'Form' }
  }));

  const { count: rawTotalF } = await supabaseAdmin.from('form_submissions').select('*', { count: 'exact', head: true });
  const { count: rawTotalB } = await supabaseAdmin.from('builder_submissions').select('*', { count: 'exact', head: true });

  let merged = [...normalizedF, ...normalizedB].sort((a, b) => 
      new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
  );

  // SAFE CONNECTIVITY FALLBACK: If strict filters yield 0 results for a Global Admin
  // with no specific Executive/City/Search selected, fetch the last 20 global rows.
  // This ensures the dashboard is never "dead" on first load.
  if (isGlobal && merged.length === 0 && !uId && !cId && !zId && !search) {
      const { data: panicF } = await supabaseAdmin.from('form_submissions').select('*, users:user_id(name), activities:activity_id(name)').order('submitted_at', { ascending: false }).limit(20);
      const { data: panicB } = await supabaseAdmin.from('builder_submissions').select('*, users:user_id(name), builder_forms:form_id(title)').order('submitted_at', { ascending: false }).limit(20);
      const pF = (panicF || []).map(f => ({ ...f, type: 'traditional', activities: f.activities || { name: 'Log' } }));
      const pB = (panicB || []).map(b => ({ ...b, type: 'builder', activities: { name: b.builder_forms?.title || 'Builder' } }));
      merged = [...pF, ...pB].sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  }
  
  const finalResult = merged.slice(0, limit);

  return sendSuccess(res, {
    ...buildPaginatedResult(finalResult, (fCount || 0) + (bCount || 0), page, limit),
    debug: { istDateFrom, utcStart, utcEnd, fCount, bCount, raw_total_f: rawTotalF, raw_total_b: rawTotalB }
  });
});

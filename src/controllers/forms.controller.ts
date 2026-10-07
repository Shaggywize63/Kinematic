import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { clientHasFlag } from '../lib/clientFlags';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, parseAppDate, getISTSearchRange, sendSuccess, buildPaginatedResult, isUUID, sanitisePostgrestSearch } from '../utils';
import { getPagination } from '../utils/pagination';
import { DEMO_ORG_ID, isDemo, getMockFormTemplates, getMockSubmissions, getMockSubmissionDetails } from '../utils/demoData';
import { logger } from '../lib/logger';
import { mirrorCheckinToRoutePlan } from '../services/routePlanCheckin.service';
import { fieldForceScopeIds } from '../services/supervisor-scope.service';

/** Parse a "lat,lng" GPS string (the mobile check_in_gps field) to a coord pair. */
function parseGps(s: unknown): { lat: number; lng: number } | null {
  if (typeof s !== 'string') return null;
  const [a, b] = s.split(',').map((p) => Number(p.trim()));
  return Number.isFinite(a) && Number.isFinite(b) ? { lat: a, lng: b } : null;
}

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

  // Filter for live forms for mobile app / FE visibility. NOTE: builder_forms
  // has NO `is_active` column — the lifecycle column is `status`
  // (draft / published / archived). The app sends ?is_active=true to mean
  // "only live forms", so map it to status. Querying the non-existent column
  // 400'd ("column builder_forms.is_active does not exist") and silently hid
  // EVERY published form from the app (iOS always sends is_active=true).
  if (is_active !== undefined) {
    q = is_active === 'true' ? q.eq('status', 'published') : q.neq('status', 'published');
  } else {
    // The Android app sends no is_active filter, so without this it lists EVERY form —
    // including ones an admin has archived (retired) in the builder — and reps keep filling
    // in the retired copy. Archived forms are only returned when asked for explicitly
    // (?is_active=false); drafts are still returned, as before.
    q = q.neq('status', 'archived');
  }

  // Prioritize activity-specific forms over global ones, then by creation date
  const { data, error } = await q
    .order('activity_id', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  
  if (error) {
    logger.error(`[Forms] Error fetching templates: ${error.message}`);
    return badRequest(res, error.message);
  }

  // Resolve human-readable activity names so clients can group forms by activity
  // (the ByteBack ad-hoc "New" flow shows an activity picker first, then that
  // activity's forms). Look up only the activity ids present on the results.
  const activityIds = Array.from(new Set((data || []).map((f: any) => f.activity_id).filter(Boolean))) as string[];
  const activityNameById = new Map<string, string>();
  if (activityIds.length) {
    const { data: acts } = await supabaseAdmin.from('activities').select('id, name').in('id', activityIds);
    for (const a of (acts || []) as Array<{ id: string; name: string | null }>) {
      if (a.name) activityNameById.set(a.id, a.name);
    }
  }

  // Map to the format expected by the Android App (Models.kt)
  const mappedData = (data || []).map(form => ({
    id: form.id,
    activity_id: form.activity_id || "",
    activity_name: form.activity_id ? (activityNameById.get(form.activity_id) || null) : null,
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
  // Optional geo-gate: tenants that require every submission to be geo-stamped
  // set the client flag `require_location_for_forms`. Default OFF, so existing
  // tenants keep submitting exactly as before. When ON and no fix is attached,
  // reject with the same machine-readable code the apps use to prompt the rep
  // to turn location on. (The mobile apps prompt for location before submit
  // regardless; this is the server-side enforcement for the strict tenants.)
  if ((user as { client_id?: string | null }).client_id
      && (latitude == null || longitude == null)
      && await clientHasFlag((user as { client_id?: string | null }).client_id!, 'require_location_for_forms')) {
    return badRequest(res, 'Turn on location to submit this form.', { code: 'LOCATION_REQUIRED' });
  }

  // Enforce 10-digit mobile numbers for every `phone`-type field. The builder's
  // "Phone" field type means an Indian 10-digit mobile (matching the lead/user
  // mobile rule in crm.validators.ts, /^\d{10}$/). Clients that don't cap the
  // input otherwise let 11+ digit numbers through — observed: a Gold Scheme
  // Registration "Phone Number" captured as 11 digits (83108384652). This is the
  // authoritative, client-agnostic guard; strip any formatting, require exactly
  // 10 digits, and store the normalized value. Runs before any row is written so
  // a bad submission leaves nothing behind.
  if (template_id && Array.isArray(responses) && responses.length) {
    const { data: phoneQs } = await supabaseAdmin
      .from('builder_questions')
      .select('id, label')
      .eq('form_id', template_id)
      .eq('qtype', 'phone');
    const phoneFields = new Map<string, string>(
      (phoneQs || []).map((q: any) => [String(q.id), (q.label as string) || 'Phone number']),
    );
    if (phoneFields.size) {
      for (const r of responses) {
        const fieldId = String(r.field_id ?? r.question_id ?? '');
        if (!phoneFields.has(fieldId)) continue;
        const raw = r.value ?? r.response;
        if (raw == null || String(raw).trim() === '') continue; // empty: required-ness handled by the form itself
        let digits = String(raw).replace(/\D/g, '');
        // Normalize the common Indian mobile formats reps actually type BEFORE
        // validating — these are valid numbers, not errors, and hard-rejecting
        // them was blocking real submissions (e.g. a Gold Scheme rep who entered
        // the number with +91). Strip a country code (+91 → 12 digits, 0091 → 13)
        // or a trunk 0 (11 digits) down to the 10-digit subscriber number; only a
        // genuinely wrong length is still rejected.
        if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
        else if (digits.length === 13 && digits.startsWith('091')) digits = digits.slice(3);
        else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
        if (digits.length !== 10) {
          return badRequest(
            res,
            `${phoneFields.get(fieldId)} must be a 10-digit mobile number.`,
            { code: 'INVALID_PHONE', field_id: fieldId },
          );
        }
        // Store the normalized 10 digits (drop any country code / formatting).
        r.value = digits;
      }
    }
  }

  const durationMinutes = (check_in_at && check_out_at)
    ? Math.round((new Date(check_out_at).getTime() - new Date(check_in_at).getTime()) / 60000)
    : null;

  // Stamp the submitter's client_id so the per-client picker on the
  // dashboard scopes correctly. Org-level admins (no JWT client_id) fall
  // back to NULL which keeps the row visible to every picker selection.
  const submitterClientId = (user as { client_id?: string | null }).client_id ?? null;

  const { data: sub, error: subErr } = await supabaseAdmin.from('form_submissions').insert({
    user_id: user.id, org_id: user.org_id, client_id: submitterClientId,
    template_id, activity_id, outlet_id, outlet_name,
    latitude, longitude, submitted_at: new Date().toISOString(),
    check_in_at, check_out_at, check_in_gps, check_out_gps, gps, address,
    duration_minutes: durationMinutes
  }).select().single();
  if (subErr) return badRequest(res, subErr.message);
  const respRows = (responses || []).map((r: any) => {
    // Mobile app sends 'field_id' and either 'value' (text/number/bool
    // typed answers) or 'photo' (comma-joined image URLs). Previously
    // the controller collapsed both into a single `val` and stored the
    // photo URL in `value_text`, leaving the dedicated `photo_url`
    // column empty — which is why the dashboard's modal rendered text
    // for image fields and didn't show the captured images. Split them
    // out so image fields land in `photo_url` where the FE looks.
    const fieldId = r.field_id || r.question_id;
    const photoVal: string | null = (typeof r.photo === 'string' && r.photo.length > 0) ? r.photo : null;
    const rawVal: unknown = r.value ?? r.response ?? null;
    const textVal = typeof rawVal === 'string' ? rawVal
      : (rawVal == null ? "" : JSON.stringify(rawVal));

    return {
      submission_id: sub.id,
      field_id: fieldId, // DB column is 'field_id'
      field_key: fieldId, // Satisfy NOT NULL constraint
      value_text: textVal,
      value_number: typeof rawVal === 'number' ? rawVal : null,
      value_bool: typeof rawVal === 'boolean' ? rawVal : null,
      photo_url: photoVal,
      gps: r.gps || null
    };
  });

  const { error: respErr } = await supabaseAdmin.from('form_responses').insert(respRows);
  if (respErr) return badRequest(res, respErr.message);

  // Mirror this check-in onto the rep's matching planned route outlet so the
  // route_deviation feature has data — a form submission lands in
  // form_submissions, never in the route_plan_outlets row the deviation
  // scan/view read. Coords come from latitude/longitude, else the mobile
  // check_in_gps "lat,lng" string. Best-effort; never fails the submission.
  const ci = (latitude != null && longitude != null)
    ? { lat: Number(latitude), lng: Number(longitude) }
    : (parseGps(check_in_gps) ?? parseGps(gps));
  if (outlet_id && ci) {
    await mirrorCheckinToRoutePlan({ userId: user.id, storeId: outlet_id, lat: ci.lat, lng: ci.lng });
  }

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
    const today = new Date().toISOString().split('T')[0];
    const mock = getMockSubmissions(today);
    // Return all mock data in demo mode, ignoring date/user filters
    return sendSuccess(res, buildPaginatedResult(mock.data, mock.data.length, 1, 50));
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
  const role = (user.role || '').toLowerCase();
  // A CLIENT-BOUND user (client_id pinned in the JWT, e.g. ByteBack's sub_admins)
  // is NEVER cross-org — it is scoped to its own org. Previously isSuper was
  // `role.includes('admin')`, which matched 'sub_admin', so a client admin was
  // treated as global and saw EVERY org's submissions: other tenants' / demo
  // rows leaked into a single tenant's Work Activities as "mock" entries. Grant
  // the cross-org (global) view only to the platform tier (super_admin / the
  // platform owner), and never when the caller is client-bound.
  const isClientBound = isUUID((user as any).client_id);
  const isSuper = !isClientBound && (role === 'super_admin' || role === 'admin' || role === 'main_admin' || role === 'master_admin');

  // Resolve the selected client from the JWT (pinned), an explicit ?client_id=
  // query param, or the X-Client-Id header the dashboard auto-attaches for its
  // global client picker. Reading the header here closes a cross-tenant leak:
  // when a platform admin "acting as a client" sent the scope only as a header,
  // this endpoint never saw it, stayed global, and returned EVERY org's rows.
  const headerClientId = req.headers['x-client-id'] as string | undefined;
  const pickedClientId = isClientBound
    ? ((user as any).client_id as string)
    // A real X-Client-Id header pins a specific client and MUST win over the
    // picker's "All clients" (Kinematic) sentinel: a super-admin "acting as a
    // client" sets this header, and while the picker still reads "All clients"
    // the page sends client_id=Kinematic — which previously flipped the request
    // global and leaked every org's submissions. The header is authoritative.
    : isUUID(headerClientId as string) ? (headerClientId as string)
    : (isUUID(client_id as string) && !isGlobalVal) ? (client_id as string)
    : null;

  // Cross-org (global) view is for the platform tier ONLY, and ONLY when no
  // specific client is selected. The moment a client is picked (JWT / query /
  // header) the request is scoped to that client — a super_admin acting as a
  // client must never see other tenants' submissions.
  const isGlobal = !isClientBound && (isSuper || isSagar) && !pickedClientId;

  // The org every query is scoped to. Client-bound / org-scoped callers use
  // their own org. A platform admin who picked a client is scoped to THAT
  // client's org (resolved from the clients table) — essential for
  // builder_submissions, which carry only org_id and no client_id. A truly
  // global platform admin gets no org filter (the intended cross-tenant view).
  let scopeOrgId: string | null = isGlobal ? null : (user.org_id ?? null);
  if (!isClientBound && pickedClientId) {
    const { data: pickedClient } = await supabaseAdmin
      .from('clients').select('org_id').eq('id', pickedClientId).maybeSingle();
    const pickedOrg = (pickedClient as { org_id?: string } | null)?.org_id;
    if (pickedOrg) scopeOrgId = pickedOrg;
  }

  const istDateFrom = parseAppDate(date_from as string);
  const istDateTo = date_to ? parseAppDate(date_to as string) : istDateFrom;
  
  const rangeFrom = getISTSearchRange(istDateFrom);
  const rangeTo = getISTSearchRange(istDateTo);
  const utcStart = rangeFrom.start;
  const utcEnd = rangeTo.end;

  // Supervisor-hierarchy scoping (opt-in per client): a team manager sees only
  // submissions from field reps in their supervisor subtree. null = no
  // restriction (every other tenant, the master, and data_scope='all').
  const scopeIds = await fieldForceScopeIds(req);

  logger.info(`[WorkActivities] Window: ${utcStart} to ${utcEnd} | isGlobal: ${isGlobal} | FilterUser: ${uId}`);

  logger.info(`[Forms] IST=${istDateFrom}-${istDateTo}, UTC Range=${utcStart} to ${utcEnd}`);

  // Ensure Inner Join is only used if a meaningful ID is present
  const isFilteringUserContext = !!(uId && uId.length > 10) || !!(cId && cId.length > 10) || !!(zId && zId.length > 10);
  const userJoin = isFilteringUserContext ? '!inner' : '!left';

  // The dashboard sends a city UUID as ?city_id=, but the users table stores the
  // city as a NAME in users.city — there is NO users.city_id column. Embedding or
  // filtering users.city_id made PostgREST 400 the whole query (42703), so Work
  // Activities showed nothing. Resolve the id to a name and filter users.city by
  // name, mirroring getLiveLocations.
  let cityName: string | null = null;
  if (cId) {
    const { data: cityRow } = await supabaseAdmin.from('cities').select('name').eq('id', cId).maybeSingle();
    cityName = (cityRow as { name?: string } | null)?.name ?? null;
  }

  let select1 = `
    *,
    builder_forms:template_id(title),
    activities:activity_id(name),
    users:user_id${userJoin}(name, employee_id, role, city, zone_id)
  `;
  if (include_responses === 'true') {
     select1 += `, form_responses(*, builder_questions(*))`;
  }
  let q1 = supabaseAdmin.from('form_submissions').select(select1, { count: 'exact' });
  // Non-global callers (org-scoped admins / supervisors) only see rows in
  // their own org. Super admins / Sagar skip this.
  if (scopeOrgId) q1 = q1.eq('org_id', scopeOrgId);
  // Client picker narrows to a specific sub-tenant, but still surfaces
  // rows with NULL client_id (org-level submissions that predate the
  // client_id stamping, or were submitted by org-level reps). Without
  // this, the picker-selected view appears empty even though data
  // exists — that was the symptom the user just reported.
  if (pickedClientId) q1 = q1.or(`client_id.is.null,client_id.eq.${pickedClientId}`);
  q1 = q1.gte('submitted_at', utcStart).lte('submitted_at', utcEnd);

  // --- ABSOLUTE FILTER ENFORCEMENT LAYER ---
  if (scopeIds) q1 = q1.in('user_id', scopeIds);
  if (uId) q1 = q1.eq('user_id', uId);
  // Filter by City/Zone through the joined 'users' alias (users.city is a name).
  if (cityName) q1 = q1.eq('users.city', cityName);
  if (zId) q1 = q1.eq('users.zone_id', zId);
  if (tId) q1 = q1.eq('template_id', tId);
  if (aId) q1 = q1.eq('activity_id', aId);
  
  if (search) {
      // sanitisePostgrestSearch strips PostgREST OR-filter syntax
      // (commas/parens/quotes) AND ilike wildcards so the user input
      // is treated as a literal substring and can't smuggle extra
      // predicates into the OR clause (e.g. `,user_id.eq.<other>`).
      const s = sanitisePostgrestSearch(search);
      if (s) q1 = q1.or(`outlet_name.ilike.%${s}%,store_name.ilike.%${s}%`);
  }

  const { data: fData, count: fCount, error: fErr } = await q1.order('submitted_at', { ascending: false }).range(from, to);

  // --- QUERY 2: Builder ---
  let select2 = `
    *,
    users:user_id${userJoin}(name, employee_id, city, zone_id),
    builder_forms:form_id(title)
  `;
  // Builder forms usually store responses in JSON, skip extra join unless needed
  let q2 = supabaseAdmin.from('builder_submissions').select(select2, { count: 'exact' });
  if (scopeOrgId) q2 = q2.eq('org_id', scopeOrgId);
  // builder_submissions doesn't carry a client_id column yet; org-level
  // builder rows are visible to every picker selection by default. If
  // and when a client_id column is added, mirror the q1 OR-filter here.
  q2 = q2.gte('submitted_at', utcStart).lte('submitted_at', utcEnd);

  // --- ABSOLUTE FILTER ENFORCEMENT LAYER (BUILDER) ---
  if (scopeIds) q2 = q2.in('user_id', scopeIds);
  if (uId) q2 = q2.eq('user_id', uId);
  if (cityName) q2 = q2.eq('users.city', cityName);
  if (zId) q2 = q2.eq('users.zone_id', zId);
  if (tId) q2 = q2.eq('form_id', tId);
  
  if (search) {
      const s = sanitisePostgrestSearch(search);
      if (s) q2 = q2.or(`outlet_name.ilike.%${s}%,users.name.ilike.%${s}%`);
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

import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { clientHasFlag } from '../lib/clientFlags';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, parseAppDate, getISTSearchRange, sendSuccess, buildPaginatedResult, isUUID, sanitisePostgrestSearch } from '../utils';
import { getPagination } from '../utils/pagination';
import { DEMO_ORG_ID, isDemo, getMockFormTemplates, getMockSubmissions, getMockSubmissionDetails } from '../utils/demoData';
import { logger } from '../lib/logger';
import { mirrorCheckinToRoutePlan } from '../services/routePlanCheckin.service';
import * as crud from '../services/crm/crud.service';
import { fieldForceScopeIds } from '../services/supervisor-scope.service';
import { withVisitFields } from '../services/formVisit.service';
import { reverseGeocode } from '../services/crm/places.service';
import { resolveVisitTimes } from '../services/formVisit.store';
import { scanCard, CardMediaType } from '../services/crm/ai/cardScan.service';
import { resolveTenantScope, callerMayReadOrg, enforcedUnlessOff } from '../lib/tenantScope';
import { orgRowReachable } from '../lib/userGuard';
import { isTenantAdmin } from '../middleware/auth';

/** Parse a "lat,lng" GPS string (the mobile check_in_gps field) to a coord pair. */
function parseGps(s: unknown): { lat: number; lng: number } | null {
  if (typeof s !== 'string') return null;
  const [a, b] = s.split(',').map((p) => Number(p.trim()));
  return Number.isFinite(a) && Number.isFinite(b) ? { lat: a, lng: b } : null;
}

// Normalise a builder question's `options` to an array of {label, value} objects.
//
// `builder_questions.options` is jsonb and has been written in two shapes over
// time: bare string arrays (e.g. ["Nitrile","Plastic","Other"]) and object
// arrays ([{label,value}]). iOS and the web dashboard both tolerate the string
// form, but the Android app decodes `options` as List<FormOption> (a
// {label,value} object) with plain Gson and no custom adapter — a bare string
// cannot map onto that object, so Gson throws and the ENTIRE /forms/templates
// response fails to parse. The symptom is Android-only "Couldn't load your
// forms" even though the HTTP response is 200, and it takes down every form in
// the list, not just the one with string options. Normalising here fixes all
// Android users for all forms with no app release and no data migration, and is
// backward-compatible (iOS/web already handle objects).
function normalizeOptions(raw: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const o of raw) {
    if (o == null) continue;
    if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') {
      const s = String(o);
      out.push({ label: s, value: s });
    } else if (typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const label = rec.label ?? rec.value ?? rec.text ?? rec.name;
      const value = rec.value ?? rec.label ?? rec.text ?? rec.name;
      if (label == null && value == null) continue;
      out.push({ label: String(label ?? value), value: String(value ?? label) });
    }
  }
  return out;
}

/** Rajkamal Jewellers client id — mirrors the apps/dashboard isRajkamal gate. */
const RAJKAMAL_CLIENT_ID = '0490f34d-d9a3-4f39-99e2-8f3adba8c583';

// Clients for which a form's "follow-up date" field auto-creates a planned
// crm_activities reminder (which then flows to the calendar + Google + push).
// Rajkamal is always included (original behaviour); add more client UUIDs via
// FORM_FOLLOWUP_ACTIVITY_CLIENT_IDS (comma-separated) — e.g. the Spark & Ray
// client. Kept as a lowercase Set so the submit path needs no DB lookup.
const FOLLOWUP_ACTIVITY_CLIENT_IDS = new Set<string>(
  [RAJKAMAL_CLIENT_ID, ...(process.env.FORM_FOLLOWUP_ACTIVITY_CLIENT_IDS || '').split(',')]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** A form date field counts as a follow-up date when its label reads like one. */
const FOLLOWUP_LABEL_RE = /follow[\s-]?up|preferred\s+date/i;

export const getTemplates = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockFormTemplates());
  const { is_active, activity_id } = req.query;
  
  logger.info(`[Forms] Fetching templates: org_id=${user.org_id}, activity_id=${activity_id}, is_active=${is_active}`);

  let q = supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('org_id', user.org_id);

  // Per-client isolation (mirrors the builder GET /forms filter): a caller sees
  // org-shared forms (client_id IS NULL) plus any scoped to their own client.
  // Mobile reps carry client_id on their JWT, so a client-scoped form (e.g. the
  // DVGPL Retailer Survey) reaches only that client's apps. Platform admins with
  // no client scope (targetCid null) see every form. Combined with the activity
  // filter below as AND, so a form must be both in scope and match the activity.
  const headerClientId = (req.headers?.['x-client-id'] as string | undefined) || undefined;
  const targetCid: string | null = isUUID(user.client_id) ? (user.client_id as string)
    : isUUID(req.query.client_id as string) ? (req.query.client_id as string)
    : isUUID(headerClientId) ? (headerClientId as string)
    : null;
  if (targetCid) q = q.or(`client_id.is.null,client_id.eq.${targetCid}`);

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
      options: normalizeOptions(q.options),
      // Builder validation rules (e.g. a rating's "Max Stars" = validation.max, min/max length).
      // Additive: older app builds ignore the unknown key.
      validation: q.validation || {}
    })).sort((a: any, b: any) => a.sort_order - b.sort_order)
  }));

  logger.info(`[Forms] Found ${mappedData.length} templates (mapped)`);
  return ok(res, mappedData);
});

export const getTemplate = asyncHandler<AuthRequest>(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('builder_forms').select('*, builder_questions(*)').eq('id', req.params.id).single();
  if (error) return badRequest(res, error.message);
  // Another org's form: a 404 (BUILDER_ORG_ENFORCE=off only logs it) in case a tenant fills in a form
  // that one of its sibling orgs owns.
  if (!orgRowReachable(req.user, data.org_id)) {
    const deny = enforcedUnlessOff('BUILDER_ORG_ENFORCE');
    logger.warn(`[authz-${deny ? 'deny' : 'shadow'}] getTemplate: actor=${req.user?.id} org=${req.user?.org_id} form=${data.id} formOrg=${data.org_id}`);
    if (deny) return notFound(res, 'Form not found');
  }

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
      options: normalizeOptions(q.options)
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

/**
 * Business-card OCR for the Form Builder's `card_scan` field. The apps capture
 * a photo of the customer's visiting card, downscale it, and POST the base64;
 * we return structured contact fields so the form can auto-fill its Contact
 * section (name / designation / phone / email / company).
 *
 * Lives on the /forms mount (auth-only) rather than /crm/ai/scan-card, so a
 * field rep who fills surveys but has no CRM module can still scan a card.
 * Thin wrapper over the same single-shot vision helper CRM lead capture uses.
 */
export const scanBusinessCard = asyncHandler<AuthRequest>(async (req, res) => {
  const { image_base64, media_type } = req.body as { image_base64?: unknown; media_type?: unknown };
  if (typeof image_base64 !== 'string' || image_base64.length < 100) {
    return badRequest(res, 'image_base64 (base64-encoded card photo) is required');
  }
  const mt: CardMediaType = (media_type === 'image/png' || media_type === 'image/webp') ? media_type : 'image/jpeg';
  const fields = await scanCard(image_base64, mt);
  return ok(res, fields);
});

export const submitForm = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-sub-id', ...req.body }, 'Submission successful (Demo)');
  const {
    template_id, activity_id, outlet_id, outlet_name, latitude, longitude,
    check_in_at, check_out_at, check_in_gps, check_out_gps, gps, address, responses,
    // CRM visit links (optional; stamped by the field app's visit flow). Old
    // app builds send none, so these fall back to null — fully backward-compatible.
    account_id, site_id, contact_id, deal_id, visit_id
  } = req.body;
  const isUuid = (x: unknown): x is string => typeof x === 'string' && isUUID(x);
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

  // A `company`-type field links the whole submission to a CRM account. When the
  // visit flow didn't already stamp a top-level account_id, adopt the account the
  // rep picked in that field so Form Activity shows the company. The field stores
  // the account UUID as its value; mirrors the phone pre-scan above.
  let effectiveAccountId: unknown = account_id;
  if (!isUuid(effectiveAccountId) && template_id && Array.isArray(responses) && responses.length) {
    const { data: companyQs } = await supabaseAdmin
      .from('builder_questions')
      .select('id')
      .eq('form_id', template_id)
      .eq('qtype', 'company');
    const companyFields = new Set<string>((companyQs || []).map((q: any) => String(q.id)));
    if (companyFields.size) {
      for (const r of responses) {
        const fieldId = String(r.field_id ?? r.question_id ?? '');
        if (!companyFields.has(fieldId)) continue;
        const raw = r.value ?? r.response;
        if (isUuid(raw)) { effectiveAccountId = raw; break; }
      }
    }
  }

  // Stamp the submitter's client_id so the per-client picker on the
  // dashboard scopes correctly. Org-level admins (no JWT client_id) fall
  // back to NULL which keeps the row visible to every picker selection.
  const submitterClientId = (user as { client_id?: string | null }).client_id ?? null;

  // Visit times are sanitised, never rejected (old app builds keep working): a bad timestamp becomes
  // null, a future one is clamped to server time, and a check-in with no check-out is closed at
  // server time for clients whose `form_checkin_required` rule is on. See formVisit.service.ts.
  const visit = await resolveVisitTimes(submitterClientId, { check_in_at, check_out_at });

  // Stamp WHERE the form was submitted. The apps send coordinates but usually
  // not a resolved address, so when a fix is present and no address was supplied
  // we reverse-geocode server-side — every submission then carries a place name
  // for all clients with no app update. Best-effort: a lookup miss (no key /
  // Geocoding API off / no result) just leaves the address null, never fails the
  // submission.
  let resolvedAddress: string | null = (typeof address === 'string' && address.trim()) ? address.trim() : null;
  if (!resolvedAddress && latitude != null && longitude != null) {
    resolvedAddress = await reverseGeocode(Number(latitude), Number(longitude));
  }

  const { data: sub, error: subErr } = await supabaseAdmin.from('form_submissions').insert({
    user_id: user.id, org_id: user.org_id, client_id: submitterClientId,
    template_id, activity_id, outlet_id, outlet_name,
    latitude, longitude, submitted_at: new Date().toISOString(),
    check_in_at: visit.check_in_at, check_out_at: visit.check_out_at, check_in_gps, check_out_gps, gps, address: resolvedAddress,
    duration_minutes: visit.duration_minutes,
    // CRM visit links — only persist valid UUIDs so a malformed value never
    // fails the submission (the field stays null, matching old-app behaviour).
    account_id: isUuid(effectiveAccountId) ? effectiveAccountId : null,
    site_id: isUuid(site_id) ? site_id : null,
    contact_id: isUuid(contact_id) ? contact_id : null,
    deal_id: isUuid(deal_id) ? deal_id : null,
    visit_id: isUuid(visit_id) ? visit_id : null,
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

  // Rajkamal: a form with a "follow-up date" field schedules a reminder for the
  // rep on that day. We materialise it as a planned crm_activities row with
  // due_at = 09:00 IST on the chosen date; the activityReminders cron then pushes
  // the submitter (FCM/APNs + in-app bell) the morning it comes due — the same
  // mechanism Schedule-Visit and the marketing-visit follow-up already use.
  // form_submissions has no lead_id, so the reminder is addressed to the
  // submitting rep (assigned_to). Best-effort: a failure never fails the submit.
  // Enabled for Rajkamal (original) plus any client id in
  // FORM_FOLLOWUP_ACTIVITY_CLIENT_IDS (Spark & Ray etc.). A pure in-memory set
  // check — no DB round-trip per submit — so other tenants' date fields never
  // start spawning activities and the submit path stays as lean as before.
  if (submitterClientId && FOLLOWUP_ACTIVITY_CLIENT_IDS.has(submitterClientId.toLowerCase())
      && template_id && Array.isArray(responses) && responses.length) {
    try {
      const { data: dateQs } = await supabaseAdmin
        .from('builder_questions')
        .select('id, label')
        .eq('form_id', template_id)
        .eq('qtype', 'date');
      const followupField = (dateQs || []).find((q: any) => FOLLOWUP_LABEL_RE.test(String(q.label || '')));
      if (followupField) {
        const ans = (responses as any[]).find(
          (r) => String(r.field_id ?? r.question_id ?? '') === String(followupField.id),
        );
        const raw = ans?.value ?? ans?.response;
        const dateStr = typeof raw === 'string' ? raw.trim().slice(0, 10) : '';
        // Only a real yyyy-MM-dd on or after today (IST) becomes a reminder — a
        // blank or past date is ignored so we don't create stale/overdue nags.
        const todayIST = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr >= todayIST) {
          const due = new Date(`${dateStr}T09:00:00+05:30`);
          if (!Number.isNaN(due.getTime())) {
            const { data: tmpl } = await supabaseAdmin
              .from('builder_forms').select('title').eq('id', template_id).single();
            const subject = `Follow-up: ${(tmpl?.title as string) || outlet_name || 'contact'}`;
            // crud.create injects org_id + created_by; 'planned' keeps it open so
            // activityReminders picks it up (it skips done/cancelled).
            await crud.create('crm_activities', user.org_id, {
              client_id: submitterClientId,
              type: 'task',
              subject,
              status: 'planned',
              owner_id: user.id,
              assigned_to: user.id,
              due_at: due.toISOString(),
              // Link to the visit's CRM records (when the field app stamped them)
              // so the follow-up shows on the account/deal timeline + calendar and
              // syncs to Google Calendar, not just as a standalone rep reminder.
              account_id: isUuid(account_id) ? account_id : null,
              contact_id: isUuid(contact_id) ? contact_id : null,
              deal_id: isUuid(deal_id) ? deal_id : null,
              site_id: isUuid(site_id) ? site_id : null,
              metadata: { kind: 'form_followup', source_submission_id: sub.id, field_label: followupField.label ?? null },
            }, user.id);
          }
        }
      }
    } catch (e: any) {
      logger.warn(`[forms.submit] follow-up reminder skipped: ${e?.message || e}`);
    }
  }

  return created(res, sub, 'Submission successful');
});

export const getMySubmissions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, buildPaginatedResult(getMockSubmissions(new Date().toISOString().split('T')[0]).data, 5, 1, 20));
  const { page, limit, from, to } = getPagination(req.query.page as any, req.query.limit as any);
  const { data, error, count } = await supabaseAdmin.from('form_submissions').select('*, builder_forms:template_id(title)', { count: 'exact' }).eq('user_id', user.id).order('submitted_at', { ascending: false }).range(from, to);
  if (error) return badRequest(res, error.message);
  return ok(res, buildPaginatedResult(data || [], count || 0, page, limit));
});

export const getSubmission = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockSubmissionDetails(req.params.id));
  const { id } = req.params;
  const { data: sub } = await supabaseAdmin.from('form_submissions').select('*, builder_forms(title), activities(name), crm_accounts(name)').eq('id', id).single();
  // One org's rows only, on every project: a submission id from another org is a 404, not a read.
  if (sub && (sub as { user_id?: string }).user_id !== user.id && !callerMayReadOrg(user, (sub as { org_id?: string | null }).org_id)) return notFound(res);
  if (sub) {
    const { data: resp } = await supabaseAdmin.from('form_responses').select('*, builder_questions(*)').eq('submission_id', id);
    return ok(res, { ...sub, form_responses: resp || [] });
  }
  const { data: bSub } = await supabaseAdmin.from('builder_submissions').select('*, builder_forms(title), users(name)').eq('id', id).single();
  if (bSub && (bSub as { user_id?: string }).user_id !== user.id && !callerMayReadOrg(user, (bSub as { org_id?: string | null }).org_id)) return notFound(res);
  if (bSub) return ok(res, { ...bSub, activities: { name: bSub.builder_forms?.title }, form_responses: bSub.responses || [] });
  return notFound(res);
});

// Admin edit of a submitted report. A TENANT ADMIN (isTenantAdmin) may edit any
// submission in their org; the submitting rep may edit their own. Edits the
// answers (form_responses) and a couple of submission scalars (outlet_name /
// address), stamps updated_by/updated_at, and writes one form_submission_history
// row per changed field so every change is auditable.
export const updateSubmission = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, ...req.body });
  const { id } = req.params;
  if (!isUUID(id)) return badRequest(res, 'Invalid submission id');

  const { data: sub } = await supabaseAdmin.from('form_submissions').select('*').eq('id', id).single();
  if (!sub) return notFound(res, 'Submission not found');

  const isOwner = (sub as { user_id?: string }).user_id === user.id;
  const sameOrg = callerMayReadOrg(user, (sub as { org_id?: string | null }).org_id);
  // Cross-org / cross-user without admin rights: 404 (don't reveal the row).
  if (!sameOrg && !isOwner) return notFound(res);
  // In-org but neither admin nor the submitter → forbidden.
  if (!isTenantAdmin(user) && !isOwner) {
    return res.status(403).json({ success: false, error: 'Only an admin or the submitting rep can edit this report.', code: 'FORBIDDEN' });
  }

  const body = req.body as {
    responses?: Array<{ field_id?: string; question_id?: string; value?: unknown; photo?: unknown; gps?: string | null }>;
    outlet_name?: string | null;
    address?: string | null;
  };
  const orgIdVal = (sub as { org_id?: string | null }).org_id ?? user.org_id;
  const clientIdVal = (sub as { client_id?: string | null }).client_id ?? null;
  const history: Array<Record<string, unknown>> = [];
  const nowIso = new Date().toISOString();

  const subPatch: Record<string, unknown> = { updated_by: user.id, updated_at: nowIso };
  if (typeof body.outlet_name === 'string' && body.outlet_name !== (sub as any).outlet_name) {
    history.push({ field: 'outlet_name', field_label: 'Outlet', old_value: (sub as any).outlet_name ?? null, new_value: body.outlet_name });
    subPatch.outlet_name = body.outlet_name;
  }
  if (typeof body.address === 'string' && body.address !== (sub as any).address) {
    history.push({ field: 'address', field_label: 'Address', old_value: (sub as any).address ?? null, new_value: body.address });
    subPatch.address = body.address;
  }

  if (Array.isArray(body.responses) && body.responses.length) {
    const { data: existing } = await supabaseAdmin.from('form_responses').select('*').eq('submission_id', id);
    const byField = new Map<string, any>((existing || []).map((r: any) => [String(r.field_id), r]));
    const fieldIds = body.responses.map((r) => String(r.field_id ?? r.question_id ?? '')).filter(Boolean);
    const labels = new Map<string, string>();
    if (fieldIds.length) {
      const { data: qs } = await supabaseAdmin.from('builder_questions').select('id,label').in('id', fieldIds);
      for (const q of (qs || []) as Array<{ id: string; label: string | null }>) labels.set(String(q.id), q.label ?? '');
    }
    const display = (r: any): string | null => r == null ? null
      : (r.photo_url ?? r.value_text ?? (r.value_number != null ? String(r.value_number) : (r.value_bool != null ? String(r.value_bool) : null)));
    for (const r of body.responses) {
      const fieldId = String(r.field_id ?? r.question_id ?? '');
      if (!fieldId) continue;
      const photoVal: string | null = (typeof r.photo === 'string' && r.photo.length > 0) ? r.photo : null;
      const rawVal: unknown = r.value ?? null;
      const textVal = typeof rawVal === 'string' ? rawVal : (rawVal == null ? null : JSON.stringify(rawVal));
      const row = {
        value_text: textVal,
        value_number: typeof rawVal === 'number' ? rawVal : null,
        value_bool: typeof rawVal === 'boolean' ? rawVal : null,
        photo_url: photoVal,
        gps: r.gps ?? null,
      };
      const prev = byField.get(fieldId);
      const oldDisplay = display(prev);
      const newDisplay = photoVal ?? textVal ?? (row.value_number != null ? String(row.value_number) : (row.value_bool != null ? String(row.value_bool) : null));
      if (oldDisplay === newDisplay) continue; // unchanged
      if (prev) {
        await supabaseAdmin.from('form_responses').update(row).eq('id', prev.id);
      } else {
        await supabaseAdmin.from('form_responses').insert({ submission_id: id, field_id: fieldId, field_key: fieldId, ...row });
      }
      history.push({ field: fieldId, field_label: labels.get(fieldId) ?? null, old_value: oldDisplay, new_value: newDisplay });
    }
  }

  const { error: upErr } = await supabaseAdmin.from('form_submissions').update(subPatch).eq('id', id);
  if (upErr) return badRequest(res, upErr.message);

  if (history.length) {
    await supabaseAdmin.from('form_submission_history').insert(
      history.map((h) => ({ ...h, submission_id: id, org_id: orgIdVal, client_id: clientIdVal, changed_by: user.id })),
    );
  }

  const { data: fresh } = await supabaseAdmin.from('form_submissions').select('*, builder_forms(title)').eq('id', id).single();
  const { data: resp } = await supabaseAdmin.from('form_responses').select('*, builder_questions(*)').eq('submission_id', id);
  return ok(res, { ...(fresh || sub), form_responses: resp || [], changed: history.length });
});

// Read the edit trail for a submission — admin or the submitting rep only.
export const getSubmissionHistory = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const { id } = req.params;
  const { data: sub } = await supabaseAdmin.from('form_submissions').select('user_id, org_id').eq('id', id).single();
  if (!sub) return notFound(res, 'Submission not found');
  const isOwner = (sub as { user_id?: string }).user_id === user.id;
  if (!callerMayReadOrg(user, (sub as { org_id?: string | null }).org_id) && !isOwner) return notFound(res);
  if (!isTenantAdmin(user) && !isOwner) return res.status(403).json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
  const { data } = await supabaseAdmin.from('form_submission_history')
    .select('*').eq('submission_id', id).order('changed_at', { ascending: false });
  return ok(res, data || []);
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

  // One org's rows per request on every project — the caller's own org, or the client they picked and may use.
  // Only the Tata platform operators keep the aggregated "All clients" view (scopeOrgId null). An admin, a
  // client-role user or a name containing "sagar" no longer does; a picked client that isn't theirs is a 404.
  // See lib/tenantScope.
  const scope = await resolveTenantScope(req, client_id);
  const { isGlobal, pickedClientId, scopeOrgId } = scope;

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
  // Everyone but a Tata platform operator in the "All clients" view is held to one org.
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

  // Every row exposes check_in_at / check_out_at / check_in_gps / check_out_gps / duration_minutes
  // (null when absent); old rows with both times but no stored duration get one computed.
  const normalizedF = ((fData as any[]) || []).map(f => withVisitFields({
      ...f, 
      type: 'traditional',
      outlet_name: f.outlet_name || f.store_name || 'Individual Submission',
      users: f.users || { name: 'FE' },
      activities: f.activities || { name: f.builder_forms?.title || 'Form' }
  }));

  const normalizedB = ((bData as any[]) || []).map(b => withVisitFields({
      ...b, 
      type: 'builder',
      outlet_name: b.outlet_name || 'Individual Submission',
      users: b.users || { name: 'FE' },
      activities: { name: b.builder_forms?.title || 'Form' }
  }));

  // Whole-table row counts are a cross-tenant disclosure: only the all-clients operator view gets them.
  const rawTotalF = isGlobal ? (await supabaseAdmin.from('form_submissions').select('*', { count: 'exact', head: true })).count : null;
  const rawTotalB = isGlobal ? (await supabaseAdmin.from('builder_submissions').select('*', { count: 'exact', head: true })).count : null;

  let merged = [...normalizedF, ...normalizedB].sort((a, b) => 
      new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
  );

  // SAFE CONNECTIVITY FALLBACK: If strict filters yield 0 results for a Global Admin
  // with no specific Executive/City/Search selected, fetch the last 20 global rows.
  // This ensures the dashboard is never "dead" on first load.
  if (isGlobal && merged.length === 0 && !uId && !cId && !zId && !search) {
      const { data: panicF } = await supabaseAdmin.from('form_submissions').select('*, users:user_id(name), activities:activity_id(name)').order('submitted_at', { ascending: false }).limit(20);
      const { data: panicB } = await supabaseAdmin.from('builder_submissions').select('*, users:user_id(name), builder_forms:form_id(title)').order('submitted_at', { ascending: false }).limit(20);
      const pF = (panicF || []).map(f => withVisitFields({ ...f, type: 'traditional', activities: f.activities || { name: 'Log' } }));
      const pB = (panicB || []).map(b => withVisitFields({ ...b, type: 'builder', activities: { name: b.builder_forms?.title || 'Builder' } }));
      merged = [...pF, ...pB].sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  }
  
  const finalResult = merged.slice(0, limit);

  return sendSuccess(res, {
    ...buildPaginatedResult(finalResult, (fCount || 0) + (bCount || 0), page, limit),
    debug: { istDateFrom, utcStart, utcEnd, fCount, bCount, raw_total_f: rawTotalF, raw_total_b: rawTotalB }
  });
});

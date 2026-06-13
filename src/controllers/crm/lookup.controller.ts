import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, isUUID } from '../../utils';

// Generic CRUD helper for simple lookup tables
function crudFor(table: string) {
  const list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { data, error } = await supabaseAdmin.from(table).select('*')
      .eq('org_id', org_id).order('created_at', { ascending: false });
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  });
  const create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id, id: userId } = req.user!;
    const body = { ...req.body, org_id, created_by: userId };
    delete body.id; delete body.created_at;
    const { data, error } = await supabaseAdmin.from(table).insert(body).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data);
  });
  const getOne = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { data, error } = await supabaseAdmin.from(table).select('*')
      .eq('id', req.params.id).eq('org_id', org_id).single();
    if (error || !data) return notFound(res, 'Not found');
    return ok(res, data);
  });
  const update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const updates = { ...req.body };
    delete updates.org_id; delete updates.id; delete updates.created_at;
    const { data, error } = await supabaseAdmin.from(table)
      .update(updates).eq('id', req.params.id).eq('org_id', org_id).select().single();
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  });
  const remove = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { error } = await supabaseAdmin.from(table).delete()
      .eq('id', req.params.id).eq('org_id', org_id);
    if (error) return badRequest(res, error.message);
    return ok(res, { success: true });
  });
  return { list, create, getOne, update, remove };
}

// ── Lead Sources ─────────────────────────────────────────────
// Override the generic list so the response is scoped to the selected
// client. Without this, a Tata Tiscon rep on mobile saw every source row
// in the org (other clients' sources too) because the generic crudFor
// helper only filters by org_id. Web already passes client scope via
// crm.routes.ts but mobile hits this controller directly.
export const leadSources = {
  ...crudFor('crm_lead_sources'),
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const cid = resolveClientFilter(req);
    let q = supabaseAdmin.from('crm_lead_sources').select('*').eq('org_id', org_id);
    // Shared-or-own: tenants see global (client_id IS NULL) sources plus
    // their own. Super-admin with no picker sees everything.
    q = applySharedOrOwn(q as any, cid) as any;
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
};

// ── Territories ──────────────────────────────────────────────
export const territories = crudFor('crm_territories');

// ── Assignment Rules ─────────────────────────────────────────
export const assignmentRules = {
  ...crudFor('crm_assignment_rules'),
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { data, error } = await supabaseAdmin.from('crm_assignment_rules').select('*')
      .eq('org_id', org_id).order('position').order('created_at');
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
};

// ── Custom Field Definitions ─────────────────────────────────
export const customFields = {
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    // Accept either `entity` (legacy clients) or `entity_type` (current).
    // The underlying column is `entity_type`; the param was named `entity`
    // historically and the mobile clients still send that. Translating here
    // means we don't have to ship a coordinated client + server bump.
    const { entity, entity_type } = req.query as Record<string, string | undefined>;
    const entityFilter = entity_type ?? entity;
    let q = supabaseAdmin.from('crm_custom_field_defs').select('*')
      .eq('org_id', org_id).eq('is_active', true);
    if (entityFilter) q = q.eq('entity_type', entityFilter);
    q = q.order('position').order('created_at');
    const { data, error } = await q;
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  create: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    // Mirror the list endpoint: accept either `entity` or `entity_type`
    // from clients; the column is `entity_type`.
    const { entity, entity_type, field_key, label, field_type, options, required = false, position = 0 } = req.body;
    const entityValue = entity_type ?? entity;
    if (!entityValue || !field_key?.trim() || !label?.trim() || !field_type) {
      return badRequest(res, 'entity_type, field_key, label, and field_type are required');
    }
    const payload: Record<string, unknown> = {
      org_id, entity_type: entityValue, field_key: field_key.trim(), label: label.trim(),
      field_type, required, position, is_active: true,
    };
    if (options && options.length > 0) payload.options = options;
    const { data, error } = await supabaseAdmin.from('crm_custom_field_defs').insert(payload).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data);
  }),
  getOne: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { data, error } = await supabaseAdmin.from('crm_custom_field_defs').select('*')
      .eq('id', req.params.id).eq('org_id', org_id).single();
    if (error || !data) return notFound(res, 'Custom field not found');
    return ok(res, data);
  }),
  update: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const updates = { ...req.body };
    delete updates.org_id; delete updates.id; delete updates.created_at;
    const { data, error } = await supabaseAdmin.from('crm_custom_field_defs')
      .update(updates).eq('id', req.params.id).eq('org_id', org_id).select().single();
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  remove: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { error } = await supabaseAdmin.from('crm_custom_field_defs').delete()
      .eq('id', req.params.id).eq('org_id', org_id);
    if (error) return badRequest(res, error.message);
    return ok(res, { success: true });
  }),
};

// ── Automations ──────────────────────────────────────────────
export const automations = crudFor('crm_automations');

// ── Email Templates ──────────────────────────────────────────
export const emailTemplates = crudFor('crm_email_templates');

// ── Emails (log) ─────────────────────────────────────────────
export const emails = {
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { data, error } = await supabaseAdmin.from('crm_email_logs').select('*')
      .eq('org_id', org_id).order('created_at', { ascending: false }).limit(200);
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  send: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id, id: userId } = req.user!;
    const { to_email, to_name, subject, body_html, template_id, lead_id, contact_id, deal_id } = req.body;
    if (!to_email || !subject) return badRequest(res, 'to_email and subject are required');
    // Stub provider — log to DB only
    const { data, error } = await supabaseAdmin.from('crm_email_logs').insert({
      org_id, to_email, to_name, subject, body_html, template_id: template_id || null,
      lead_id: lead_id || null, contact_id: contact_id || null, deal_id: deal_id || null,
      status: 'sent', sent_at: new Date().toISOString(), created_by: userId,
    }).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data, 'Email logged (stub provider)');
  }),
};

// ── Products & Categories ────────────────────────────────────
export const productCategories = crudFor('crm_product_categories');
export const products = {
  ...crudFor('crm_products'),
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { category_id, is_active } = req.query as Record<string, string>;
    let q = supabaseAdmin.from('crm_products')
      .select('*, category:crm_product_categories(id,name)').eq('org_id', org_id);
    if (category_id) q = q.eq('category_id', category_id);
    if (is_active !== undefined) q = q.eq('is_active', is_active !== 'false');
    q = q.order('name');
    const { data, error } = await q;
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
};

// ── WhatsApp Templates & Logs ────────────────────────────────
export const whatsappTemplates = crudFor('crm_whatsapp_templates');

export const whatsapp = {
  send: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id, id: userId } = req.user!;
    const { to, body_text, template_id, template_variables, media_url, media_type, lead_id, contact_id, deal_id } = req.body;
    if (!to) return badRequest(res, 'to (phone number) is required');
    const { data, error } = await supabaseAdmin.from('crm_whatsapp_logs').insert({
      org_id, to_number: to, body_text,
      template_id: template_id || null, template_variables: template_variables || {},
      media_url: media_url || null, media_type: media_type || null,
      lead_id: lead_id || null, contact_id: contact_id || null, deal_id: deal_id || null,
      status: 'queued', created_by: userId,
    }).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data);
  }),
  logs: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { lead_id, contact_id } = req.query as Record<string, string>;
    let q = supabaseAdmin.from('crm_whatsapp_logs').select('*').eq('org_id', org_id);
    if (lead_id) q = q.eq('lead_id', lead_id);
    if (contact_id) q = q.eq('contact_id', contact_id);
    q = q.order('created_at', { ascending: false }).limit(200);
    const { data, error } = await q;
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
};

// ── Import Jobs ──────────────────────────────────────────────
export const importJobs = {
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { data, error } = await supabaseAdmin.from('crm_import_jobs').select('*')
      .eq('org_id', org_id).order('created_at', { ascending: false }).limit(50);
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  upload: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id, id: userId } = req.user!;
    const { entity = 'lead', filename } = req.body;
    const { data, error } = await supabaseAdmin.from('crm_import_jobs').insert({
      org_id, entity, status: 'mapping', filename: filename || 'upload.csv', created_by: userId,
    }).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data);
  }),
  preview: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { job_id, mapping } = req.body;
    const { error } = await supabaseAdmin.from('crm_import_jobs')
      .update({ status: 'preview', mapping: mapping || {} }).eq('id', job_id).eq('org_id', org_id);
    if (error) return badRequest(res, error.message);
    return ok(res, { job: { id: job_id, status: 'preview' }, sample: [] });
  }),
  commit: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { job_id } = req.body;
    const { data, error } = await supabaseAdmin.from('crm_import_jobs')
      .update({ status: 'done', processed_rows: 0, inserted_rows: 0 })
      .eq('id', job_id).eq('org_id', org_id).select().single();
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  getJob: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { data, error } = await supabaseAdmin.from('crm_import_jobs').select('*')
      .eq('id', req.params.id).eq('org_id', org_id).single();
    if (error || !data) return notFound(res, 'Import job not found');
    return ok(res, data);
  }),
};

// ── States & Cities ──────────────────────────────────────────
const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan',
  'Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal',
  'Andaman and Nicobar Islands','Chandigarh','Dadra and Nagar Haveli and Daman and Diu',
  'Delhi','Jammu and Kashmir','Ladakh','Lakshadweep','Puducherry',
];

// Tenant scoping precedence (mirrors buildCRUD in management.controller.ts
// and getUsers in misc.controller.ts):
//   1. JWT client_id  — client-pinned users stay in their tenant.
//   2. ?client_id=    — explicit query param override (e.g. server-to-server).
//   3. X-Client-Id    — global client picker, auto-attached by dashboard api.ts.
//   4. none           — platform admin with no picker → see all in org.
// Without #3, a super_admin selecting "Tata Tiscon" in the picker still
// saw CRM states/cities created under Kinematic, leaking lookup data across
// tenant boundaries.
function resolveClientFilter(req: AuthRequest): string | null {
  const user = req.user!;
  const headerClientId = (req.headers['x-client-id'] as string | undefined) || undefined;
  if (isUUID(user.client_id)) return user.client_id as string;
  if (isUUID(req.query.client_id as string)) return req.query.client_id as string;
  if (isUUID(headerClientId)) return headerClientId as string;
  return null;
}

// Reads use a "shared + own" pattern: every client sees the org-wide
// reference data (rows with `client_id IS NULL`, e.g. the 36 Indian states
// and 354 seed cities) AND their own custom additions. Writes stay strict
// to the picked tenant via `resolveClientFilter`, so a client editing
// "Mumbai" can never mutate the shared row — they can only add or update
// their own copies. Super admin with no picker (cid=null) sees everything.
function applySharedOrOwn<T extends { or: (s: string) => T; eq: (k: string, v: unknown) => T }>(q: T, cid: string | null): T {
  if (!cid) return q;
  return q.or(`client_id.is.null,client_id.eq.${cid}`);
}

export const states = {
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    let q = supabaseAdmin.from('crm_states').select('*').eq('org_id', org_id);
    q = applySharedOrOwn(q as any, resolveClientFilter(req)) as any;
    const { data, error } = await q.order('name');
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  create: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { name, code } = req.body;
    if (!name?.trim()) return badRequest(res, 'name is required');
    // Stamp the new lookup row with the picked tenant so admins browsing
    // "Tata Tiscon" don't accidentally create org-shared rows.
    const cid = resolveClientFilter(req);
    const { data, error } = await supabaseAdmin.from('crm_states')
      .insert({ org_id, client_id: cid, name: name.trim(), code }).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data);
  }),
  getCities: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    let q = supabaseAdmin.from('crm_cities').select('*')
      .eq('org_id', org_id).eq('state_id', req.params.id);
    q = applySharedOrOwn(q as any, resolveClientFilter(req)) as any;
    const { data, error } = await q.order('name');
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  seedIndian: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    // The 36 Indian states + 354 seed cities already live in the database
    // as client_id=NULL global reference rows. The read filter
    // (applySharedOrOwn) surfaces them to every client automatically.
    // This endpoint stays available for clients that want their OWN
    // private copy (rare — usually for white-labelled deployments).
    const cid = resolveClientFilter(req);
    const rows = INDIAN_STATES.map((name) => ({ org_id, client_id: cid, name }));
    const { error } = await supabaseAdmin.from('crm_states').upsert(rows, { onConflict: 'org_id,name' });
    if (error) return badRequest(res, error.message);
    return ok(res, { states: rows.length, cities: 0 });
  }),
};

export const cities = {
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { state_id } = req.query as Record<string, string>;
    let q = supabaseAdmin.from('crm_cities').select('*').eq('org_id', org_id);
    if (state_id) q = q.eq('state_id', state_id);
    q = applySharedOrOwn(q as any, resolveClientFilter(req)) as any;
    q = q.order('name');
    const { data, error } = await q;
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  create: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    const { state_id, name } = req.body;
    if (!state_id || !name?.trim()) return badRequest(res, 'state_id and name are required');
    const cid = resolveClientFilter(req);
    const { data, error } = await supabaseAdmin.from('crm_cities')
      .insert({ org_id, client_id: cid, state_id, name: name.trim() }).select().single();
    if (error) return badRequest(res, error.message);
    return created(res, data);
  }),
  getOne: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    let q = supabaseAdmin.from('crm_cities').select('*')
      .eq('id', req.params.id).eq('org_id', org_id);
    q = applySharedOrOwn(q as any, resolveClientFilter(req)) as any;
    const { data, error } = await q.single();
    if (error || !data) return notFound(res, 'City not found');
    return ok(res, data);
  }),
  update: asyncHandler(async (req: AuthRequest, res: Response) => {
    // Writes stay strict — a client can only edit rows they own. The
    // shared/global rows (`client_id IS NULL`) are immutable from a
    // client's perspective; a platform admin can edit them by clearing
    // the picker.
    const { org_id } = req.user!;
    let q = supabaseAdmin.from('crm_cities')
      .update({ name: req.body.name }).eq('id', req.params.id).eq('org_id', org_id);
    const cid = resolveClientFilter(req);
    if (cid) q = q.eq('client_id', cid);
    const { data, error } = await q.select().single();
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }),
  remove: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { org_id } = req.user!;
    let q = supabaseAdmin.from('crm_cities')
      .delete().eq('id', req.params.id).eq('org_id', org_id);
    const cid = resolveClientFilter(req);
    if (cid) q = q.eq('client_id', cid);
    const { error } = await q;
    if (error) return badRequest(res, error.message);
    return ok(res, { success: true });
  }),
};

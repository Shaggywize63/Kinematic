/**
 * Visit bridge — connects a field visit (and its product-survey forms) to the
 * CRM customer graph: customer account -> plant/site -> contacts -> opportunity.
 *
 * The field apps capture a plant visit once (customer + site + the people met)
 * and then fill one product-survey form per product discussed. This service
 * resolves those captured identities to real CRM rows WITHOUT creating
 * duplicates on a repeat visit, mirroring the existing lead/contact de-dup
 * (dedup.service.ts): an existing company's contacts come back instead of being
 * re-created, which is what powers the merged lead/activity form flow
 * ("work on an existing company -> its details pre-fill").
 *
 * Everything is tenant-scoped by (org_id, client_id). Spark & Ray reps are
 * client-pinned, so client_id is always set for them and matching is strict to
 * that client; org-level admins with no client picker match org-wide.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export interface BridgeCtx {
  org_id: string;
  client_id: string | null;
  user_id?: string;
}

/** Apply the tenant scope to a select/update builder. */
function scoped<T>(q: T, ctx: BridgeCtx): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let b = (q as any).eq('org_id', ctx.org_id).is('deleted_at', null);
  if (ctx.client_id) b = b.eq('client_id', ctx.client_id);
  return b as T;
}

/** Stamp tenant + audit columns on a new row. */
function stamp(ctx: BridgeCtx, row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, org_id: ctx.org_id, client_id: ctx.client_id ?? null, created_by: ctx.user_id ?? null };
}

const norm = (s: unknown): string => String(s ?? '').trim();
const digits = (s: unknown): string => String(s ?? '').replace(/[^0-9]/g, '');

// ─────────────────────────────────────────────────────────── accounts

export interface AccountInput {
  id?: string | null;
  name?: string | null;
  domain?: string | null;
  industry?: string | null;
  phone?: string | null;
  website?: string | null;
  owner_id?: string | null;
}

/**
 * Resolve a customer company: by explicit id, then by domain, then by
 * case-insensitive exact name within the tenant; create it if nothing matches.
 */
export async function findOrCreateAccount(ctx: BridgeCtx, input: AccountInput): Promise<{ id: string; created: boolean }> {
  if (input.id) {
    const { data } = await scoped(supabaseAdmin.from('crm_accounts').select('id'), ctx).eq('id', input.id).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }
  const domain = norm(input.domain).toLowerCase();
  if (domain) {
    const { data } = await scoped(supabaseAdmin.from('crm_accounts').select('id'), ctx).eq('domain', domain).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }
  const name = norm(input.name);
  if (name) {
    const { data } = await scoped(supabaseAdmin.from('crm_accounts').select('id'), ctx).ilike('name', name).limit(1);
    if (data?.[0]?.id) return { id: data[0].id, created: false };
  }
  if (!name) throw new AppError(400, 'Customer name is required to create an account', 'ACCOUNT_NAME_REQUIRED');
  const insert = stamp(ctx, {
    name,
    domain: domain || null,
    industry: norm(input.industry) || null,
    phone: norm(input.phone) || null,
    website: norm(input.website) || null,
    owner_id: input.owner_id ?? ctx.user_id ?? null,
  });
  const { data, error } = await supabaseAdmin.from('crm_accounts').insert(insert).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { id: data.id, created: true };
}

// ─────────────────────────────────────────────────────────── sites

export interface SiteInput {
  id?: string | null;
  account_id: string;
  name?: string | null;
  code?: string | null;
  site_type?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  phone?: string | null;
}

/**
 * Resolve a plant/site under an account: by explicit id, then by
 * case-insensitive exact name within the account; create it if nothing matches.
 */
export async function findOrCreateSite(ctx: BridgeCtx, input: SiteInput): Promise<{ id: string; created: boolean }> {
  if (!input.account_id) throw new AppError(400, 'account_id is required for a site', 'SITE_ACCOUNT_REQUIRED');
  if (input.id) {
    const { data } = await scoped(supabaseAdmin.from('crm_sites').select('id'), ctx).eq('id', input.id).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }
  const name = norm(input.name);
  if (name) {
    const { data } = await scoped(supabaseAdmin.from('crm_sites').select('id'), ctx)
      .eq('account_id', input.account_id).ilike('name', name).limit(1);
    if (data?.[0]?.id) return { id: data[0].id, created: false };
  }
  if (!name) throw new AppError(400, 'Site name is required to create a site', 'SITE_NAME_REQUIRED');
  const insert = stamp(ctx, {
    account_id: input.account_id,
    name,
    code: norm(input.code) || null,
    site_type: norm(input.site_type) || null,
    address_line1: norm(input.address_line1) || null,
    address_line2: norm(input.address_line2) || null,
    city: norm(input.city) || null,
    district: norm(input.district) || null,
    state: norm(input.state) || null,
    postal_code: norm(input.postal_code) || null,
    country: norm(input.country) || 'India',
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    phone: norm(input.phone) || null,
  });
  const { data, error } = await supabaseAdmin.from('crm_sites').insert(insert).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { id: data.id, created: true };
}

// ─────────────────────────────────────────────────────────── contacts

export interface ContactInput {
  id?: string | null;
  account_id?: string | null;
  site_id?: string | null;
  lead_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  title?: string | null;
  department?: string | null;
  /** What this person at the customer is asking for (B2B multi-contact capture). */
  requirement?: string | null;
  owner_id?: string | null;
}

/**
 * Resolve a person met: by explicit id, then exact email within the tenant,
 * then exact phone/mobile digits within the same account; create if none.
 * On a match we attach the site_id (and back-fill blank fields) so a repeat
 * visit converges on the one contact record instead of spawning duplicates.
 */
export async function findOrCreateContact(ctx: BridgeCtx, input: ContactInput): Promise<{ id: string; created: boolean }> {
  if (input.id) {
    const { data } = await scoped(supabaseAdmin.from('crm_contacts').select('id'), ctx).eq('id', input.id).maybeSingle();
    if (data?.id) return attachSite(ctx, data.id, input);
  }
  const email = norm(input.email).toLowerCase();
  if (email) {
    const { data } = await scoped(supabaseAdmin.from('crm_contacts').select('id'), ctx).eq('email', email).limit(1);
    if (data?.[0]?.id) return attachSite(ctx, data[0].id, input);
  }
  const phone = digits(input.phone) || digits(input.mobile);
  if (phone && phone.length >= 7 && input.account_id) {
    // Match within the same account on either phone or mobile digits.
    const { data } = await scoped(supabaseAdmin.from('crm_contacts').select('id, phone, mobile'), ctx)
      .eq('account_id', input.account_id).limit(50);
    const hit = (data || []).find((c: { phone?: string | null; mobile?: string | null }) =>
      digits(c.phone) === phone || digits(c.mobile) === phone);
    if (hit?.id) return attachSite(ctx, hit.id, input);
  }
  const first = norm(input.first_name);
  const last = norm(input.last_name);
  if (!first && !last && !email && !phone) {
    throw new AppError(400, 'A contact needs at least a name, email, or phone', 'CONTACT_IDENTITY_REQUIRED');
  }
  const insert = stamp(ctx, {
    account_id: input.account_id ?? null,
    site_id: input.site_id ?? null,
    lead_id: input.lead_id ?? null,
    first_name: first || null,
    last_name: last || null,
    email: email || null,
    phone: norm(input.phone) || null,
    mobile: norm(input.mobile) || null,
    title: norm(input.title) || null,
    department: norm(input.department) || null,
    requirement: norm(input.requirement) || null,
    owner_id: input.owner_id ?? ctx.user_id ?? null,
  });
  const { data, error } = await supabaseAdmin.from('crm_contacts').insert(insert).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { id: data.id, created: true };
}

/** On a contact match, attach the visit's site and back-fill any blank fields. */
async function attachSite(ctx: BridgeCtx, contactId: string, input: ContactInput): Promise<{ id: string; created: boolean }> {
  const patch: Record<string, unknown> = {};
  if (input.site_id) patch.site_id = input.site_id;
  // Back-fill only columns that are currently blank, never overwrite real data.
  const { data: cur } = await supabaseAdmin.from('crm_contacts')
    .select('site_id, lead_id, title, department, email, phone, mobile, requirement')
    .eq('org_id', ctx.org_id).eq('id', contactId).maybeSingle();
  if (cur) {
    if (!cur.site_id && input.site_id) patch.site_id = input.site_id;
    if (!cur.lead_id && input.lead_id) patch.lead_id = input.lead_id;
    if (!cur.title && norm(input.title)) patch.title = norm(input.title);
    if (!cur.department && norm(input.department)) patch.department = norm(input.department);
    if (!cur.email && norm(input.email)) patch.email = norm(input.email).toLowerCase();
    if (!cur.phone && norm(input.phone)) patch.phone = norm(input.phone);
    if (!cur.mobile && norm(input.mobile)) patch.mobile = norm(input.mobile);
    // A fresh requirement from this visit is appended, never silently dropped or
    // overwritten — the same person can ask for different things on different trips.
    if (norm(input.requirement)) {
      patch.requirement = cur.requirement
        ? `${cur.requirement}\n• ${norm(input.requirement)}`
        : norm(input.requirement);
    }
  }
  if (Object.keys(patch).length) {
    await supabaseAdmin.from('crm_contacts').update(patch).eq('org_id', ctx.org_id).eq('id', contactId);
  }
  return { id: contactId, created: false };
}

// ─────────────────────────────────────────────────────────── account bundle

/**
 * Everything the field app needs to pre-fill when a rep opens an existing
 * company: the account, its sites/plants, its contacts, and its open deals.
 */
export async function getAccountBundle(ctx: BridgeCtx, accountId: string) {
  const { data: account } = await scoped(supabaseAdmin.from('crm_accounts').select('*'), ctx)
    .eq('id', accountId).maybeSingle();
  if (!account) throw new AppError(404, 'Account not found', 'NOT_FOUND');
  const [sitesRes, contactsRes, dealsRes] = await Promise.all([
    scoped(supabaseAdmin.from('crm_sites').select('*'), ctx).eq('account_id', accountId).order('name', { ascending: true }),
    scoped(supabaseAdmin.from('crm_contacts').select('*'), ctx).eq('account_id', accountId).order('created_at', { ascending: false }),
    scoped(supabaseAdmin.from('crm_deals').select('*'), ctx).eq('account_id', accountId).eq('status', 'open').order('created_at', { ascending: false }),
  ]);
  return {
    account,
    sites: sitesRes.data ?? [],
    contacts: contactsRes.data ?? [],
    open_deals: dealsRes.data ?? [],
  };
}

// ─────────────────────────────────────────────────────────── visit intake

export interface VisitIntakeInput {
  visit_id?: string | null;
  account: AccountInput;
  site?: Omit<SiteInput, 'account_id'> & { account_id?: string } | null;
  contacts?: ContactInput[];
  purpose?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  check_in_gps?: string | null;
}

/**
 * One call for the start of a plant visit: resolve (or create) the customer,
 * the plant/site and every contact met, and open a crm_visits row that groups
 * the product forms the rep is about to fill. Returns the resolved ids the app
 * then stamps onto each form submission.
 */
export async function resolveVisitIntake(ctx: BridgeCtx, input: VisitIntakeInput) {
  const account = await findOrCreateAccount(ctx, input.account);
  let siteId: string | null = null;
  if (input.site && (input.site.id || norm(input.site.name))) {
    const site = await findOrCreateSite(ctx, { ...input.site, account_id: account.id });
    siteId = site.id;
  }
  const contacts: Array<{ id: string; created: boolean }> = [];
  for (const c of input.contacts ?? []) {
    contacts.push(await findOrCreateContact(ctx, { ...c, account_id: account.id, site_id: siteId }));
  }

  // Open (or reuse) the visit row grouping this trip's forms.
  let visitId = input.visit_id ?? null;
  if (visitId) {
    const { data } = await scoped(supabaseAdmin.from('crm_visits').select('id'), ctx).eq('id', visitId).maybeSingle();
    if (!data?.id) visitId = null;
  }
  if (!visitId) {
    const insert = stamp(ctx, {
      user_id: ctx.user_id ?? null,
      account_id: account.id,
      site_id: siteId,
      started_at: new Date().toISOString(),
      check_in_gps: norm(input.check_in_gps) || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      purpose: norm(input.purpose) || null,
      status: 'open',
    });
    const { data, error } = await supabaseAdmin.from('crm_visits').insert(insert).select('id').single();
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    visitId = data.id;
  }

  return {
    visit_id: visitId,
    account_id: account.id,
    site_id: siteId,
    contact_ids: contacts.map((c) => c.id),
    created: {
      account: account.created,
      contacts: contacts.filter((c) => c.created).length,
    },
  };
}

// ─────────────────────────────────────────────────────────── lead → company

export interface LeadCompanyInput {
  lead_id: string;
  /** An existing account the rep picked; takes priority over resolving by name. */
  account_id?: string | null;
  company?: string | null;
  industry?: string | null;
  owner_id?: string | null;
  contacts?: ContactInput[];
}

/**
 * B2B lead capture: turn the lead's company into a real CRM account (de-duped),
 * link the lead to it, and resolve every contact-with-requirement the rep logged
 * against both the account and the lead. Idempotent — re-opening the same company
 * converges on the one account and its existing contacts instead of duplicating.
 * Returns the resolved account id and the contact ids (nothing created when there
 * is no company name to anchor on).
 */
export async function linkLeadToCompany(
  ctx: BridgeCtx,
  input: LeadCompanyInput,
): Promise<{ account_id: string | null; contact_ids: string[] }> {
  const company = norm(input.company);
  if (!company && !input.account_id) return { account_id: null, contact_ids: [] };

  const account = await findOrCreateAccount(ctx, {
    id: input.account_id ?? null,
    name: company || null,
    industry: input.industry ?? null,
    owner_id: input.owner_id ?? null,
  });
  // Pin the lead to its account (additive column; see migration_b2b_lead_account_contacts.sql).
  await supabaseAdmin.from('crm_leads')
    .update({ account_id: account.id })
    .eq('org_id', ctx.org_id).eq('id', input.lead_id);

  const contactIds: string[] = [];
  for (const c of input.contacts ?? []) {
    // Skip an entirely empty contact row from the form.
    if (!norm(c.first_name) && !norm(c.last_name) && !norm(c.email) && !norm(c.phone) && !norm(c.mobile)) continue;
    const resolved = await findOrCreateContact(ctx, {
      ...c,
      account_id: account.id,
      lead_id: input.lead_id,
      owner_id: c.owner_id ?? input.owner_id ?? null,
    });
    contactIds.push(resolved.id);
  }
  return { account_id: account.id, contact_ids: contactIds };
}

// ─────────────────────────────────────────────────────────── account timeline

/** A single thing that happened at a customer — a visit, a form, or a follow-up. */
export interface TimelineEvent {
  kind: 'visit' | 'submission' | 'activity';
  id: string;
  at: string | null;
  user_id: string | null;
  user_name: string | null;
  site_id?: string | null;
  title: string;
  detail?: string | null;
  status?: string | null;
  form_title?: string | null;
  answers?: Array<{ label: string; value: string | null; photo_url: string | null }>;
}

/**
 * The management timeline for one customer account: every visit, form submission
 * and follow-up logged against it, who did it (the acting FE), and the answers
 * each form captured — plus a per-FE rollup ("how many FEs visited, who, and
 * what they captured"). Tenant-scoped exactly like getAccountBundle.
 */
export async function getAccountTimeline(ctx: BridgeCtx, accountId: string) {
  const { data: account } = await scoped(supabaseAdmin.from('crm_accounts').select('*'), ctx)
    .eq('id', accountId).maybeSingle();
  if (!account) throw new AppError(404, 'Account not found', 'NOT_FOUND');

  // Pull the three event sources for this account in parallel. form_submissions /
  // crm_visits carry the acting FE as user_id; crm_activities as assigned_to/created_by.
  const [visitsRes, subsRes, actsRes] = await Promise.all([
    scoped(supabaseAdmin.from('crm_visits').select('*'), ctx)
      .eq('account_id', accountId).order('visit_date', { ascending: false }).limit(500),
    scoped(supabaseAdmin.from('form_submissions').select('id, user_id, template_id, site_id, submitted_at, created_at, builder_forms(title)'), ctx)
      .eq('account_id', accountId).order('submitted_at', { ascending: false }).limit(500),
    scoped(supabaseAdmin.from('crm_activities').select('*'), ctx)
      .eq('account_id', accountId).order('created_at', { ascending: false }).limit(500),
  ]);
  const visits = visitsRes.data ?? [];
  const subs = subsRes.data ?? [];
  const acts = actsRes.data ?? [];

  // The answers captured on each submission (one query), grouped by submission.
  const subIds = subs.map((s: { id: string }) => s.id);
  const answersBySub = new Map<string, Array<{ label: string; value: string | null; photo_url: string | null }>>();
  if (subIds.length) {
    const { data: resp } = await supabaseAdmin.from('form_responses')
      .select('submission_id, value_text, value_number, value_bool, photo_url, builder_questions(label, qtype)')
      .in('submission_id', subIds);
    for (const r of (resp ?? []) as Array<Record<string, unknown>>) {
      const sid = r.submission_id as string;
      const q = (r.builder_questions ?? {}) as { label?: string; qtype?: string };
      const value = (r.value_text as string | null)
        ?? (r.value_number != null ? String(r.value_number) : null)
        ?? (r.value_bool != null ? String(r.value_bool) : null);
      const list = answersBySub.get(sid) ?? [];
      list.push({ label: q.label ?? 'Field', value, photo_url: (r.photo_url as string | null) ?? null });
      answersBySub.set(sid, list);
    }
  }

  // Resolve FE names in one query across all three sources.
  const userIds = new Set<string>();
  for (const v of visits) if (v.user_id) userIds.add(v.user_id as string);
  for (const s of subs) if (s.user_id) userIds.add(s.user_id as string);
  for (const a of acts) { if (a.assigned_to) userIds.add(a.assigned_to as string); else if (a.created_by) userIds.add(a.created_by as string); }
  const names = new Map<string, string>();
  if (userIds.size) {
    const { data: users } = await supabaseAdmin.from('users').select('id, name').in('id', Array.from(userIds));
    for (const u of (users ?? []) as Array<{ id: string; name: string | null }>) names.set(u.id, u.name ?? '');
  }
  const nameOf = (id: string | null | undefined): string | null => (id ? (names.get(id) || null) : null);

  const events: TimelineEvent[] = [];
  for (const v of visits) {
    events.push({
      kind: 'visit', id: v.id as string,
      at: (v.started_at as string) ?? (v.visit_date as string) ?? (v.created_at as string) ?? null,
      user_id: (v.user_id as string) ?? null, user_name: nameOf(v.user_id as string),
      site_id: (v.site_id as string) ?? null,
      title: 'Plant visit', detail: (v.purpose as string) ?? null, status: (v.status as string) ?? null,
    });
  }
  for (const s of subs) {
    const form = (s.builder_forms ?? {}) as { title?: string };
    events.push({
      kind: 'submission', id: s.id as string,
      at: (s.submitted_at as string) ?? (s.created_at as string) ?? null,
      user_id: (s.user_id as string) ?? null, user_name: nameOf(s.user_id as string),
      site_id: (s.site_id as string) ?? null,
      title: form.title || 'Form submission', form_title: form.title || null,
      answers: answersBySub.get(s.id as string) ?? [],
    });
  }
  for (const a of acts) {
    const actor = (a.assigned_to as string) ?? (a.created_by as string) ?? null;
    events.push({
      kind: 'activity', id: a.id as string,
      at: (a.completed_at as string) ?? (a.due_at as string) ?? (a.created_at as string) ?? null,
      user_id: actor, user_name: nameOf(actor),
      site_id: (a.site_id as string) ?? null,
      title: (a.subject as string) || (a.type as string) || 'Activity',
      detail: (a.body as string) ?? null, status: (a.status as string) ?? null,
    });
  }
  events.sort((x, y) => (Date.parse(y.at ?? '') || 0) - (Date.parse(x.at ?? '') || 0));

  // Per-FE rollup: who visited, and how much each captured.
  const feMap = new Map<string, { user_id: string; name: string | null; visits: number; submissions: number; last_at: string | null }>();
  const bump = (uid: string | null, kind: 'visit' | 'submission', at: string | null) => {
    if (!uid) return;
    const row = feMap.get(uid) ?? { user_id: uid, name: nameOf(uid), visits: 0, submissions: 0, last_at: null };
    if (kind === 'visit') row.visits += 1; else row.submissions += 1;
    if (at && (!row.last_at || Date.parse(at) > Date.parse(row.last_at))) row.last_at = at;
    feMap.set(uid, row);
  };
  for (const v of visits) bump((v.user_id as string) ?? null, 'visit', (v.started_at as string) ?? (v.visit_date as string) ?? null);
  for (const s of subs) bump((s.user_id as string) ?? null, 'submission', (s.submitted_at as string) ?? null);
  const fes = Array.from(feMap.values()).sort((a, b) => (Date.parse(b.last_at ?? '') || 0) - (Date.parse(a.last_at ?? '') || 0));

  return {
    account,
    summary: {
      fe_count: fes.length,
      visit_count: visits.length,
      submission_count: subs.length,
      activity_count: acts.length,
      fes,
    },
    timeline: events,
  };
}

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
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  title?: string | null;
  department?: string | null;
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
    first_name: first || null,
    last_name: last || null,
    email: email || null,
    phone: norm(input.phone) || null,
    mobile: norm(input.mobile) || null,
    title: norm(input.title) || null,
    department: norm(input.department) || null,
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
    .select('site_id, title, department, email, phone, mobile')
    .eq('org_id', ctx.org_id).eq('id', contactId).maybeSingle();
  if (cur) {
    if (!cur.site_id && input.site_id) patch.site_id = input.site_id;
    if (!cur.title && norm(input.title)) patch.title = norm(input.title);
    if (!cur.department && norm(input.department)) patch.department = norm(input.department);
    if (!cur.email && norm(input.email)) patch.email = norm(input.email).toLowerCase();
    if (!cur.phone && norm(input.phone)) patch.phone = norm(input.phone);
    if (!cur.mobile && norm(input.mobile)) patch.mobile = norm(input.mobile);
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

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
  /** This account only groups its children (a parent "group", e.g. Tata Steel Limited). */
  is_group?: boolean | null;
  /** The parent-group account this company maps up to (NINL → Tata Steel Limited). */
  parent_account_id?: string | null;
}

/**
 * Resolve a customer company: by explicit id, then by domain, then by
 * case-insensitive exact name within the tenant; create it if nothing matches.
 * When `parent_account_id` is supplied and the resolved account has none yet, it
 * is back-filled (so mapping a company to its group is idempotent).
 */
export async function findOrCreateAccount(ctx: BridgeCtx, input: AccountInput): Promise<{ id: string; created: boolean }> {
  // On an existing match, back-fill the group link if the row doesn't have one yet.
  const linkParent = async (id: string): Promise<{ id: string; created: boolean }> => {
    if (input.parent_account_id) {
      const { data: cur } = await supabaseAdmin.from('crm_accounts')
        .select('parent_account_id').eq('org_id', ctx.org_id).eq('id', id).maybeSingle();
      if (cur && !cur.parent_account_id) {
        await supabaseAdmin.from('crm_accounts').update({ parent_account_id: input.parent_account_id })
          .eq('org_id', ctx.org_id).eq('id', id);
      }
    }
    return { id, created: false };
  };
  if (input.id) {
    const { data } = await scoped(supabaseAdmin.from('crm_accounts').select('id'), ctx).eq('id', input.id).maybeSingle();
    if (data?.id) return linkParent(data.id);
  }
  const domain = norm(input.domain).toLowerCase();
  if (domain) {
    const { data } = await scoped(supabaseAdmin.from('crm_accounts').select('id'), ctx).eq('domain', domain).maybeSingle();
    if (data?.id) return linkParent(data.id);
  }
  const name = norm(input.name);
  if (name) {
    const { data } = await scoped(supabaseAdmin.from('crm_accounts').select('id'), ctx).ilike('name', name).limit(1);
    if (data?.[0]?.id) return linkParent(data[0].id);
  }
  if (!name) throw new AppError(400, 'Customer name is required to create an account', 'ACCOUNT_NAME_REQUIRED');
  const insert = stamp(ctx, {
    name,
    domain: domain || null,
    industry: norm(input.industry) || null,
    phone: norm(input.phone) || null,
    website: norm(input.website) || null,
    owner_id: input.owner_id ?? ctx.user_id ?? null,
    is_group: input.is_group ?? false,
    parent_account_id: input.parent_account_id ?? null,
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
  /** 'location' (a site) or 'unit' (a plant under a location). NULL = legacy flat site. */
  site_kind?: string | null;
  /** The location this plant/unit sits under (a crm_sites id). */
  parent_site_id?: string | null;
}

/**
 * Resolve a plant/site under an account: by explicit id, then by
 * case-insensitive exact name within the account (and, when given, the same
 * parent location — so "Pellet Plant" under Jajpur ≠ one under Korba); create it
 * if nothing matches.
 */
export async function findOrCreateSite(ctx: BridgeCtx, input: SiteInput): Promise<{ id: string; created: boolean }> {
  if (!input.account_id) throw new AppError(400, 'account_id is required for a site', 'SITE_ACCOUNT_REQUIRED');
  if (input.id) {
    const { data } = await scoped(supabaseAdmin.from('crm_sites').select('id'), ctx).eq('id', input.id).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }
  const name = norm(input.name);
  if (name) {
    let q = scoped(supabaseAdmin.from('crm_sites').select('id'), ctx)
      .eq('account_id', input.account_id).ilike('name', name);
    q = input.parent_site_id ? q.eq('parent_site_id', input.parent_site_id) : q.is('parent_site_id', null);
    const { data } = await q.limit(1);
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
    site_kind: norm(input.site_kind) || null,
    parent_site_id: input.parent_site_id ?? null,
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
  /** A builder form connected to this person's requirement (org-validated). */
  form_id?: string | null;
  owner_id?: string | null;
}

/**
 * Resolve a person met: by explicit id, then exact email within the tenant,
 * then exact phone/mobile digits within the same account; create if none.
 * On a match we attach the site_id (and back-fill blank fields) so a repeat
 * visit converges on the one contact record instead of spawning duplicates.
 */
export async function findOrCreateContact(ctx: BridgeCtx, input: ContactInput): Promise<{ id: string; created: boolean }> {
  // Validate a connected form against the caller's own org/client forms before
  // it ever touches a row — a form from another org/client is dropped, not
  // linked. Done once up front so both the match (back-fill) and create paths
  // use the cleaned value.
  if (input.form_id) {
    const { data: form } = await scoped(supabaseAdmin.from('builder_forms').select('id'), ctx)
      .eq('id', input.form_id).maybeSingle();
    input = { ...input, form_id: form?.id ? input.form_id : null };
  }
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
    form_id: input.form_id ?? null,
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
    .select('site_id, lead_id, title, department, email, phone, mobile, requirement, form_id')
    .eq('org_id', ctx.org_id).eq('id', contactId).maybeSingle();
  if (cur) {
    if (!cur.site_id && input.site_id) patch.site_id = input.site_id;
    if (!cur.lead_id && input.lead_id) patch.lead_id = input.lead_id;
    if (!cur.form_id && input.form_id) patch.form_id = input.form_id;
    if (!cur.title && norm(input.title)) patch.title = norm(input.title);
    if (!cur.department && norm(input.department)) patch.department = norm(input.department);
    if (!cur.email && norm(input.email)) patch.email = norm(input.email).toLowerCase();
    if (!cur.phone && norm(input.phone)) patch.phone = norm(input.phone);
    if (!cur.mobile && norm(input.mobile)) patch.mobile = norm(input.mobile);
    // A fresh requirement from this visit is appended, never silently dropped or
    // overwritten — the same person can ask for different things on different trips.
    // But an identical note is NOT re-appended: repeatedly logging the same
    // requirement on each visit used to stack duplicate "• …" bullets.
    const incomingReq = norm(input.requirement);
    if (incomingReq) {
      if (!cur.requirement) {
        patch.requirement = incomingReq;
      } else {
        // Compare against existing lines (bullet marker stripped), case-insensitively.
        const seen = cur.requirement.split('\n').map((l) => l.replace(/^•\s*/, '').trim().toLowerCase());
        if (!seen.includes(incomingReq.toLowerCase())) {
          patch.requirement = `${cur.requirement}\n• ${incomingReq}`;
        }
      }
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

// ─────────────────────────────────────────── lead structure (Spark & Ray)

export interface LeadProductLineInput {
  id?: string | null;
  make_id?: string | null;
  make_name?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  qty?: number | null;
  unit?: string | null;
  line_value?: number | null;
}

export interface LeadStructureInput {
  lead_id: string;
  /** An existing company account the rep picked; else resolved from `company`. */
  account_id?: string | null;
  company?: string | null;
  industry?: string | null;
  owner_id?: string | null;
  owner_name?: string | null;
  /** The person the lead is about, for the display name (else the first contact). */
  person_name?: string | null;
  // Group (parent account).
  group_id?: string | null;
  group?: string | null;
  // Location (a parent site) + the plant/unit under it.
  location_id?: string | null;
  location?: string | null;
  location_city?: string | null;
  location_state?: string | null;
  plant?: string | null;
  site_id?: string | null;
  department?: string | null;
  requirement?: string | null;
  contacts?: ContactInput[];
  product_lines?: LeadProductLineInput[];
  /**
   * The customer people on this lead (GM / DGM / procurement …), each an existing
   * contact id, with one flagged primary (the nodal point). undefined = leave the
   * lead's current links untouched; [] = clear them.
   */
  lead_contacts?: LeadContactLink[];
}

/** One customer contact linked to a lead; `is_primary` marks the nodal point (changeable over the deal). */
export interface LeadContactLink {
  contact_id: string;
  is_primary?: boolean;
  role?: string | null;
  position?: number;
}

/** Format one requirement's product lines for the lead name. Exported for tests. */
export function productLinesLabel(lines: LeadProductLineInput[]): { segments: string[] } {
  const parts = lines
    .map((l) => ({ make: norm(l.make_name), product: norm(l.product_name), qty: l.qty, unit: norm(l.unit) || 'Nos' }))
    .filter((l) => l.make || l.product || l.qty != null);
  if (parts.length === 0) return { segments: [] };
  if (parts.length === 1) {
    // Single line reads as its own segments: "MAC – PV12 – 12 Nos".
    const p = parts[0];
    const seg: string[] = [];
    if (p.make) seg.push(p.make);
    if (p.product) seg.push(p.product);
    if (p.qty != null) seg.push(`${p.qty} ${p.unit}`);
    return { segments: seg };
  }
  // Several lines collapse into one segment: "MAC PV12 ×12; MAC DK-200 ×50".
  const joined = parts.map((p) => `${[p.make, p.product].filter(Boolean).join(' ')}${p.qty != null ? ` ×${p.qty}` : ''}`.trim()).join('; ');
  return { segments: joined ? [joined] : [] };
}

/**
 * Build the human-readable lead name from the resolved chain. Exported for tests.
 *
 * The agreed Spark & Ray format (one computed name shared by the lead header and the list row):
 *
 *   Account · Plant · Department — Requirement      e.g. "NTPC · Dadri · Procurement — 150 mm Gate Valves"
 *
 * Segments drop out cleanly when blank: "NTPC · Dadri — 150 mm Gate Valves" (no department),
 * "NTPC · Procurement — 150 mm Gate Valves" (no plant), "NTPC · Dadri · Procurement" (no
 * requirement yet). The PERSON, owner, stage and serial are deliberately NOT in the name — they ride
 * alongside as metadata (the contact on a lead changes over the deal; the serial is the stable key).
 */
export function buildLeadDisplayName(parts: {
  group?: string | null; company?: string | null; city?: string | null; state?: string | null;
  plant?: string | null; department?: string | null; person?: string | null; requirement?: string | null;
  productLines: LeadProductLineInput[]; owner?: string | null;
}): string {
  const head = [parts.company, parts.plant, parts.department].map((s) => norm(s)).filter(Boolean).join(' · ');
  const req = norm(parts.requirement);
  return [head, req].filter(Boolean).join(' — ');
}

/** Fill in missing make/product name snapshots from the tenant's lists. */
async function hydrateProductLineNames(ctx: BridgeCtx, lines: LeadProductLineInput[]): Promise<LeadProductLineInput[]> {
  const makeIds = Array.from(new Set(lines.filter((l) => l.make_id && !norm(l.make_name)).map((l) => l.make_id as string)));
  const productIds = Array.from(new Set(lines.filter((l) => l.product_id && !norm(l.product_name)).map((l) => l.product_id as string)));
  const makeNames = new Map<string, string>();
  const productNames = new Map<string, string>();
  if (makeIds.length) {
    const { data } = await supabaseAdmin.from('crm_makes').select('id, name').eq('org_id', ctx.org_id).in('id', makeIds);
    for (const m of (data ?? []) as Array<{ id: string; name: string | null }>) makeNames.set(m.id, m.name ?? '');
  }
  if (productIds.length) {
    const { data } = await supabaseAdmin.from('crm_products').select('id, name').eq('org_id', ctx.org_id).in('id', productIds);
    for (const p of (data ?? []) as Array<{ id: string; name: string | null }>) productNames.set(p.id, p.name ?? '');
  }
  return lines.map((l) => ({
    ...l,
    make_name: norm(l.make_name) || (l.make_id ? makeNames.get(l.make_id) ?? null : null),
    product_name: norm(l.product_name) || (l.product_id ? productNames.get(l.product_id) ?? null : null),
  }));
}

/** Replace a lead's product lines with the supplied set (idempotent on re-save). */
async function syncLeadProductLines(ctx: BridgeCtx, leadId: string, lines: LeadProductLineInput[]): Promise<void> {
  // Hard-delete the lead's existing lines, then insert the new set. The table is
  // service-role only and small per lead, so a replace is simplest and race-free
  // within a single save.
  await supabaseAdmin.from('crm_lead_product_lines').delete().eq('org_id', ctx.org_id).eq('lead_id', leadId);
  const rows = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.make_id || norm(l.make_name) || l.product_id || norm(l.product_name) || l.qty != null)
    .map(({ l, i }) => stamp(ctx, {
      lead_id: leadId,
      make_id: l.make_id ?? null,
      make_name: norm(l.make_name) || null,
      product_id: l.product_id ?? null,
      product_name: norm(l.product_name) || null,
      qty: l.qty ?? null,
      unit: norm(l.unit) || null,
      line_value: l.line_value ?? null,
      position: i,
    }));
  if (rows.length) {
    const { error } = await supabaseAdmin.from('crm_lead_product_lines').insert(rows);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
  }
}

/**
 * Replace a lead's customer-contact links (crm_lead_contacts). De-dupes by contact id,
 * keeps at most one primary (nodal) contact, and falls back to the first row as primary
 * when the caller flagged none — a lead with people always has a nodal point. Replace is
 * simplest and race-free within one save (the table is service-role only and small per lead).
 */
async function syncLeadContacts(ctx: BridgeCtx, leadId: string, links: LeadContactLink[]): Promise<void> {
  await supabaseAdmin.from('crm_lead_contacts').delete().eq('org_id', ctx.org_id).eq('lead_id', leadId);
  const seen = new Set<string>();
  const unique: LeadContactLink[] = [];
  for (const l of links) {
    if (l && l.contact_id && !seen.has(l.contact_id)) { seen.add(l.contact_id); unique.push(l); }
  }
  let primaryTaken = false;
  const rows = unique.map((l, i) => {
    const isPrimary = !!l.is_primary && !primaryTaken;
    if (isPrimary) primaryTaken = true;
    return stamp(ctx, {
      lead_id: leadId,
      contact_id: l.contact_id,
      is_primary: isPrimary,
      role: norm(l.role) || null,
      position: typeof l.position === 'number' ? l.position : i,
    });
  });
  // No explicit primary but there are people — the first becomes the nodal point.
  if (rows.length && !primaryTaken) (rows[0] as Record<string, unknown>).is_primary = true;
  if (rows.length) {
    const { error } = await supabaseAdmin.from('crm_lead_contacts').insert(rows);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
  }
}

export interface LeadContactRow {
  id: string; contact_id: string; is_primary: boolean; role: string | null; position: number;
  name: string; title: string | null; phone: string | null; email: string | null;
}

/** A lead's customer contacts (primary first), joined with the contact's name/title. Never throws on a missing table. */
export async function getLeadContacts(ctx: BridgeCtx, leadId: string): Promise<LeadContactRow[]> {
  const { data: links, error } = await supabaseAdmin.from('crm_lead_contacts')
    .select('id, contact_id, is_primary, role, position')
    .eq('org_id', ctx.org_id).eq('lead_id', leadId).is('deleted_at', null)
    .order('is_primary', { ascending: false }).order('position', { ascending: true });
  if (error) return [];
  const rows = (links ?? []) as Array<{ id: string; contact_id: string; is_primary: boolean; role: string | null; position: number }>;
  if (rows.length === 0) return [];
  const ids = Array.from(new Set(rows.map((r) => r.contact_id)));
  const { data: contacts } = await supabaseAdmin.from('crm_contacts')
    .select('id, first_name, last_name, title, phone, email').eq('org_id', ctx.org_id).in('id', ids);
  const byId = new Map((contacts ?? []).map((c: Record<string, unknown>) => [c.id as string, c]));
  return rows.map((r) => {
    const c = byId.get(r.contact_id) as Record<string, unknown> | undefined;
    const name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Contact' : 'Contact';
    return {
      id: r.id, contact_id: r.contact_id, is_primary: !!r.is_primary, role: r.role, position: r.position,
      name, title: (c?.title as string) ?? null, phone: (c?.phone as string) ?? null, email: (c?.email as string) ?? null,
    };
  });
}

/**
 * Move the nodal (primary) flag to one contact on a lead, as the deal's point person changes over
 * its life. Clears is_primary on every other link and sets it on the chosen one, in a two-step
 * write so the table never briefly holds two primaries. The chosen row must be a live link on this
 * lead; returns the refreshed contact list (primary first) so the caller re-renders from truth.
 */
export async function setLeadPrimaryContact(ctx: BridgeCtx, leadId: string, linkId: string): Promise<LeadContactRow[]> {
  const { data: target, error: findErr } = await supabaseAdmin.from('crm_lead_contacts')
    .select('id').eq('org_id', ctx.org_id).eq('lead_id', leadId).eq('id', linkId).is('deleted_at', null).maybeSingle();
  if (findErr) throw new AppError(500, findErr.message, 'DB_ERROR');
  if (!target) throw new AppError(404, 'That contact is not linked to this lead.', 'NOT_FOUND');
  // Demote every other link first, then promote the chosen one — never two primaries at once.
  const { error: clearErr } = await supabaseAdmin.from('crm_lead_contacts')
    .update({ is_primary: false }).eq('org_id', ctx.org_id).eq('lead_id', leadId).neq('id', linkId);
  if (clearErr) throw new AppError(500, clearErr.message, 'DB_ERROR');
  const { error: setErr } = await supabaseAdmin.from('crm_lead_contacts')
    .update({ is_primary: true }).eq('org_id', ctx.org_id).eq('lead_id', leadId).eq('id', linkId);
  if (setErr) throw new AppError(500, setErr.message, 'DB_ERROR');
  return getLeadContacts(ctx, leadId);
}

/**
 * Tag another customer person onto a lead (crm_lead_contacts) so the "People on this lead" card can
 * grow as more people join the discussion. The contact must already exist in this org/client. Idempotent:
 * a contact already linked is left as-is. The first person on a lead becomes its nodal (primary) point;
 * everyone added after is a secondary until promoted. Returns the refreshed people list, primary first.
 */
export async function addLeadContact(
  ctx: BridgeCtx, leadId: string, input: { contact_id: string; role?: string | null },
): Promise<LeadContactRow[]> {
  const { data: contact } = await scoped(supabaseAdmin.from('crm_contacts').select('id'), ctx)
    .eq('id', input.contact_id).maybeSingle();
  if (!contact) throw new AppError(404, 'That contact was not found.', 'NOT_FOUND');
  const { data: links } = await supabaseAdmin.from('crm_lead_contacts')
    .select('id, contact_id, position').eq('org_id', ctx.org_id).eq('lead_id', leadId).is('deleted_at', null);
  const rows = (links ?? []) as Array<{ id: string; contact_id: string; position: number }>;
  // Already tagged — nothing to do, just hand back the current list.
  if (rows.some((r) => r.contact_id === input.contact_id)) return getLeadContacts(ctx, leadId);
  const nextPos = rows.reduce((m, r) => Math.max(m, r.position ?? 0), -1) + 1;
  const { error } = await supabaseAdmin.from('crm_lead_contacts').insert(stamp(ctx, {
    lead_id: leadId, contact_id: input.contact_id,
    is_primary: rows.length === 0, // the first person on a lead is its nodal point
    role: norm(input.role) || null, position: nextPos,
  }));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return getLeadContacts(ctx, leadId);
}

/**
 * Remove a customer person from a lead (soft-delete the crm_lead_contacts link). If the removed person
 * was the nodal (primary) point and others remain, the next person (lowest position) is promoted so the
 * lead always keeps a primary. Returns the refreshed people list.
 */
export async function removeLeadContact(ctx: BridgeCtx, leadId: string, linkId: string): Promise<LeadContactRow[]> {
  const { data: target, error: findErr } = await supabaseAdmin.from('crm_lead_contacts')
    .select('id, is_primary').eq('org_id', ctx.org_id).eq('lead_id', leadId).eq('id', linkId).is('deleted_at', null).maybeSingle();
  if (findErr) throw new AppError(500, findErr.message, 'DB_ERROR');
  if (!target) throw new AppError(404, 'That contact is not linked to this lead.', 'NOT_FOUND');
  const { error } = await supabaseAdmin.from('crm_lead_contacts')
    .update({ deleted_at: new Date().toISOString() }).eq('org_id', ctx.org_id).eq('lead_id', leadId).eq('id', linkId);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if ((target as { is_primary?: boolean }).is_primary) {
    const { data: rest } = await supabaseAdmin.from('crm_lead_contacts')
      .select('id').eq('org_id', ctx.org_id).eq('lead_id', leadId).is('deleted_at', null)
      .order('position', { ascending: true }).limit(1);
    const next = (rest ?? [])[0] as { id: string } | undefined;
    if (next) await supabaseAdmin.from('crm_lead_contacts').update({ is_primary: true }).eq('org_id', ctx.org_id).eq('id', next.id);
  }
  return getLeadContacts(ctx, leadId);
}

/**
 * Lead-detail header extras for a structured (Spark & Ray) lead: the names behind the breadcrumb
 * (account › plant › department), the primary (nodal) contact chip and the product lines' total
 * value. Only structured leads (a site or account linked) pay for the lookups; anything else is
 * returned untouched. Best-effort — a failed lookup just leaves that extra off.
 */
export async function stampLeadHeader<T extends object>(org_id: string, lead: T | null): Promise<T | null> {
  if (!lead) return lead;
  const row = lead as Record<string, unknown>;
  const leadId = row.id as string | undefined;
  const siteId = row.site_id as string | null | undefined;
  const accountId = row.account_id as string | null | undefined;
  if (!leadId || (!siteId && !accountId)) return lead;
  try {
    const [site, account, lines, people] = await Promise.all([
      siteId ? supabaseAdmin.from('crm_sites').select('name').eq('org_id', org_id).eq('id', siteId).maybeSingle() : Promise.resolve({ data: null }),
      accountId ? supabaseAdmin.from('crm_accounts').select('name').eq('org_id', org_id).eq('id', accountId).maybeSingle() : Promise.resolve({ data: null }),
      supabaseAdmin.from('crm_lead_product_lines').select('line_value').eq('org_id', org_id).eq('lead_id', leadId),
      getLeadContacts({ org_id, client_id: null }, leadId),
    ]);
    const values = ((lines.data ?? []) as Array<{ line_value: number | string | null }>)
      .map((l) => Number(l.line_value)).filter((n) => Number.isFinite(n) && n > 0);
    const primary = people.find((p) => p.is_primary) ?? null;
    return {
      ...lead,
      site_name: norm((site.data as { name?: string } | null)?.name) || null,
      account_name: norm((account.data as { name?: string } | null)?.name) || null,
      lines_value: values.length ? values.reduce((a, b) => a + b, 0) : null,
      primary_contact: primary ? { contact_id: primary.contact_id, name: primary.name, title: primary.title, phone: primary.phone } : null,
    };
  } catch {
    return lead;
  }
}

/**
 * The full Spark & Ray lead structure in one call: resolve the group, company,
 * location and plant (nested, de-duped), resolve the contacts, store the lead's
 * requirement/department/site, replace its product lines, and compute the
 * human-readable display name. Idempotent — re-saving converges on the same rows.
 */
export async function applyLeadStructure(
  ctx: BridgeCtx,
  input: LeadStructureInput,
): Promise<{ account_id: string | null; group_id: string | null; site_id: string | null; contact_ids: string[]; display_name: string | null }> {
  const company = norm(input.company);
  if (!company && !input.account_id) {
    return { account_id: null, group_id: null, site_id: null, contact_ids: [], display_name: null };
  }

  // 1. Group (parent account), if the rep mapped one.
  let groupId: string | null = null;
  let groupName: string | null = null;
  if (input.group_id || norm(input.group)) {
    const group = await findOrCreateAccount(ctx, { id: input.group_id ?? null, name: norm(input.group) || null, is_group: true, owner_id: input.owner_id ?? null });
    groupId = group.id;
    groupName = norm(input.group) || null;
    if (!groupName) {
      const { data } = await supabaseAdmin.from('crm_accounts').select('name').eq('org_id', ctx.org_id).eq('id', groupId).maybeSingle();
      groupName = (data?.name as string) ?? null;
    }
  }

  // 2. Company account, mapped up to the group.
  const account = await findOrCreateAccount(ctx, {
    id: input.account_id ?? null,
    name: company || null,
    industry: input.industry ?? null,
    owner_id: input.owner_id ?? null,
    parent_account_id: groupId,
  });
  let companyName = company;
  if (!companyName) {
    const { data } = await supabaseAdmin.from('crm_accounts').select('name').eq('org_id', ctx.org_id).eq('id', account.id).maybeSingle();
    companyName = (data?.name as string) ?? '';
  }

  // 3. Location (a parent site) + plant/unit under it.
  let locationId: string | null = null;
  let city = norm(input.location_city);
  let state = norm(input.location_state);
  if (input.location_id || norm(input.location)) {
    const location = await findOrCreateSite(ctx, {
      account_id: account.id, id: input.location_id ?? null, name: norm(input.location) || city || 'Location',
      city: city || null, state: state || null, site_kind: 'location',
    });
    locationId = location.id;
  }
  let plantId: string | null = null;
  let plantName: string | null = null;
  if (input.site_id || norm(input.plant)) {
    const plant = await findOrCreateSite(ctx, {
      account_id: account.id, id: input.site_id ?? null, name: norm(input.plant) || 'Plant',
      parent_site_id: locationId, site_kind: 'unit',
    });
    plantId = plant.id;
  }
  const leadSiteId = plantId ?? locationId ?? (input.site_id ?? null);
  // Pull city/state/plant-name from the resolved site rows when the form didn't send them.
  if (leadSiteId) {
    const ids = [leadSiteId, locationId].filter((x): x is string => Boolean(x));
    const { data: siteRows } = await supabaseAdmin.from('crm_sites').select('id, name, city, state, parent_site_id').eq('org_id', ctx.org_id).in('id', ids);
    const byId = new Map((siteRows ?? []).map((s: Record<string, unknown>) => [s.id as string, s]));
    const plantRow = plantId ? byId.get(plantId) : null;
    const locRow = locationId ? byId.get(locationId) : (plantRow?.parent_site_id ? byId.get(plantRow.parent_site_id as string) : null);
    if (plantRow) plantName = (plantRow.name as string) ?? null;
    else if (locRow) plantName = (locRow.name as string) ?? null;
    if (!city) city = norm((locRow?.city as string) ?? (plantRow?.city as string));
    if (!state) state = norm((locRow?.state as string) ?? (plantRow?.state as string));
  }

  // 4. Contacts (each tagged with the account, lead, plant, department).
  const contactIds: string[] = [];
  let firstPersonName = norm(input.person_name);
  for (const c of input.contacts ?? []) {
    if (!norm(c.first_name) && !norm(c.last_name) && !norm(c.email) && !norm(c.phone) && !norm(c.mobile)) continue;
    const resolved = await findOrCreateContact(ctx, {
      ...c,
      account_id: account.id,
      lead_id: input.lead_id,
      site_id: leadSiteId,
      department: norm(c.department) || norm(input.department) || null,
      owner_id: c.owner_id ?? input.owner_id ?? null,
    });
    contactIds.push(resolved.id);
    if (!firstPersonName) firstPersonName = [norm(c.first_name), norm(c.last_name)].filter(Boolean).join(' ');
  }

  // 5. Product lines. `undefined` means the caller didn't touch them (a partial
  // edit) — keep what's stored and reuse it for the name; an array (even empty)
  // means replace.
  let lines: LeadProductLineInput[];
  if (input.product_lines === undefined) {
    const { data } = await supabaseAdmin.from('crm_lead_product_lines')
      .select('make_id, make_name, product_id, product_name, qty, unit, line_value')
      .eq('org_id', ctx.org_id).eq('lead_id', input.lead_id).order('position', { ascending: true });
    lines = (data ?? []) as LeadProductLineInput[];
  } else {
    lines = await hydrateProductLineNames(ctx, input.product_lines);
    await syncLeadProductLines(ctx, input.lead_id, lines);
  }

  // 5b. Customer-contact links (several people, one primary). undefined = leave as-is.
  if (input.lead_contacts !== undefined) {
    await syncLeadContacts(ctx, input.lead_id, input.lead_contacts ?? []);
  }

  // 6. Compute the display name and persist the lead's structured columns.
  let ownerName = norm(input.owner_name);
  if (!ownerName && input.owner_id) {
    const { data } = await supabaseAdmin.from('users').select('name').eq('id', input.owner_id).maybeSingle();
    ownerName = norm(data?.name);
  }
  const display = buildLeadDisplayName({
    group: groupName, company: companyName, city, state, plant: plantName,
    department: norm(input.department), person: firstPersonName,
    requirement: norm(input.requirement), productLines: lines, owner: ownerName,
  }) || null;

  const patch: Record<string, unknown> = { account_id: account.id, display_name: display };
  if (leadSiteId) patch.site_id = leadSiteId;
  if (norm(input.department)) patch.department = norm(input.department);
  if (norm(input.requirement)) patch.requirement = norm(input.requirement);
  await supabaseAdmin.from('crm_leads').update(patch).eq('org_id', ctx.org_id).eq('id', input.lead_id);

  return { account_id: account.id, group_id: groupId, site_id: leadSiteId, contact_ids: contactIds, display_name: display };
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

/**
 * DSAR (Data Subject Access Request) service — GDPR Art. 15/17/20 & DPDP §11/12.
 *
 * Provides, for a single data subject (a CRM lead and/or contact):
 *   - export():  gather ALL personal data across the lead + linked contact and
 *                every child table, for right-of-access + portability.
 *   - erase():   remove/anonymise the subject's personal data for right-to-erasure.
 *
 * Everything is tenant-scoped: the caller's orgId (and, when strict, clientId)
 * must own the subject row, so one tenant can never DSAR another's data. The
 * caller identity + the action are recorded in audit_log by the route.
 *
 * We reuse existing tables only — no schema migration required.
 */
import { supabaseAdmin } from '../../lib/supabase';

/** Direct-identifier / sensitive columns on crm_leads to null on erasure. */
const LEAD_PII_COLUMNS = [
  'first_name', 'last_name', 'email', 'phone', 'company', 'city', 'country',
  'date_of_birth', 'gender', 'address_line1', 'address_line2', 'state',
  'postal_code', 'preferred_contact_method', 'interests', 'alternate_mobiles',
  'district', 'block', 'notes', 'latitude', 'longitude', 'phone_hash',
  'email_hash', 'photo_url', 'referrer_url', 'landing_page',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
];

/** Direct-identifier / sensitive columns on crm_contacts to null on erasure. */
const CONTACT_PII_COLUMNS = [
  'first_name', 'last_name', 'email', 'phone', 'mobile', 'title', 'department',
  'linkedin_url', 'date_of_birth', 'gender', 'address_line1', 'address_line2',
  'city', 'state', 'postal_code', 'country', 'preferred_contact_method',
  'referral_source', 'interests', 'alternate_mobiles', 'photo_url',
];

/**
 * Child tables that reference the subject by lead_id. Each row is personal
 * data of the subject and is returned on export / removed on erasure.
 * `mode: 'delete'` rows carry free-text / message content and are hard-deleted
 * on erasure. `mode: 'keep'` rows are business records (deals, activities,
 * scores) that are left in place — they reference the subject row, which is
 * retained but anonymised in place, so referential integrity holds and no
 * NOT NULL foreign key is violated.
 */
const LEAD_CHILDREN: Array<{ table: string; fk: string; mode: 'delete' | 'keep' }> = [
  { table: 'crm_notes', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_email_logs', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_whatsapp_logs', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_web_chat_sessions', fk: 'lead_id', mode: 'delete' },
  { table: 'conversation_recordings', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_lead_updates', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_lead_history', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_lead_inbound_events', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_lead_attribution', fk: 'lead_id', mode: 'delete' },
  { table: 'crm_lead_scores', fk: 'lead_id', mode: 'keep' },
  { table: 'crm_activities', fk: 'lead_id', mode: 'keep' },
  { table: 'crm_deals', fk: 'lead_id', mode: 'keep' },
];

const CONTACT_CHILDREN: Array<{ table: string; fk: string; mode: 'delete' | 'keep' }> = [
  { table: 'crm_notes', fk: 'contact_id', mode: 'delete' },
  { table: 'crm_email_logs', fk: 'contact_id', mode: 'delete' },
  { table: 'crm_whatsapp_logs', fk: 'contact_id', mode: 'delete' },
  { table: 'crm_activities', fk: 'contact_id', mode: 'keep' },
  { table: 'crm_deal_contacts', fk: 'contact_id', mode: 'delete' },
];

export interface SubjectLocator {
  leadId?: string | null;
  contactId?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface Scope {
  orgId: string;
  clientId: string | null;
  strict: boolean; // when true, also require client_id to match (real tenant isolation)
}

// NB: typed as `any` (matching crud.service's treatment of the Supabase query
// builder). A recursive generic here — `<T extends { eq: (k, v) => T }>` — makes
// tsc recurse into the builder's deeply-nested generics and fail with TS2589
// ("Type instantiation is excessively deep and possibly infinite").
function applyScope(q: any, scope: Scope): any {
  let scoped = q.eq('org_id', scope.orgId);
  if (scope.strict && scope.clientId) scoped = scoped.eq('client_id', scope.clientId);
  return scoped;
}

/**
 * Resolve the subject's lead + contact rows within the caller's tenant.
 * Returns null identifiers when nothing matches, so callers can 404.
 */
async function resolveSubject(loc: SubjectLocator, scope: Scope): Promise<{ lead: any | null; contact: any | null }> {
  let lead: any = null;
  let contact: any = null;

  if (loc.leadId) {
    const { data } = await applyScope(supabaseAdmin.from('crm_leads').select('*').eq('id', loc.leadId), scope).maybeSingle();
    lead = data ?? null;
  } else if (loc.phone || loc.email) {
    let q = applyScope(supabaseAdmin.from('crm_leads').select('*'), scope);
    // Exact match only — phone/email are validated by the route before we get here.
    if (loc.phone) q = q.eq('phone', loc.phone);
    if (loc.email) q = q.eq('email', loc.email);
    const { data } = await q.limit(1).maybeSingle();
    lead = data ?? null;
  }

  if (loc.contactId) {
    const { data } = await applyScope(supabaseAdmin.from('crm_contacts').select('*').eq('id', loc.contactId), scope).maybeSingle();
    contact = data ?? null;
  } else if (lead?.converted_contact_id) {
    const { data } = await applyScope(supabaseAdmin.from('crm_contacts').select('*').eq('id', lead.converted_contact_id), scope).maybeSingle();
    contact = data ?? null;
  } else if ((loc.phone || loc.email) && !contact) {
    let q = applyScope(supabaseAdmin.from('crm_contacts').select('*'), scope);
    if (loc.phone) {
      // Strip PostgREST filter metacharacters before interpolating into .or().
      const safePhone = String(loc.phone).replace(/[(),"\\]/g, '');
      q = q.or(`phone.eq.${safePhone},mobile.eq.${safePhone}`);
    }
    if (loc.email) q = q.eq('email', loc.email);
    const { data } = await q.limit(1).maybeSingle();
    contact = data ?? null;
  }

  return { lead, contact };
}

/** Right of access + portability: assemble the subject's full personal-data bundle. */
export async function exportSubject(loc: SubjectLocator, scope: Scope): Promise<{
  found: boolean;
  subject: { lead: any | null; contact: any | null };
  related: Record<string, any[]>;
  generatedForOrg: string;
}> {
  const { lead, contact } = await resolveSubject(loc, scope);
  const related: Record<string, any[]> = {};

  if (lead?.id) {
    for (const { table, fk } of LEAD_CHILDREN) {
      const { data } = await supabaseAdmin.from(table).select('*').eq(fk, lead.id);
      if (data && data.length) related[`${table}.${fk}`] = data;
    }
  }
  if (contact?.id) {
    for (const { table, fk } of CONTACT_CHILDREN) {
      const { data } = await supabaseAdmin.from(table).select('*').eq(fk, contact.id);
      if (data && data.length) related[`${table}.${fk}`] = data;
    }
  }

  return {
    found: Boolean(lead || contact),
    subject: { lead, contact },
    related,
    generatedForOrg: scope.orgId,
  };
}

/** Right to erasure: null identifier columns on the subject and remove personal-content child rows. */
export async function eraseSubject(loc: SubjectLocator, scope: Scope): Promise<{
  found: boolean;
  erased: { leadId: string | null; contactId: string | null; childRowsDeleted: number };
}> {
  const { lead, contact } = await resolveSubject(loc, scope);
  if (!lead && !contact) return { found: false, erased: { leadId: null, contactId: null, childRowsDeleted: 0 } };

  let childRowsDeleted = 0;

  const nowIso = new Date().toISOString();
  const tombstone = (columns: string[]): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    for (const c of columns) patch[c] = null;
    patch.custom_fields = {};
    patch.tags = [];
    patch.deleted_at = nowIso;
    return patch;
  };

  if (lead?.id) {
    for (const { table, fk, mode } of LEAD_CHILDREN) {
      if (mode !== 'delete') continue; // business records reference the anonymised parent — leave in place
      const { count } = await supabaseAdmin.from(table).delete({ count: 'exact' }).eq(fk, lead.id);
      childRowsDeleted += count ?? 0;
    }
    await supabaseAdmin.from('crm_leads').update(tombstone(LEAD_PII_COLUMNS)).eq('id', lead.id);
  }

  if (contact?.id) {
    for (const { table, fk, mode } of CONTACT_CHILDREN) {
      if (mode !== 'delete') continue;
      const { count } = await supabaseAdmin.from(table).delete({ count: 'exact' }).eq(fk, contact.id);
      childRowsDeleted += count ?? 0;
    }
    await supabaseAdmin.from('crm_contacts').update(tombstone(CONTACT_PII_COLUMNS)).eq('id', contact.id);
  }

  return {
    found: true,
    erased: {
      leadId: lead?.id ?? null,
      contactId: contact?.id ?? null,
      childRowsDeleted,
    },
  };
}

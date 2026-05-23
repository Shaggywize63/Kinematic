/**
 * Decorates CRM rows with owner_name / assigned_to_name by looking up the
 * referenced user(s) in the platform's users table. Does it in a single
 * IN(...) query so this is O(1) extra round-trip regardless of how many rows
 * came back from the primary query.
 *
 * Reason this exists: the legacy CRM list services (leads, deals, contacts,
 * accounts, activities) just do `select('*')` from their own table, so the
 * frontend gets `owner_id` UUIDs but no display names. The dashboard tables
 * render `row.owner_name`, so without this stamping reassigning a row appears
 * to "do nothing" — the new owner_id lands in the DB but the UI keeps showing
 * "Unassigned".
 */
import { supabaseAdmin } from '../../lib/supabase';

type Row = {
  owner_id?: string | null;
  assigned_to?: string | null;
  owner_name?: string | null;
  assigned_to_name?: string | null;
};

export async function stampOwnerNames<T extends Row>(rows: T[]): Promise<T[]> {
  if (!rows || rows.length === 0) return rows;
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.owner_id) ids.add(r.owner_id);
    if (r.assigned_to) ids.add(r.assigned_to);
  }
  if (ids.size === 0) return rows;
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, name, email')
    .in('id', Array.from(ids));
  const nameById = new Map<string, string>();
  for (const u of users ?? []) {
    nameById.set((u as any).id, ((u as any).name as string) || ((u as any).email as string) || '');
  }
  return rows.map((r) => ({
    ...r,
    owner_name: r.owner_id ? (nameById.get(r.owner_id) ?? r.owner_name ?? null) : (r.owner_name ?? null),
    assigned_to_name: r.assigned_to ? (nameById.get(r.assigned_to) ?? r.assigned_to_name ?? null) : (r.assigned_to_name ?? null),
  }));
}

export async function stampOwnerName<T extends Row>(row: T | null | undefined): Promise<T | null> {
  if (!row) return row ?? null;
  const [decorated] = await stampOwnerNames([row]);
  return decorated;
}

// ---------------------------------------------------------------------------
// Linked-entity name decorator. Activities (and anything else with a FK to a
// lead / contact / account / deal) get pretty `*_name` fields so the UI can
// render "Rakesh Sharma" instead of a dangling UUID. One batched IN() query
// per parent table so the cost is fixed regardless of page size.
// ---------------------------------------------------------------------------

type Linked = {
  lead_id?: string | null;
  contact_id?: string | null;
  account_id?: string | null;
  deal_id?: string | null;
  lead_name?: string | null;
  lead_phone?: string | null;
  contact_name?: string | null;
  account_name?: string | null;
  deal_name?: string | null;
};

export async function stampLinkedEntityNames<T extends Linked>(rows: T[]): Promise<T[]> {
  if (!rows || rows.length === 0) return rows;
  const leadIds    = new Set<string>();
  const contactIds = new Set<string>();
  const accountIds = new Set<string>();
  const dealIds    = new Set<string>();
  for (const r of rows) {
    if (r.lead_id)    leadIds.add(r.lead_id);
    if (r.contact_id) contactIds.add(r.contact_id);
    if (r.account_id) accountIds.add(r.account_id);
    if (r.deal_id)    dealIds.add(r.deal_id);
  }
  if (!leadIds.size && !contactIds.size && !accountIds.size && !dealIds.size) return rows;

  const [leadsRes, contactsRes, accountsRes, dealsRes] = await Promise.all([
    leadIds.size    ? supabaseAdmin.from('crm_leads').select('id, first_name, last_name, company, phone').in('id', Array.from(leadIds)) : Promise.resolve({ data: [] as any[] }),
    contactIds.size ? supabaseAdmin.from('crm_contacts').select('id, first_name, last_name').in('id', Array.from(contactIds))    : Promise.resolve({ data: [] as any[] }),
    accountIds.size ? supabaseAdmin.from('crm_accounts').select('id, name').in('id', Array.from(accountIds))                     : Promise.resolve({ data: [] as any[] }),
    dealIds.size    ? supabaseAdmin.from('crm_deals').select('id, name').in('id', Array.from(dealIds))                            : Promise.resolve({ data: [] as any[] }),
  ]);
  const leadName    = new Map<string, string>((leadsRes.data    ?? []).map((l: any) => [l.id, [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || l.company || '']));
  const leadPhone   = new Map<string, string>((leadsRes.data    ?? []).map((l: any) => [l.id, (l.phone as string) || '']));
  const contactName = new Map<string, string>((contactsRes.data ?? []).map((c: any) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ').trim()]));
  const accountName = new Map<string, string>((accountsRes.data ?? []).map((a: any) => [a.id, (a.name as string) || '']));
  const dealName    = new Map<string, string>((dealsRes.data    ?? []).map((d: any) => [d.id, (d.name as string) || '']));

  return rows.map((r) => ({
    ...r,
    lead_name:    r.lead_id    ? (leadName.get(r.lead_id)       ?? r.lead_name    ?? null) : (r.lead_name    ?? null),
    lead_phone:   r.lead_id    ? (leadPhone.get(r.lead_id)      ?? r.lead_phone   ?? null) : (r.lead_phone   ?? null),
    contact_name: r.contact_id ? (contactName.get(r.contact_id) ?? r.contact_name ?? null) : (r.contact_name ?? null),
    account_name: r.account_id ? (accountName.get(r.account_id) ?? r.account_name ?? null) : (r.account_name ?? null),
    deal_name:    r.deal_id    ? (dealName.get(r.deal_id)       ?? r.deal_name    ?? null) : (r.deal_name    ?? null),
  }));
}

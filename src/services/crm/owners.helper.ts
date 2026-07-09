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

// ─────────────────────────────────────────────────────────────────────
// Source-name decoration. Leads carry source_id (FK to crm_lead_sources);
// the FE list table renders `row.source_name`. Without this stamping the
// Source column always reads "—" even when the source_id is populated.
// Same O(1)-round-trip shape as stampOwnerNames.
// ─────────────────────────────────────────────────────────────────────

type SourceRow = { source_id?: string | null; source_name?: string | null };

export async function stampSourceNames<T extends SourceRow>(rows: T[]): Promise<T[]> {
  if (!rows || rows.length === 0) return rows;
  const ids = Array.from(new Set(rows.map((r) => r.source_id).filter(Boolean) as string[]));
  if (ids.length === 0) return rows;
  const { data: sources } = await supabaseAdmin
    .from('crm_lead_sources')
    .select('id, name')
    .in('id', ids);
  const nameById = new Map<string, string>();
  for (const s of sources ?? []) {
    nameById.set((s as any).id, ((s as any).name as string) || '');
  }
  return rows.map((r) => ({
    ...r,
    source_name: r.source_id ? (nameById.get(r.source_id) ?? r.source_name ?? null) : (r.source_name ?? null),
  }));
}

export async function stampSourceName<T extends SourceRow>(row: T | null | undefined): Promise<T | null> {
  if (!row) return row ?? null;
  const [decorated] = await stampSourceNames([row]);
  return decorated;
}

// ─────────────────────────────────────────────────────────────────────
// Created-by-name decoration. Leads and other crm_* rows carry created_by
// (FK to users). For "who uploaded this lead?" the FE wants the user's
// name, not the raw uuid. Same batched-IN() round-trip shape as the
// owner/source stamps; reuses the result map when both are hit on the
// same set of rows by hydrating user names once.
// ─────────────────────────────────────────────────────────────────────

type CreatedByRow = { created_by?: string | null; created_by_name?: string | null };

// Platform-admin display label. Rows imported / created by a super-admin
// surface as "Kinematic Admin" in the UI instead of leaking the operator's
// real name into the tenant's view — important for white-labelled clients
// (e.g. Tata Tiscon) who don't need to know the Kinematic staff identity.
const SUPER_ADMIN_LABEL = 'Kinematic Admin';

export async function stampCreatedByNames<T extends CreatedByRow>(rows: T[]): Promise<T[]> {
  if (!rows || rows.length === 0) return rows;
  const ids = Array.from(new Set(rows.map((r) => r.created_by).filter(Boolean) as string[]));
  if (ids.length === 0) return rows;
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role')
    .in('id', ids);
  const nameById = new Map<string, string>();
  for (const u of users ?? []) {
    const role = ((u as any).role as string | undefined)?.toLowerCase()?.trim()?.replace(/-/g, '_');
    if (role === 'super_admin') {
      // Mask the real name with the platform label.
      nameById.set((u as any).id, SUPER_ADMIN_LABEL);
    } else {
      nameById.set((u as any).id, ((u as any).name as string) || ((u as any).email as string) || '');
    }
  }
  return rows.map((r) => ({
    ...r,
    created_by_name: r.created_by ? (nameById.get(r.created_by) ?? r.created_by_name ?? null) : (r.created_by_name ?? null),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Uploaded-by relabel. Records ingested through the CSV/Excel importer keep
// the real importer in `created_by` (audit trail stays honest), but the UI's
// "Uploaded By" column should read a neutral "Kinematic Admin" rather than
// the admin's personal name. We discriminate purely on the lead source: the
// importer auto-stamps every imported lead with the "Excel/CSV Import"
// source, so any row whose source_name matches gets the label. Run this
// AFTER stampSourceNames + stampCreatedByNames so both inputs are populated.
// ─────────────────────────────────────────────────────────────────────

/** Lead source name the importer auto-creates per org (see import.service.ts). */
export const IMPORT_SOURCE_NAME = 'Excel/CSV Import';
/** Neutral label shown for uploaded/imported records instead of the importer. */
export const ADMIN_UPLOADER_LABEL = 'Kinematic Admin';

type UploaderRelabelRow = { source_name?: string | null; created_by_name?: string | null };

export function relabelImportedUploader<T extends UploaderRelabelRow>(rows: T[]): T[] {
  if (!rows || rows.length === 0) return rows;
  return rows.map((r) =>
    r.source_name === IMPORT_SOURCE_NAME
      ? { ...r, created_by_name: ADMIN_UPLOADER_LABEL }
      : r,
  );
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

// ---------------------------------------------------------------------------
// Custom-field CSV columns. Admin-defined fields live in
// crm_custom_field_defs (one row per field per entity) and each row's value
// is stored under row.custom_fields[field_key]. The CSV export routes call
// this to learn (a) which extra columns to append and (b) how to pull each
// value out of the row's jsonb blob in a CSV-safe form. One query per
// export — definitions list is tiny so caching isn't worth the complexity.
// ---------------------------------------------------------------------------

export type CustomFieldCol = {
  key: string;        // synthetic column key the route reads off the row
  label: string;      // header label shown in the CSV
  field_key: string;  // original key in row.custom_fields
  field_type?: string;     // 'lookup' for linked-record fields
  target_table?: string | null; // referenced table for lookup fields
};

export async function listCustomFieldColumns(
  org_id: string,
  entity: 'lead' | 'contact' | 'account' | 'deal',
): Promise<CustomFieldCol[]> {
  const { data } = await supabaseAdmin
    .from('crm_custom_field_defs')
    .select('field_key, label, position, field_type, target_table')
    .eq('org_id', org_id)
    .eq('entity_type', entity)
    .order('position', { ascending: true, nullsFirst: false });
  return (data ?? []).map((d: any) => ({
    key: `custom__${d.field_key}`,
    label: d.label || d.field_key,
    field_key: d.field_key,
    field_type: d.field_type,
    target_table: d.target_table ?? null,
  }));
}

// Pick the most human-readable label out of a row pulled from an
// arbitrary lookup table. Tries first/last name first (people_directory,
// users), then common name-ish columns, then falls back to a short id.
// Mirrors the genericDisplay used by /api/v1/crm/lookup/search so the
// CSV reads "Ravi Kumar" instead of an opaque UUID.
function lookupRowLabel(r: Record<string, unknown>): string {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  for (const k of ['name', 'title', 'label', 'subject', 'email', 'mobile', 'phone', 'code']) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return String(r.id ?? '').slice(0, 8);
}

/**
 * Resolve every lookup custom-field UUID referenced by `rows` to its
 * display label. Returns a Map keyed `${target_table}:${id}` so the
 * stamping below can swap UUIDs for names without another round-trip.
 *
 * Why this exists: lookup fields can be persisted as either
 *   - the new `{ id, label, target_table }` object (the picker writes
 *     this so the detail page renders without resolving), OR
 *   - a bare UUID string (legacy writes, CSV imports, mobile clients
 *     that send the raw id).
 * Without this hydration the CSV export wrote the raw UUID into the
 * "Dealer" / "Block" / "Product" columns — the bug being fixed.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveLookupLabels(
  rows: Array<{ custom_fields?: Record<string, unknown> | null }>,
  cols: CustomFieldCol[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const idsByTarget = new Map<string, Set<string>>();
  for (const c of cols) {
    if (c.field_type !== 'lookup' || !c.target_table) continue;
    for (const r of rows) {
      const cf = (r.custom_fields ?? {}) as Record<string, unknown>;
      const v = cf[c.field_key];
      if (!v) continue;
      let id: string | null = null;
      if (typeof v === 'string') {
        id = v;
      } else if (typeof v === 'object') {
        const o = v as { id?: string; label?: string };
        if (o.id && !o.label) id = o.id;
      }
      if (!id) continue;
      // Only collect UUID-shaped ids. Lookup targets key on a `uuid` id
      // column, and these jsonb fields carry mixed data in practice — a
      // real UUID for picker writes, but also free-text names ("Godda")
      // and stray "[object Object]" from older/broken clients. A single
      // non-UUID value poisons the `.in('id', …)` batch below: Postgres
      // rejects it with 22P02 and the whole target's resolution is
      // dropped, so even the valid UUIDs fall back to the raw id. Non-UUID
      // strings are already human-readable, so we leave them as-is.
      if (!UUID_RE.test(id)) continue;
      const set = idsByTarget.get(c.target_table) ?? new Set<string>();
      set.add(id);
      idsByTarget.set(c.target_table, set);
    }
  }
  for (const [target, ids] of idsByTarget) {
    if (ids.size === 0) continue;
    // Soft-fail per target so a broken lookup target doesn't 500 the
    // whole CSV — unresolved ids fall back to the raw UUID.
    try {
      const { data } = await supabaseAdmin
        .from(target)
        .select('*')
        .in('id', Array.from(ids));
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const id = row.id as string | undefined;
        if (!id) continue;
        const label = lookupRowLabel(row);
        if (label) out.set(`${target}:${id}`, label);
      }
    } catch {
      /* leave UUIDs as-is when the target table can't be read */
    }
  }
  return out;
}

// Flatten the row.custom_fields jsonb onto top-level synthetic keys
// (`custom__<field_key>`) so the CSV writer's plain `r[col.key]` lookup
// finds the value without special-casing every column. Arrays + objects
// get JSON.stringified so multi-select / file lists survive the trip
// to a spreadsheet as readable text. Lookup fields are special-cased to
// emit the display label (from inline `{id,label}` or the resolution
// map) instead of the raw UUID.
export function stampCustomFieldValues<T extends { custom_fields?: Record<string, unknown> | null }>(
  rows: T[],
  cols: CustomFieldCol[],
  lookupLabels?: Map<string, string>,
): T[] {
  if (rows.length === 0 || cols.length === 0) return rows;
  return rows.map((r) => {
    const cf = (r.custom_fields || {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...r };
    for (const c of cols) {
      const v = cf[c.field_key];
      if (v === undefined || v === null) { out[c.key] = ''; continue; }
      if (c.field_type === 'lookup' && c.target_table) {
        if (typeof v === 'object' && !Array.isArray(v)) {
          const o = v as { id?: string; label?: string };
          if (o.label) { out[c.key] = o.label; continue; }
          if (o.id) {
            out[c.key] = lookupLabels?.get(`${c.target_table}:${o.id}`) ?? o.id;
            continue;
          }
        } else if (typeof v === 'string') {
          out[c.key] = lookupLabels?.get(`${c.target_table}:${v}`) ?? v;
          continue;
        }
      }
      out[c.key] =
        Array.isArray(v) ? v.join('; ')
        : typeof v === 'object' ? JSON.stringify(v)
        : v;
    }
    return out as T;
  });
}

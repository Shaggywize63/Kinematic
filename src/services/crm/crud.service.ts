/**
 * Generic org-scoped CRUD helpers used by smaller resources
 * (contacts, accounts, activities, notes, pipelines, stages, sources,
 *  templates, rules, territories, campaigns, automations, custom-fields).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError, sanitisePostgrestSearch } from '../../utils';

export interface CrudOpts {
  table: string;
  softDelete?: boolean;
  defaultSort?: { column: string; ascending: boolean };
  searchColumns?: string[];
  // Column to filter date range on. Defaults to created_at; activities can
  // override to completed_at, deals to expected_close_date, etc.
  dateRangeColumn?: string;
  // Per-user visibility scope. When set, the query is constrained to
  // rows where ANY of `columns` matches `user_id`. Used on activities
  // so non-admin users only see rows they own or are assigned to.
  // Implemented as `.or()` with `.eq.` predicates — sanitisation is
  // unnecessary because user_id is a UUID from the JWT, never user
  // input.
  userScope?: { user_id: string; columns: string[] };
  // Hierarchy-RBAC visibility scope. When set, the query is constrained
  // to rows where ANY of `ownerColumns` (default ['owner_id']) is in
  // the supplied id list. The list is the caller's subtree fetched via
  // hierarchy.service.ts#subtreeUserIds, so a manager sees their own +
  // every direct/indirect report's rows. All UUIDs come from a JWT-
  // derived RPC result, so interpolation into the postgrest `in.()`
  // syntax is safe — no escaping needed.
  visibleOwnerIds?: string[] | null;
  ownerColumns?: string[];
  // Caller-supplied extra filters applied after the standard ones.
  // Lets specific routes (e.g. /activities?view=overdue) layer in
  // date / null / range predicates the generic helper doesn't know
  // about, without forking the helper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraFilters?: (q: any) => any;
}

// Reserved query keys that aren't applied as direct .eq() filters.
// 'view' is consumed by the activities list route (Overdue / Upcoming
// / Completed KPI-tile-as-filter) and turned into date predicates via
// extraFilters — we don't want the generic helper to also try to
// .eq() against a 'view' column that doesn't exist.
const RESERVED = ['limit','page','q','sort','order','from','to','view'];

export async function list(table: string, org_id: string, query: Record<string, unknown> = {}, opts: Partial<CrudOpts> = {}) {
  let q = supabaseAdmin.from(table).select('*').eq('org_id', org_id);
  if (opts.softDelete !== false) q = q.is('deleted_at', null);
  for (const [k, v] of Object.entries(query)) {
    if (RESERVED.includes(k) || v === undefined || v === null || v === '') continue;
    // `client_id` from the query string uses "shared + own" semantics —
    // org-level reference rows (`client_id IS NULL`) stay visible
    // alongside the picked client's own rows. This is the right
    // semantic for lookup tables (states, cities, lead_sources,
    // territories, etc.) where the India seed data sits at the org
    // level and individual clients only add a few of their own. Tables
    // that need real tenant isolation (leads, deals, contacts,
    // accounts) use `clientScopedList` with `strictClient: true`
    // instead, which never falls through to NULL.
    if (k === 'client_id' && typeof v === 'string' && v.trim()) {
      q = q.or(`client_id.is.null,client_id.eq.${v}`);
      continue;
    }
    q = q.eq(k, v as never);
  }
  if (query.q && opts.searchColumns?.length) {
    // Sanitise — see utils/postgrest.ts for the threat model.
    const s = sanitisePostgrestSearch(query.q);
    if (s) {
      const orExpr = opts.searchColumns.map(c => `${c}.ilike.%${s}%`).join(',');
      q = q.or(orExpr);
    }
  }
  if (opts.userScope) {
    // user_id is JWT-derived UUID — safe to interpolate.
    const orExpr = opts.userScope.columns.map(c => `${c}.eq.${opts.userScope!.user_id}`).join(',');
    q = q.or(orExpr);
  }
  if (opts.visibleOwnerIds !== undefined && opts.visibleOwnerIds !== null) {
    if (opts.visibleOwnerIds.length === 0) return [];
    const cols = opts.ownerColumns && opts.ownerColumns.length ? opts.ownerColumns : ['owner_id'];
    const ids = opts.visibleOwnerIds.join(',');
    const orExpr = cols.map((c) => `${c}.in.(${ids})`).join(',');
    q = q.or(orExpr);
  }
  if (opts.extraFilters) q = opts.extraFilters(q);
  const dateCol = opts.dateRangeColumn ?? 'created_at';
  if (query.from) q = q.gte(dateCol, String(query.from));
  if (query.to) q = q.lte(dateCol, String(query.to));
  const limit = Math.min(Number(query.limit ?? 50), 200);
  const page = Math.max(Number(query.page ?? 1), 1);
  const sort = (query.sort as string) || opts.defaultSort?.column || 'created_at';
  const order = (query.order as string) || (opts.defaultSort?.ascending ? 'asc' : 'desc');
  q = q.order(sort, { ascending: order === 'asc' }).range((page - 1) * limit, page * limit - 1);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

/**
 * Same as list() but adds a client_id filter:
 *   - When client_id is provided: returns rows where client_id IS NULL OR client_id = X
 *     (org-level defaults remain visible alongside the client's own rows)
 *   - When client_id is null: returns only org-level rows (client_id IS NULL)
 */
export async function clientScopedList(
  table: string,
  org_id: string,
  client_id: string | null,
  query: Record<string, unknown> = {},
  opts: Partial<CrudOpts> & { strictClient?: boolean } = {},
) {
  const { rows } = await clientScopedListWithCount(table, org_id, client_id, query, opts);
  return rows;
}

/**
 * Same as clientScopedList but also returns the matching row count so
 * the route can render real "Page X of Y" pagination. Uses Supabase's
 * { count: 'exact' } so the count is computed in the same DB call as
 * the page of rows — one round trip, not two.
 *
 * Used by the activities list route (and any other resource that opts
 * into server-side pagination going forward). Existing callers of
 * clientScopedList stay unchanged — that function now delegates here
 * and just unwraps the rows.
 */
export async function clientScopedListWithCount(
  table: string,
  org_id: string,
  client_id: string | null,
  query: Record<string, unknown> = {},
  opts: Partial<CrudOpts> & { strictClient?: boolean } = {},
): Promise<{ rows: unknown[]; total: number; page: number; limit: number }> {
  const limit = Math.min(Number(query.limit ?? 50), 200);
  const page = Math.max(Number(query.page ?? 1), 1);

  let q = supabaseAdmin.from(table).select('*', { count: 'exact' }).eq('org_id', org_id);
  if (opts.softDelete !== false) q = q.is('deleted_at', null);
  if (client_id) {
    q = opts.strictClient
      ? q.eq('client_id', client_id)
      : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  }
  for (const [k, v] of Object.entries(query)) {
    if (RESERVED.includes(k) || k === 'client_id' || v === undefined || v === null || v === '') continue;
    q = q.eq(k, v as never);
  }
  if (query.q && opts.searchColumns?.length) {
    const s = sanitisePostgrestSearch(query.q);
    if (s) {
      const orExpr = opts.searchColumns.map(c => `${c}.ilike.%${s}%`).join(',');
      q = q.or(orExpr);
    }
  }
  if (opts.userScope) {
    const orExpr = opts.userScope.columns.map(c => `${c}.eq.${opts.userScope!.user_id}`).join(',');
    q = q.or(orExpr);
  }
  if (opts.visibleOwnerIds !== undefined && opts.visibleOwnerIds !== null) {
    if (opts.visibleOwnerIds.length === 0) return { rows: [], total: 0, page, limit };
    const cols = opts.ownerColumns && opts.ownerColumns.length ? opts.ownerColumns : ['owner_id'];
    const ids = opts.visibleOwnerIds.join(',');
    const orExpr = cols.map((c) => `${c}.in.(${ids})`).join(',');
    q = q.or(orExpr);
  }
  // Apply caller-supplied predicate filters (e.g. the activities list's
  // owner_id OR assigned_to, the view=overdue/upcoming/completed date
  // logic, and the city→lead_id location filter). This was missing here
  // while list() applied it — so every extraFilters-based filter on the
  // paginated activities endpoint (owner, view, city) was silently dropped.
  if (opts.extraFilters) q = opts.extraFilters(q);
  const dateCol = opts.dateRangeColumn ?? 'created_at';
  if (query.from) q = q.gte(dateCol, String(query.from));
  if (query.to) q = q.lte(dateCol, String(query.to));
  const sort = (query.sort as string) || opts.defaultSort?.column || 'created_at';
  const order = (query.order as string) || (opts.defaultSort?.ascending ? 'asc' : 'desc');
  q = q.order(sort, { ascending: order === 'asc' }).range((page - 1) * limit, page * limit - 1);
  const { data, error, count } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { rows: data ?? [], total: count ?? 0, page, limit };
}

export async function get(table: string, org_id: string, id: string, softDelete = true) {
  let q = supabaseAdmin.from(table).select('*').eq('org_id', org_id).eq('id', id);
  if (softDelete) q = q.is('deleted_at', null);
  const { data, error } = await q.single();
  if (error) throw new AppError(404, `${table} not found`, 'NOT_FOUND');
  return data;
}

// Tables that don't have created_by/updated_by columns (audit-light lookups)
// Tables that don't have created_by / updated_by columns — the generic
// audit stamp would fail with "column does not exist" otherwise. Add a
// table here only after confirming the columns aren't present in the
// schema (otherwise audit info should be captured).
const NO_AUDIT_TABLES = new Set([
  'crm_deal_stages',
  'crm_lead_sources',
  'crm_states',
  'crm_cities',
  'crm_settings',
  // crm_custom_field_defs has no created_by/updated_by columns —
  // the "+ Add Field" button on the custom-fields page was 500-ing
  // every POST because of this stamp before the row hit the DB.
  'crm_custom_field_defs',
]);

export async function create(table: string, org_id: string, payload: Record<string, unknown>, user_id?: string) {
  const row: Record<string, unknown> = { ...payload, org_id };
  if (user_id && !NO_AUDIT_TABLES.has(table)) row.created_by = user_id;
  const { data, error } = await supabaseAdmin.from(table).insert(row).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function update(table: string, org_id: string, id: string, payload: Record<string, unknown>, user_id?: string) {
  const row: Record<string, unknown> = { ...payload };
  if (user_id && !NO_AUDIT_TABLES.has(table)) row.updated_by = user_id;
  const { data, error } = await supabaseAdmin.from(table).update(row)
    .eq('org_id', org_id).eq('id', id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function softDelete(table: string, org_id: string, id: string) {
  const { error } = await supabaseAdmin.from(table)
    .update({ deleted_at: new Date().toISOString() }).eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

export async function hardDelete(table: string, org_id: string, id: string) {
  const { error } = await supabaseAdmin.from(table).delete().eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

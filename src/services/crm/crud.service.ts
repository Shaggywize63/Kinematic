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
}

// Reserved query keys that aren't applied as direct .eq() filters.
const RESERVED = ['limit','page','q','sort','order','from','to'];

export async function list(table: string, org_id: string, query: Record<string, unknown> = {}, opts: Partial<CrudOpts> = {}) {
  let q = supabaseAdmin.from(table).select('*').eq('org_id', org_id);
  if (opts.softDelete !== false) q = q.is('deleted_at', null);
  for (const [k, v] of Object.entries(query)) {
    if (RESERVED.includes(k) || v === undefined || v === null || v === '') continue;
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
  opts: Partial<CrudOpts> = {},
) {
  let q = supabaseAdmin.from(table).select('*').eq('org_id', org_id);
  if (opts.softDelete !== false) q = q.is('deleted_at', null);
  // The doc comment above already specifies the intended behaviour:
  //   client_id provided -> `client_id IS NULL OR client_id = X`
  // The implementation had drifted to strict equality, which hid every
  // legacy NULL-stamped row whenever a picker was selected. Restore the
  // OR-filter so org-level defaults stay visible.
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  for (const [k, v] of Object.entries(query)) {
    if (RESERVED.includes(k) || k === 'client_id' || v === undefined || v === null || v === '') continue;
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

export async function get(table: string, org_id: string, id: string, softDelete = true) {
  let q = supabaseAdmin.from(table).select('*').eq('org_id', org_id).eq('id', id);
  if (softDelete) q = q.is('deleted_at', null);
  const { data, error } = await q.single();
  if (error) throw new AppError(404, `${table} not found`, 'NOT_FOUND');
  return data;
}

// Tables that don't have created_by/updated_by columns (audit-light lookups)
const NO_AUDIT_TABLES = new Set([
  'crm_deal_stages',
  'crm_lead_sources',
  'crm_states',
  'crm_cities',
  'crm_settings',
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

/**
 * Generic org-scoped CRUD helpers used by smaller resources
 * (contacts, accounts, activities, notes, pipelines, stages, sources,
 *  templates, rules, territories, campaigns, automations, custom-fields).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export interface CrudOpts {
  table: string;
  softDelete?: boolean;
  defaultSort?: { column: string; ascending: boolean };
  searchColumns?: string[];
}

export async function list(table: string, org_id: string, query: Record<string, unknown> = {}, opts: Partial<CrudOpts> = {}) {
  let q = supabaseAdmin.from(table).select('*', { count: 'exact' }).eq('org_id', org_id);
  if (opts.softDelete !== false) q = q.is('deleted_at', null);
  for (const [k, v] of Object.entries(query)) {
    if (['limit','page','q','sort','order'].includes(k) || v === undefined || v === null || v === '') continue;
    q = q.eq(k, v as never);
  }
  if (query.q && opts.searchColumns?.length) {
    const s = String(query.q).replace(/[%_]/g, '');
    const orExpr = opts.searchColumns.map(c => `${c}.ilike.%${s}%`).join(',');
    q = q.or(orExpr);
  }
  const limit = Math.min(Number(query.limit ?? 50), 200);
  const page = Math.max(Number(query.page ?? 1), 1);
  const sort = (query.sort as string) || opts.defaultSort?.column || 'created_at';
  const order = (query.order as string) || (opts.defaultSort?.ascending ? 'asc' : 'desc');
  q = q.order(sort, { ascending: order === 'asc' }).range((page - 1) * limit, page * limit - 1);
  const { data, error, count } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { data: data ?? [], total: count ?? 0, page, limit };
}

export async function get(table: string, org_id: string, id: string, softDelete = true) {
  let q = supabaseAdmin.from(table).select('*').eq('org_id', org_id).eq('id', id);
  if (softDelete) q = q.is('deleted_at', null);
  const { data, error } = await q.single();
  if (error) throw new AppError(404, `${table} not found`, 'NOT_FOUND');
  return data;
}

export async function create(table: string, org_id: string, payload: Record<string, unknown>, user_id?: string) {
  const row = { ...payload, org_id, created_by: user_id ?? null };
  const { data, error } = await supabaseAdmin.from(table).insert(row).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function update(table: string, org_id: string, id: string, payload: Record<string, unknown>, user_id?: string) {
  const row = { ...payload, updated_by: user_id ?? null };
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

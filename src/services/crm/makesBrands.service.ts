/**
 * Makes (manufacturers) and Brands (product brands) for the CRM product catalogue, plus the checks the
 * `/products` routes run in front of the generic CRUD: make/brand ids must exist, the product reference
 * (`sku`) must be unique, and product JSON carries `make_name` / `brand_name`.
 *
 * Tables: crm_makes, crm_brands (migration_makes_brands.sql). Until that migration is applied every write path
 * answers 503 NOT_MIGRATED instead of a raw 500, and product READS keep working (names come back null).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils';
import { sanitisePostgrestSearch } from '../../utils/postgrest';
import { chunk } from '../../lib/chunk';
import { isMissingSchemaError } from './accountMerge.service';
export { isMissingSchemaError };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
interface DbErr { code?: string; message?: string }

export type TaxonomyKind = 'make' | 'brand';
interface KindInfo { table: string; column: string; label: string; Label: string; plural: string }
export const KINDS: Record<TaxonomyKind, KindInfo> = {
  make: { table: 'crm_makes', column: 'make_id', label: 'make', Label: 'Make', plural: 'makes' },
  brand: { table: 'crm_brands', column: 'brand_id', label: 'brand', Label: 'Brand', plural: 'brands' },
};

export const NOT_MIGRATED_MESSAGE = 'Makes and brands are not set up in this database yet. Apply migration_makes_brands.sql.';
export const notMigrated = (): AppError => new AppError(503, NOT_MIGRATED_MESSAGE, 'NOT_MIGRATED');

/** Any database error becomes NOT_MIGRATED (missing table/column) or a plain DB_ERROR. Never a raw 500 for a missing schema. */
export function dbError(e: DbErr): AppError {
  if (isMissingSchemaError(e)) return notMigrated();
  return new AppError(500, String(e?.message ?? 'Database error'), 'DB_ERROR');
}

export interface Scope { orgId: string; clientId: string | null; strict: boolean }

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** Escape LIKE wildcards so an ilike is an exact (case-insensitive) match. `*` cannot be escaped in PostgREST, so callers re-compare in JS. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Visibility of lookup rows: the picked client's own rows (and, unless strict, the org-level ones). No client = the whole org. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function visible(q: any, scope: Scope) {
  if (!scope.clientId) return q;
  return scope.strict ? q.eq('client_id', scope.clientId) : q.or(`client_id.is.null,client_id.eq.${scope.clientId}`);
}
/** Rows that belong to exactly this client (null = the org-level list): the uniqueness key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exactClient(q: any, clientId: string | null) {
  return clientId ? q.eq('client_id', clientId) : q.is('client_id', null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Counts
// ─────────────────────────────────────────────────────────────────────────────

/** Non-deleted products per make/brand id, for a batch of ids. */
export async function productCounts(kind: TaxonomyKind, orgId: string, ids: string[]): Promise<Map<string, number>> {
  const { column } = KINDS[kind];
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  const PAGE = 1000;
  for (const part of chunk(ids, 100)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin.from('crm_products').select(column)
        .eq('org_id', orgId).in(column, part).is('deleted_at', null).order('id', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw dbError(error);
      const rows = (data ?? []) as Row[];
      for (const r of rows) {
        const k = String(r[column]);
        out.set(k, (out.get(k) ?? 0) + 1);
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

async function countUsing(kind: TaxonomyKind, orgId: string, id: string): Promise<number> {
  const { column } = KINDS[kind];
  const { count, error } = await supabaseAdmin.from('crm_products').select('id', { count: 'exact', head: true })
    .eq('org_id', orgId).eq(column, id).is('deleted_at', null);
  if (error) throw dbError(error);
  return count ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Makes / brands CRUD
// ─────────────────────────────────────────────────────────────────────────────

export interface TaxonomyInput { name?: string; description?: string | null; is_active?: boolean; sort_order?: number }

/** An existing (non-deleted) row of the same name in this exact client list, case-insensitive. */
export async function findByName(kind: TaxonomyKind, orgId: string, clientId: string | null, name: string, excludeId?: string): Promise<Row | null> {
  const { table } = KINDS[kind];
  const wanted = lower(name);
  const q = exactClient(supabaseAdmin.from(table).select('id,name,client_id')
    .eq('org_id', orgId).is('deleted_at', null).ilike('name', escapeLike(name.trim())), clientId);
  const { data, error } = await q.limit(50);
  if (error) throw dbError(error);
  return ((data ?? []) as Row[]).find((r) => lower(r.name) === wanted && r.id !== excludeId) ?? null;
}

const duplicate = (kind: TaxonomyKind, name: string): AppError =>
  new AppError(409, `A ${KINDS[kind].label} named "${name}" already exists`, 'DUPLICATE');

async function getRow(kind: TaxonomyKind, scope: Scope, id: string): Promise<Row> {
  const { table, Label } = KINDS[kind];
  if (!UUID_RE.test(id)) throw new AppError(404, `${Label} not found`, 'NOT_FOUND');
  const { data, error } = await visible(supabaseAdmin.from(table).select('*')
    .eq('org_id', scope.orgId).eq('id', id).is('deleted_at', null), scope).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new AppError(404, `${Label} not found`, 'NOT_FOUND');
  return data as Row;
}

export interface ListQuery { q?: unknown; is_active?: unknown; limit?: unknown; page?: unknown }

/** Sorted by sort_order then name; every row carries `product_count`. */
export async function listTaxonomy(kind: TaxonomyKind, scope: Scope, query: ListQuery = {}): Promise<Row[]> {
  const { table } = KINDS[kind];
  let q = visible(supabaseAdmin.from(table).select('*').eq('org_id', scope.orgId).is('deleted_at', null), scope);
  const active = String(query.is_active ?? '').toLowerCase();
  if (active === 'true' || active === 'false') q = q.eq('is_active', active === 'true');
  const s = sanitisePostgrestSearch(query.q);
  if (s) q = q.ilike('name', `%${s}%`);
  const limit = Math.min(Math.max(Number(query.limit ?? 500) || 500, 1), 1000);
  const page = Math.max(Number(query.page ?? 1) || 1, 1);
  const { data, error } = await q.order('sort_order', { ascending: true }).order('name', { ascending: true })
    .range((page - 1) * limit, page * limit - 1);
  if (error) throw dbError(error);
  const rows = (data ?? []) as Row[];
  const counts = await productCounts(kind, scope.orgId, rows.map((r) => String(r.id)));
  return rows.map((r) => ({ ...r, product_count: counts.get(String(r.id)) ?? 0 }));
}

export async function createTaxonomy(kind: TaxonomyKind, scope: Scope, userId: string | undefined, input: TaxonomyInput): Promise<Row> {
  const { table } = KINDS[kind];
  const name = String(input.name ?? '').trim();
  if (await findByName(kind, scope.orgId, scope.clientId, name)) throw duplicate(kind, name);
  const row: Row = {
    org_id: scope.orgId, client_id: scope.clientId, name,
    description: input.description ?? null,
    is_active: input.is_active ?? true,
    sort_order: input.sort_order ?? 0,
    ...(userId ? { created_by: userId } : {}),
  };
  const { data, error } = await supabaseAdmin.from(table).insert(row).select('*').single();
  if (error) {
    // Two writers racing past the pre-check hit the unique index.
    if (error.code === '23505') throw duplicate(kind, name);
    throw dbError(error);
  }
  return { ...(data as Row), product_count: 0 };
}

export async function updateTaxonomy(kind: TaxonomyKind, scope: Scope, id: string, input: TaxonomyInput): Promise<Row> {
  const { table } = KINDS[kind];
  const current = await getRow(kind, scope, id);
  const patch: Row = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (lower(name) !== lower(current.name) || name !== current.name) {
      if (await findByName(kind, scope.orgId, current.client_id ?? null, name, current.id)) throw duplicate(kind, name);
    }
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  if (input.sort_order !== undefined) patch.sort_order = input.sort_order;

  let row = current;
  if (Object.keys(patch).length) {
    const { data, error } = await supabaseAdmin.from(table).update(patch)
      .eq('org_id', scope.orgId).eq('id', id).is('deleted_at', null).select('*').single();
    if (error) {
      if (error.code === '23505') throw duplicate(kind, String(patch.name ?? current.name));
      throw dbError(error);
    }
    row = data as Row;
  }
  return { ...row, product_count: await countUsing(kind, scope.orgId, id) };
}

/** Soft delete; refused while non-deleted products still use it. */
export async function deleteTaxonomy(kind: TaxonomyKind, scope: Scope, id: string): Promise<void> {
  const { table } = KINDS[kind];
  await getRow(kind, scope, id);
  const used = await countUsing(kind, scope.orgId, id);
  if (used > 0) throw new AppError(409, `Used by ${used} products. Switch it off instead.`, 'IN_USE');
  const { error } = await supabaseAdmin.from(table).update({ deleted_at: new Date().toISOString() })
    .eq('org_id', scope.orgId).eq('id', id);
  if (error) throw dbError(error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Product hooks
// ─────────────────────────────────────────────────────────────────────────────

/** A product's make_id / brand_id must name a live make/brand in the caller's org (and client). */
export async function assertTaxonomyExists(kind: TaxonomyKind, scope: Scope, id: string): Promise<void> {
  const { table, Label } = KINDS[kind];
  const { data, error } = await visible(supabaseAdmin.from(table).select('id')
    .eq('org_id', scope.orgId).eq('id', id).is('deleted_at', null), scope).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new AppError(400, `${Label} not found`, 'VALIDATION');
}

/** Validate make_id / brand_id on a product body. null / absent / non-uuid values are left to the schema. */
export async function assertProductLinks(scope: Scope, body: Record<string, unknown>): Promise<void> {
  for (const kind of ['make', 'brand'] as TaxonomyKind[]) {
    const v = body[KINDS[kind].column];
    if (typeof v === 'string' && UUID_RE.test(v)) await assertTaxonomyExists(kind, scope, v);
  }
}

/**
 * The product reference (sku) is unique per org + client, case-insensitive, among non-deleted products.
 * `clientId` is the client the product row belongs to (null = the org-level list).
 */
export async function assertReferenceUnique(orgId: string, clientId: string | null, reference: string, excludeId?: string): Promise<void> {
  const ref = reference.trim();
  if (!ref) return;
  const q = exactClient(supabaseAdmin.from('crm_products').select('id,sku')
    .eq('org_id', orgId).is('deleted_at', null).ilike('sku', escapeLike(ref)), clientId);
  const { data, error } = await q.limit(50);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const hit = ((data ?? []) as Row[]).find((r) => lower(r.sku) === lower(ref) && r.id !== excludeId);
  if (hit) throw new AppError(409, `A product with reference "${ref}" already exists`, 'DUPLICATE');
}

/** The client a product row belongs to, for a PATCH reference check. undefined = no such live product. */
export async function productClientId(orgId: string, productId: string): Promise<string | null | undefined> {
  if (!UUID_RE.test(productId)) return undefined;
  const { data, error } = await supabaseAdmin.from('crm_products').select('id,client_id')
    .eq('org_id', orgId).eq('id', productId).is('deleted_at', null).maybeSingle();
  if (error || !data) return undefined;
  return (data as Row).client_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Names on product JSON
// ─────────────────────────────────────────────────────────────────────────────

async function lookupNames(table: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(ids, 100)) {
    try {
      const { data, error } = await supabaseAdmin.from(table).select('id,name').in('id', part);
      if (error) { logger.warn({ table, err: error.message }, 'products: make/brand name lookup failed'); continue; }
      for (const r of (data ?? []) as Row[]) out.set(String(r.id), String(r.name ?? ''));
    } catch (e) {
      logger.warn({ table, err: (e as Error).message }, 'products: make/brand name lookup threw');
    }
  }
  return out;
}

/** Add `make_name` / `brand_name` to product rows with two batched lookups. Never throws; a failure leaves the names null. */
export async function stampMakeBrandNames<T extends Row>(rows: T[]): Promise<Array<T & { make_name: string | null; brand_name: string | null }>> {
  const ids = (col: string): string[] => [...new Set(rows.map((r) => r?.[col]).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))];
  let makes = new Map<string, string>();
  let brands = new Map<string, string>();
  try {
    const makeIds = ids('make_id');
    const brandIds = ids('brand_id');
    [makes, brands] = await Promise.all([
      makeIds.length ? lookupNames('crm_makes', makeIds) : Promise.resolve(new Map<string, string>()),
      brandIds.length ? lookupNames('crm_brands', brandIds) : Promise.resolve(new Map<string, string>()),
    ]);
  } catch { /* names stay null */ }
  return rows.map((r) => ({
    ...r,
    make_name: (typeof r?.make_id === 'string' && makes.get(r.make_id)) || null,
    brand_name: (typeof r?.brand_id === 'string' && brands.get(r.brand_id)) || null,
  }));
}

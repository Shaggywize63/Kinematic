/**
 * Bulk product import: the client pastes / uploads a spreadsheet of products, each with a reference (the
 * `sku`), a name and optionally a make, brand, unit, price, category and description.
 *
 * Rows are independent: one bad row never blocks the others. Makes and brands are matched by case-insensitive
 * trimmed name (created when `create_missing`), categories by name (unknown ones are ignored, never created),
 * and a row whose reference already exists updates that product (when `update_existing`).
 *
 * Every row that is not imported (an error, or skipped) appears in `errors` with a message; `skipped` counts the
 * ones that were deliberately passed over (superseded duplicates in the file, existing products when updates
 * are off).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { chunk } from '../../lib/chunk';
import { productSchema } from '../../validators/crm.validators';
import { isMissingSchemaError } from './accountMerge.service';
import { KINDS, TaxonomyKind, notMigrated, dbError } from './makesBrands.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const MAX_IMPORT_ROWS = 2000;

export interface ImportRowInput {
  reference?: unknown; name?: unknown; make?: unknown; brand?: unknown;
  unit?: unknown; price?: unknown; category?: unknown; description?: unknown;
}
export interface ImportInput { rows: unknown[]; create_missing?: boolean; update_existing?: boolean }
export interface ImportRowError { row: number; reference: string; message: string }
export interface ImportResult {
  created: number; updated: number; skipped: number;
  errors: ImportRowError[]; makes_created: string[]; brands_created: string[];
}
export interface ImportCtx { orgId: string; clientId: string | null; strict?: boolean; userId?: string }

const lower = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** A spreadsheet cell as trimmed text; numbers (a reference typed as 13280) are accepted; anything else is blank. */
function cell(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** Parse a price cell: 1250, "1250", "1,250.50", "₹ 1,250.50", "Rs. 99". Blank = not given. */
export function parsePrice(v: unknown): { value: number | undefined; error?: string } {
  if (v === undefined || v === null) return { value: undefined };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { value: undefined, error: `Price "${v}" is not a number` };
    if (v < 0) return { value: undefined, error: 'Price cannot be negative' };
    return { value: v };
  }
  if (typeof v !== 'string') return { value: undefined, error: 'Price is not a number' };
  const raw = v.trim();
  if (!raw) return { value: undefined };
  const cleaned = raw.replace(/inr|rs\.?|[₹$,\s]/gi, '');
  if (/^-/.test(cleaned)) return { value: undefined, error: 'Price cannot be negative' };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return { value: undefined, error: `Price "${raw}" is not a number` };
  return { value: Number(cleaned) };
}

interface Prepared {
  row: number; reference: string; name: string;
  make?: string; brand?: string; unit?: string; price?: number; category?: string; description?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exactClient(q: any, clientId: string | null) {
  return clientId ? q.eq('client_id', clientId) : q.is('client_id', null);
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function loadAll(table: string, select: string, orgId: string, clientId: string | null): Promise<Row[]> {
  const out: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabaseAdmin.from(table).select(select).eq('org_id', orgId);
    q = q.is('deleted_at', null);
    q = exactClient(q, clientId);
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function importProducts(ctx: ImportCtx, input: ImportInput): Promise<ImportResult> {
  const rows = input.rows;
  if (!Array.isArray(rows)) throw new AppError(400, 'rows must be an array', 'VALIDATION');
  if (rows.length === 0) throw new AppError(400, 'There are no rows to import', 'VALIDATION');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(400, `An import is limited to ${MAX_IMPORT_ROWS} rows at a time (got ${rows.length}). Split the file and import it in parts.`, 'VALIDATION');
  }
  const createMissing = input.create_missing !== false;
  const updateExisting = input.update_existing !== false;

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], makes_created: [], brands_created: [] };
  const fail = (row: number, reference: string, message: string) => result.errors.push({ row, reference, message });

  // 1. Per-row validation and normalisation.
  const prepared: Prepared[] = [];
  rows.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { fail(n, '', 'Row is not an object'); return; }
    const r = raw as ImportRowInput;
    const reference = cell(r.reference);
    const name = cell(r.name);
    if (!reference) { fail(n, '', 'Reference is required'); return; }
    if (!name) { fail(n, reference, 'Name is required'); return; }
    if (reference.length > 120) { fail(n, reference, 'Reference is longer than 120 characters'); return; }
    if (name.length > 200) { fail(n, reference, 'Name is longer than 200 characters'); return; }
    const price = parsePrice(r.price);
    if (price.error) { fail(n, reference, price.error); return; }
    const unit = cell(r.unit);
    if (unit.length > 40) { fail(n, reference, 'Unit is longer than 40 characters'); return; }
    const make = cell(r.make);
    const brand = cell(r.brand);
    if (make.length > 120) { fail(n, reference, 'Make is longer than 120 characters'); return; }
    if (brand.length > 120) { fail(n, reference, 'Brand is longer than 120 characters'); return; }
    prepared.push({
      row: n, reference, name,
      ...(make ? { make } : {}), ...(brand ? { brand } : {}),
      ...(unit ? { unit } : {}), ...(price.value !== undefined ? { price: price.value } : {}),
      ...(cell(r.category) ? { category: cell(r.category) } : {}),
      ...(cell(r.description) ? { description: cell(r.description) } : {}),
    });
  });

  // 2. The same reference twice in the file: the later row wins, the earlier one is skipped.
  const lastRowFor = new Map<string, number>();
  for (const p of prepared) lastRowFor.set(lower(p.reference), p.row);
  const work: Prepared[] = [];
  for (const p of prepared) {
    const winner = lastRowFor.get(lower(p.reference))!;
    if (winner === p.row) work.push(p);
    else {
      result.skipped++;
      fail(p.row, p.reference, `Skipped: the same reference appears again on row ${winner}, and that row is used instead`);
    }
  }

  if (work.length) {
    try {
      await importWork(ctx, work, { createMissing, updateExisting }, result, fail);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw dbError(e as { code?: string; message?: string });
    }
  }

  result.errors.sort((a, b) => a.row - b.row);
  return result;
}

async function importWork(
  ctx: ImportCtx, work: Prepared[], opts: { createMissing: boolean; updateExisting: boolean },
  result: ImportResult, fail: (row: number, reference: string, message: string) => void,
): Promise<void> {
  const { orgId, clientId, userId } = ctx;

  // Existing products (this client's list) keyed by case-insensitive reference.
  const existing = new Map<string, Row>();
  for (const p of await loadAll('crm_products', 'id,sku', orgId, clientId)) {
    const k = lower(p.sku);
    if (k && !existing.has(k)) existing.set(k, p);
  }

  // Categories by name (best effort: unknown names are ignored, a failed lookup just means "no category").
  const categories = new Map<string, string>();
  if (work.some((p) => p.category)) {
    try {
      let q = supabaseAdmin.from('crm_product_categories').select('id,name,client_id').eq('org_id', orgId).is('deleted_at', null);
      if (clientId) q = q.or(`client_id.is.null,client_id.eq.${clientId}`);
      const { data, error } = await q.limit(1000);
      if (!error) {
        // The client's own category beats an org-level one of the same name.
        for (const c of ((data ?? []) as Row[]).sort((a, b) => Number(!!a.client_id) - Number(!!b.client_id))) categories.set(lower(c.name), String(c.id));
      }
    } catch { /* ignore */ }
  }

  // Makes / brands, loaded only when the file uses them (so a plain import works before the migration).
  const taxonomy: Record<TaxonomyKind, Map<string, string>> = { make: new Map(), brand: new Map() };
  const created: Record<TaxonomyKind, string[]> = { make: result.makes_created, brand: result.brands_created };
  const needs: Record<TaxonomyKind, boolean> = { make: work.some((p) => p.make), brand: work.some((p) => p.brand) };
  for (const kind of ['make', 'brand'] as TaxonomyKind[]) {
    if (!needs[kind]) continue;
    let rows: Row[];
    try { rows = await loadAll(KINDS[kind].table, 'id,name', orgId, clientId); }
    catch (e) { throw dbError(e as { code?: string; message?: string }); }
    for (const r of rows) if (!taxonomy[kind].has(lower(r.name))) taxonomy[kind].set(lower(r.name), String(r.id));
  }

  const resolve = async (kind: TaxonomyKind, name: string): Promise<{ id?: string; error?: string }> => {
    const key = lower(name);
    const hit = taxonomy[kind].get(key);
    if (hit) return { id: hit };
    const { table, Label } = KINDS[kind];
    if (!opts.createMissing) return { error: `${Label} "${name}" does not exist` };
    const { data, error } = await supabaseAdmin.from(table).insert({
      org_id: orgId, client_id: clientId, name, is_active: true, sort_order: 0, ...(userId ? { created_by: userId } : {}),
    }).select('id').single();
    if (error) {
      if (isMissingSchemaError(error)) throw notMigrated();
      if (error.code === '23505') { // created by a concurrent request: use that one
        const again = (await loadAll(table, 'id,name', orgId, clientId)).find((r) => lower(r.name) === key);
        if (again) { taxonomy[kind].set(key, String(again.id)); return { id: String(again.id) }; }
      }
      return { error: `Could not create ${KINDS[kind].label} "${name}": ${error.message}` };
    }
    taxonomy[kind].set(key, String((data as Row).id));
    created[kind].push(name);
    return { id: String((data as Row).id) };
  };

  const creates: Array<{ p: Prepared; payload: Row }> = [];
  const updates: Array<{ p: Prepared; id: string; patch: Row }> = [];

  for (const p of work) {
    const found = existing.get(lower(p.reference));
    if (found && !opts.updateExisting) {
      result.skipped++;
      fail(p.row, p.reference, 'Skipped: a product with this reference already exists and updating existing products is switched off');
      continue;
    }
    let makeId: string | undefined;
    let brandId: string | undefined;
    if (p.make) {
      const r = await resolve('make', p.make);
      if (r.error) { fail(p.row, p.reference, r.error); continue; }
      makeId = r.id;
    }
    if (p.brand) {
      const r = await resolve('brand', p.brand);
      if (r.error) { fail(p.row, p.reference, r.error); continue; }
      brandId = r.id;
    }
    const categoryId = p.category ? categories.get(lower(p.category)) : undefined;

    if (found) {
      const patch: Row = { name: p.name };
      if (p.description !== undefined) patch.description = p.description;
      if (p.unit !== undefined) patch.unit = p.unit;
      if (p.price !== undefined) patch.price = p.price;
      if (categoryId) patch.category_id = categoryId;
      if (makeId) patch.make_id = makeId;
      if (brandId) patch.brand_id = brandId;
      if (userId) patch.updated_by = userId;
      updates.push({ p, id: String(found.id), patch });
      continue;
    }
    const parsed = productSchema.safeParse({
      sku: p.reference, name: p.name, description: p.description, unit: p.unit, price: p.price, category_id: categoryId,
    });
    if (!parsed.success) {
      fail(p.row, p.reference, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      continue;
    }
    creates.push({
      p,
      payload: {
        ...parsed.data, org_id: orgId, client_id: clientId,
        ...(makeId ? { make_id: makeId } : {}), ...(brandId ? { brand_id: brandId } : {}),
        ...(userId ? { created_by: userId } : {}),
      },
    });
  }

  // Updates: one statement per row (every row carries different values), a few at a time.
  await pool(updates, 8, async ({ p, id, patch }) => {
    const { error } = await supabaseAdmin.from('crm_products').update(patch).eq('org_id', orgId).eq('id', id);
    if (!error) { result.updated++; return; }
    if (isMissingSchemaError(error) && ('make_id' in patch || 'brand_id' in patch)) throw notMigrated();
    fail(p.row, p.reference, error.message);
  });

  // Creates: batched; when a batch is refused, retry its rows one by one so only the bad ones are reported.
  for (const batch of chunk(creates, 100)) {
    const { error } = await supabaseAdmin.from('crm_products').insert(batch.map((b) => b.payload)).select('id');
    if (!error) { result.created += batch.length; continue; }
    if (isMissingSchemaError(error) && batch.some((b) => 'make_id' in b.payload || 'brand_id' in b.payload)) throw notMigrated();
    for (const b of batch) {
      const one = await supabaseAdmin.from('crm_products').insert(b.payload).select('id').single();
      if (!one.error) result.created++;
      else if (isMissingSchemaError(one.error) && ('make_id' in b.payload || 'brand_id' in b.payload)) throw notMigrated();
      else fail(b.p.row, b.p.reference, one.error.message);
    }
  }
}

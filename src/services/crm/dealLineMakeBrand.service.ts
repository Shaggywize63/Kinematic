/**
 * Connected-B2B (Spark & Ray) deal lines: make, brand, MAC funnel reference and order value.
 *
 * Each product line on a deal carries, besides the product (reference = `sku`) and the quoted value
 * (`line_total`):
 *   - the Make (manufacturer) and Brand (MAC, PHD, BEKO, ...) from `crm_makes` / `crm_brands`;
 *   - a typed-in MAC funnel reference (REQUIRED when the brand is MAC, optional otherwise);
 *   - the ORDER value (what was actually ordered, filled in when the deal is won).
 *
 * There is no migration: the data lives in the line's existing `custom_fields` jsonb as
 * `make_id`, `make_name`, `brand_id`, `brand_name`, `funnel_ref`, `order_value` (names are snapshots taken at save
 * time). Other keys already in `custom_fields` are never touched. Every other tenant ignores all of this.
 *
 * Also here: the per-deal roll-up (`line_count`, `quoted_amount`, `order_amount`, `brands`) stamped on the deals the
 * lists and detail return, with ONE batched read of `crm_deal_line_items`.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { chunk } from '../../lib/chunk';
import { AppError } from '../../utils';
import { isB2bClient } from '../../lib/b2bClients';
import { isMissingSchemaError } from './accountMerge.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Body keys a line accepts (top level of the line, not inside custom_fields). */
export const LINE_EXTRA_INPUT_KEYS = ['make_id', 'brand_id', 'funnel_ref', 'order_value'] as const;
/** Keys stored in the line's custom_fields. */
export const LINE_EXTRA_STORED_KEYS = ['make_id', 'make_name', 'brand_id', 'brand_name', 'funnel_ref', 'order_value'] as const;

export const MAC_FUNNEL_REQUIRED = 'MAC funnel reference is required for MAC products';

export interface LineExtras {
  make_id?: string | null;
  brand_id?: string | null;
  funnel_ref?: string | null;
  order_value?: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split a line body into the four make/brand/funnel/order keys and everything else. */
export function splitLineExtras<T extends object>(payload: T): { rest: Omit<T, keyof LineExtras>; extras: LineExtras } {
  const rest: Row = { ...(payload as Row) };
  const extras: Row = {};
  for (const k of LINE_EXTRA_INPUT_KEYS) {
    if (k in rest) {
      if (rest[k] !== undefined) extras[k] = rest[k];
      delete rest[k];
    }
  }
  return { rest: rest as Omit<T, keyof LineExtras>, extras };
}

/** Is this the MAC brand (trimmed, case-insensitive)? */
export const isMacBrand = (name: unknown): boolean => typeof name === 'string' && name.trim().toLowerCase() === 'mac';

// ─────────────────────────────────────────────────────────────────────────────
// Make / brand lookups
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'make' | 'brand';
const TABLE: Record<Kind, string> = { make: 'crm_makes', brand: 'crm_brands' };
const LABEL: Record<Kind, string> = { make: 'Make', brand: 'Brand' };

type Lookup = { status: 'ok'; name: string } | { status: 'notfound' } | { status: 'no_table' };

/** One live make/brand of the caller's org. `no_table` = the lists are not in this database (yet). */
async function lookup(kind: Kind, orgId: string, id: string, strict: boolean): Promise<Lookup> {
  if (!UUID_RE.test(id)) return { status: 'notfound' };
  try {
    const { data, error } = await supabaseAdmin.from(TABLE[kind]).select('id,name')
      .eq('org_id', orgId).eq('id', id).is('deleted_at', null).maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) return { status: 'no_table' };
      if (strict) throw new AppError(500, String(error.message ?? 'Database error'), 'DB_ERROR');
      logger.warn({ table: TABLE[kind], err: error.message }, 'dealLines: make/brand lookup failed');
      return { status: 'notfound' };
    }
    if (!data) return { status: 'notfound' };
    return { status: 'ok', name: String((data as Row).name ?? '').trim() };
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (strict) throw new AppError(500, (e as Error).message, 'DB_ERROR');
    logger.warn({ table: TABLE[kind], err: (e as Error).message }, 'dealLines: make/brand lookup threw');
    return { status: 'notfound' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolving a line's custom_fields
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveInput {
  orgId: string;
  /** The make / brand / funnel / order keys sent on this request (undefined key = not sent, null = clear). */
  extras: LineExtras;
  /** custom_fields sent explicitly on this request (replaces the base on PATCH, like before). */
  sentCustomFields?: Record<string, unknown> | null;
  /** custom_fields currently stored on the line (PATCH). */
  existingCustomFields?: Record<string, unknown> | null;
  /** The product to default make/brand from (create, or a PATCH that switches product). */
  product?: Row | null;
  /** 1-based position in a multi-line request, for the error message. */
  lineNo?: number;
}

const blankToNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};
const orderOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The custom_fields to store for a line: the other keys (sent, else existing) untouched, plus the six keys resolved from
 * the request, the existing values and the product defaults. Throws 400 VALIDATION for an unknown make/brand and for a MAC
 * line without a funnel reference.
 */
export async function resolveLineCustomFields(input: ResolveInput): Promise<Record<string, unknown>> {
  const { orgId, extras, product, lineNo } = input;
  const existing: Row = (input.existingCustomFields && typeof input.existingCustomFields === 'object') ? input.existingCustomFields : {};
  const base: Row = input.sentCustomFields !== undefined && input.sentCustomFields !== null
    ? { ...input.sentCustomFields }
    : { ...existing };
  for (const k of LINE_EXTRA_STORED_KEYS) delete base[k];

  // Current values start from what is stored; the request and product defaults overlay them.
  const cur: Row = {};
  for (const k of LINE_EXTRA_STORED_KEYS) cur[k] = existing[k] ?? null;

  for (const kind of ['make', 'brand'] as Kind[]) {
    const idKey = `${kind}_id` as 'make_id' | 'brand_id';
    const nameKey = `${kind}_name`;
    if (idKey in extras) {
      const wanted = extras[idKey];
      if (wanted === null) { cur[idKey] = null; cur[nameKey] = null; continue; }
      const hit = await lookup(kind, orgId, String(wanted), true);
      if (hit.status === 'notfound') throw new AppError(400, `${lineNo ? `Line ${lineNo}: ` : ''}${LABEL[kind]} not found`, 'VALIDATION');
      if (hit.status === 'no_table') continue; // lists not set up yet: skip storage silently
      cur[idKey] = String(wanted); cur[nameKey] = hit.name;
    } else if (product && typeof product[idKey] === 'string' && product[idKey]) {
      // No explicit value: default from the product (a missing product column / list = no default).
      const hit = await lookup(kind, orgId, String(product[idKey]), false);
      if (hit.status === 'ok') { cur[idKey] = String(product[idKey]); cur[nameKey] = hit.name; }
    }
  }
  if ('funnel_ref' in extras) cur.funnel_ref = blankToNull(extras.funnel_ref);
  if ('order_value' in extras) cur.order_value = orderOrNull(extras.order_value);

  if (isMacBrand(cur.brand_name) && !blankToNull(cur.funnel_ref)) {
    throw new AppError(400, `${lineNo ? `Line ${lineNo}: ` : ''}${MAC_FUNNEL_REQUIRED}`, 'VALIDATION');
  }

  const out: Row = { ...base };
  for (const k of LINE_EXTRA_STORED_KEYS) {
    if (cur[k] !== null && cur[k] !== undefined) out[k] = cur[k];
  }
  return out;
}

/** Make / brand / funnel / order as top-level keys on a line, plus `reference` (= sku). Only call for connected-B2B lines. */
export function presentLine<T extends Row>(row: T): T & {
  make_id: string | null; brand_id: string | null; make_name: string | null; brand_name: string | null;
  funnel_ref: string | null; order_value: number | null; reference: string | null;
} {
  const cf: Row = (row?.custom_fields && typeof row.custom_fields === 'object') ? row.custom_fields : {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    ...row,
    make_id: str(cf.make_id),
    brand_id: str(cf.brand_id),
    make_name: str(cf.make_name),
    brand_name: str(cf.brand_name),
    funnel_ref: str(cf.funnel_ref),
    order_value: orderOrNull(cf.order_value),
    reference: row?.sku ?? null,
  };
}

/** Is a deal of this client on the connected-B2B flow? The deal's own client wins over the request's. */
export async function dealLinesAreB2b(orgId: string, dealId: string, requestClientId?: string | null): Promise<boolean> {
  let dealClient: string | null = null;
  try {
    const { data } = await supabaseAdmin.from('crm_deals').select('id, client_id')
      .eq('org_id', orgId).eq('id', dealId).maybeSingle();
    dealClient = ((data as Row | null)?.client_id as string | null | undefined) ?? null;
  } catch { /* falls back to the request's client */ }
  return isB2bClient(dealClient ?? requestClientId ?? null);
}

/**
 * Validate and resolve every line of a deal create BEFORE the deal is written, so a bad line 2 never leaves a half-created
 * deal. Returns one custom_fields object per item (same order). Product make/brand defaults come from one batched read.
 */
export async function prepareDealItems(
  orgId: string,
  items: Array<LineExtras & { product_id?: string | null }>,
): Promise<Array<Record<string, unknown>>> {
  const productIds = [...new Set(items.map((i) => i.product_id).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))];
  const products = new Map<string, Row>();
  for (const part of chunk(productIds, 100)) {
    try {
      const { data } = await supabaseAdmin.from('crm_products').select('*')
        .eq('org_id', orgId).in('id', part).is('deleted_at', null);
      for (const p of (data ?? []) as Row[]) products.set(String(p.id), p);
    } catch { /* no defaults */ }
  }
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < items.length; i++) {
    const { extras } = splitLineExtras(items[i]);
    out.push(await resolveLineCustomFields({
      orgId, extras, lineNo: i + 1,
      product: items[i].product_id ? products.get(items[i].product_id as string) ?? null : null,
    }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deal roll-up
// ─────────────────────────────────────────────────────────────────────────────

export interface DealRollup { line_count: number; quoted_amount: number | null; order_amount: number | null; brands: string[] }

const emptyRollup = (deal: Row): DealRollup => ({ line_count: 0, quoted_amount: deal.amount ?? null, order_amount: null, brands: [] });

/**
 * Add `line_count`, `quoted_amount` (= the deal amount), `order_amount` (sum of the lines' order values, null when none
 * has one) and `brands` (distinct brand names) to the connected-B2B deals in `rows`. Other tenants' rows are returned
 * untouched and cost no query. One batched read; any failure leaves zero / null roll-ups and never throws.
 */
export async function stampDealRollups<T extends Row>(orgId: string, rows: T[]): Promise<T[]> {
  if (!Array.isArray(rows)) return rows;
  const b2b = rows.filter((r) => r && typeof r.id === 'string' && isB2bClient(r.client_id));
  if (!b2b.length) return rows;

  const byDeal = new Map<string, DealRollup & { _order: number; _hasOrder: boolean }>();
  for (const r of b2b) byDeal.set(r.id, { ...emptyRollup(r), _order: 0, _hasOrder: false });
  try {
    const PAGE = 1000;
    for (const part of chunk(b2b.map((r) => r.id as string), 200)) {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabaseAdmin.from('crm_deal_line_items').select('deal_id, custom_fields')
          .eq('org_id', orgId).in('deal_id', part).order('id', { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const lines = (data ?? []) as Row[];
        for (const l of lines) {
          const agg = byDeal.get(String(l.deal_id));
          if (!agg) continue;
          agg.line_count += 1;
          const cf: Row = (l.custom_fields && typeof l.custom_fields === 'object') ? l.custom_fields : {};
          const ov = orderOrNull(cf.order_value);
          if (ov !== null) { agg._order += ov; agg._hasOrder = true; }
          const brand = typeof cf.brand_name === 'string' ? cf.brand_name.trim() : '';
          if (brand && !agg.brands.includes(brand)) agg.brands.push(brand);
        }
        if (lines.length < PAGE) break;
      }
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'dealLines: deal roll-up read failed');
    for (const r of b2b) byDeal.set(r.id, { ...emptyRollup(r), _order: 0, _hasOrder: false });
  }
  return rows.map((r) => {
    const agg = r && typeof r.id === 'string' ? byDeal.get(r.id) : undefined;
    if (!agg) return r;
    return {
      ...r,
      line_count: agg.line_count,
      quoted_amount: agg.quoted_amount,
      order_amount: agg._hasOrder ? Math.round(agg._order * 100) / 100 : null,
      brands: agg.brands,
    };
  });
}

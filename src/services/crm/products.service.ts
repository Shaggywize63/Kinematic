/**
 * Products + deal line items. Most product CRUD goes through the generic
 * crud helpers; this file owns line-item mutations because they snapshot
 * fields from the parent product and rely on the trigger that re-totals
 * crm_deals.amount.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { isB2bClient } from '../../lib/b2bClients';
import {
  splitLineExtras, resolveLineCustomFields, presentLine, dealLinesAreB2b,
} from './dealLineMakeBrand.service';

export interface LineItemInput {
  product_id?: string | null;
  name?: string;
  description?: string | null;
  sku?: string | null;
  unit?: string | null;
  quantity?: number;
  unit_price?: number;
  discount_pct?: number;
  tax_pct?: number;
  position?: number;
  custom_fields?: Record<string, unknown>;
  // Connected-B2B only (see dealLineMakeBrand.service.ts): stored in custom_fields; ignored for every other client.
  make_id?: string | null;
  brand_id?: string | null;
  funnel_ref?: string | null;
  order_value?: number | null;
}

/** Who is asking: the request's client, used when the deal itself carries none. */
export interface LineOpts {
  clientId?: string | null;
  /** custom_fields already resolved (and validated) by prepareDealItems; skips resolving again. */
  resolvedCustomFields?: Record<string, unknown>;
  /** 1-based line number for error messages in a multi-line request. */
  lineNo?: number;
}

export async function listLineItems(org_id: string, deal_id: string, opts: LineOpts = {}) {
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items')
    .select('*, crm_products(name, sku, image_url, currency)')
    .eq('org_id', org_id).eq('deal_id', deal_id)
    .order('position', { ascending: true });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = data ?? [];
  // Connected-B2B: make / brand / funnel reference / order value and `reference` on every line. Others: unchanged.
  if (!rows.length || !(await dealLinesAreB2b(org_id, deal_id, opts.clientId))) return rows;
  return rows.map((r) => presentLine(r as Record<string, unknown>));
}

export async function addLineItem(org_id: string, deal_id: string, input: LineItemInput, user_id?: string, opts: LineOpts = {}) {
  // Verify deal belongs to org
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('id, client_id')
    .eq('org_id', org_id).eq('id', deal_id).is('deleted_at', null).maybeSingle();
  if (!deal) throw new AppError(404, 'Deal not found', 'NOT_FOUND');

  // make_id / brand_id / funnel_ref / order_value are connected-B2B only: every other client has them stripped.
  const b2b = isB2bClient(((deal as { client_id?: string | null }).client_id ?? opts.clientId) ?? null);
  const { rest: payload, extras } = splitLineExtras(input);

  // Snapshot fields from product if a product_id is supplied.
  let snapshot: Partial<LineItemInput> = {};
  let productRow: Record<string, unknown> | null = null;
  if (payload.product_id) {
    const { data: product } = await supabaseAdmin.from('crm_products').select('*')
      .eq('org_id', org_id).eq('id', payload.product_id).is('deleted_at', null).maybeSingle();
    productRow = (product as Record<string, unknown> | null) ?? null;
    if (product) {
      snapshot = {
        name: payload.name ?? product.name,
        description: payload.description ?? product.description,
        sku: payload.sku ?? product.sku,
        unit: payload.unit ?? product.unit,
        unit_price: payload.unit_price ?? Number(product.price),
        tax_pct: payload.tax_pct ?? Number(product.tax_rate_pct),
      };
    }
  }
  const customFields = !b2b ? (payload.custom_fields ?? {}) : (opts.resolvedCustomFields ?? await resolveLineCustomFields({
    orgId: org_id, extras, sentCustomFields: payload.custom_fields, product: productRow, lineNo: opts.lineNo,
  }));
  const row = {
    org_id,
    deal_id,
    product_id: payload.product_id ?? null,
    name: snapshot.name ?? payload.name ?? 'Item',
    description: snapshot.description ?? payload.description ?? null,
    sku: snapshot.sku ?? payload.sku ?? null,
    unit: snapshot.unit ?? payload.unit ?? 'each',
    quantity: payload.quantity ?? 1,
    unit_price: snapshot.unit_price ?? payload.unit_price ?? 0,
    discount_pct: payload.discount_pct ?? 0,
    tax_pct: snapshot.tax_pct ?? payload.tax_pct ?? 0,
    position: payload.position ?? 0,
    custom_fields: customFields,
    created_by: user_id ?? null,
  };
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items').insert(row).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return b2b ? presentLine(data as Record<string, unknown>) : data;
}

export async function updateLineItem(org_id: string, line_id: string, input: Partial<LineItemInput>, user_id?: string, opts: LineOpts = {}) {
  const { rest: payload, extras } = splitLineExtras(input);
  let patch: Record<string, unknown> = { ...payload, updated_by: user_id ?? null };

  // Connected-B2B: merge make / brand / funnel / order into the line's custom_fields and check the MAC rule on the
  // merged result. Any other client (or a line that does not exist: the update below reports that) behaves as before.
  let b2b = false;
  let existing: Record<string, unknown> | null = null;
  const { data: found } = await supabaseAdmin.from('crm_deal_line_items').select('*')
    .eq('org_id', org_id).eq('id', line_id).maybeSingle();
  if (found) {
    existing = found as Record<string, unknown>;
    b2b = await dealLinesAreB2b(org_id, String(existing.deal_id), opts.clientId);
  }
  if (b2b && existing) {
    // Switching the product defaults make / brand from the new product (unless this request sets them).
    let product: Record<string, unknown> | null = null;
    if (typeof payload.product_id === 'string' && payload.product_id && payload.product_id !== existing.product_id) {
      const { data } = await supabaseAdmin.from('crm_products').select('*')
        .eq('org_id', org_id).eq('id', payload.product_id).is('deleted_at', null).maybeSingle();
      product = (data as Record<string, unknown> | null) ?? null;
    }
    const merged = await resolveLineCustomFields({
      orgId: org_id, extras, product,
      sentCustomFields: payload.custom_fields,
      existingCustomFields: existing.custom_fields as Record<string, unknown> | null,
    });
    if (payload.custom_fields !== undefined || JSON.stringify(merged) !== JSON.stringify(existing.custom_fields ?? {})) {
      patch = { ...patch, custom_fields: merged };
    }
  }
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items')
    .update(patch)
    .eq('org_id', org_id).eq('id', line_id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return b2b ? presentLine(data as Record<string, unknown>) : data;
}

export async function deleteLineItem(org_id: string, line_id: string) {
  const { error } = await supabaseAdmin.from('crm_deal_line_items')
    .delete().eq('org_id', org_id).eq('id', line_id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

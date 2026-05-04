/**
 * Products + deal line items. Most product CRUD goes through the generic
 * crud helpers; this file owns line-item mutations because they snapshot
 * fields from the parent product and rely on the trigger that re-totals
 * crm_deals.amount.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

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
}

export async function listLineItems(org_id: string, deal_id: string) {
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items')
    .select('*, crm_products(name, sku, image_url, currency)')
    .eq('org_id', org_id).eq('deal_id', deal_id)
    .order('position', { ascending: true });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function addLineItem(org_id: string, deal_id: string, payload: LineItemInput, user_id?: string) {
  // Verify deal belongs to org
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('id')
    .eq('org_id', org_id).eq('id', deal_id).is('deleted_at', null).maybeSingle();
  if (!deal) throw new AppError(404, 'Deal not found', 'NOT_FOUND');

  // Snapshot fields from product if a product_id is supplied.
  let snapshot: Partial<LineItemInput> = {};
  if (payload.product_id) {
    const { data: product } = await supabaseAdmin.from('crm_products').select('*')
      .eq('org_id', org_id).eq('id', payload.product_id).is('deleted_at', null).maybeSingle();
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
    custom_fields: payload.custom_fields ?? {},
    created_by: user_id ?? null,
  };
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items').insert(row).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function updateLineItem(org_id: string, line_id: string, payload: Partial<LineItemInput>, user_id?: string) {
  const { data, error } = await supabaseAdmin.from('crm_deal_line_items')
    .update({ ...payload, updated_by: user_id ?? null })
    .eq('org_id', org_id).eq('id', line_id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function deleteLineItem(org_id: string, line_id: string) {
  const { error } = await supabaseAdmin.from('crm_deal_line_items')
    .delete().eq('org_id', org_id).eq('id', line_id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

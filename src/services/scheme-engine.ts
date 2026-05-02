/**
 * Scheme engine — deterministic, server-authoritative, versioned.
 *
 * Inputs : a cart of priced lines (output of order-pricer's first pass) +
 *          customer/outlet/distributor + date.
 * Outputs: a re-priced list of lines (with potential `is_free_good` rows
 *          appended), discount / scheme_total accumulators, and a list of
 *          AppliedScheme rows that callers persist into scheme_application_log.
 *
 * Scheme types:
 *   - QPS            qty purchase slabs on a target SKU/category → free goods
 *   - SLAB_DISCOUNT  qty/value slab → percent discount on matching lines
 *   - BXGY           buy X SKU(s), get Y SKU(s) free
 *   - VALUE_DISCOUNT cart total ≥ threshold → flat amount or percent
 *
 * Version pinning: callers pass `pinnedVersions` for already-priced orders so
 * historical detail still shows the version the order was priced with.
 */

import { supabaseAdmin } from '../lib/supabase';
import { computeLineTax } from './tax';
import { PricedLine } from './order-pricer';

export const SCHEME_ENGINE_VERSION = 'scheme-engine-1.0.0';

export interface AppliedScheme {
  scheme_id: string;
  scheme_version: number;
  scheme_code: string;
  scheme_type: string;
  inputs: unknown;
  outputs: unknown;
}

export interface SchemeContext {
  org_id: string;
  customer_class: string;
  date: string;       // YYYY-MM-DD
  outlet_id: string;
  intra_state: boolean;
  brand_ids: string[];     // resolved from product_distribution_ext for cart SKUs
  category_ids?: string[];
}

export interface SchemeResult {
  lines: PricedLine[];
  applied: AppliedScheme[];
  discount_total: number;
  scheme_total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function targetingMatches(targeting: any, ctx: SchemeContext, line?: PricedLine): boolean {
  const t = targeting || {};
  if (Array.isArray(t.customer_classes) && t.customer_classes.length && !t.customer_classes.includes(ctx.customer_class)) return false;
  if (Array.isArray(t.outlet_ids) && t.outlet_ids.length && !t.outlet_ids.includes(ctx.outlet_id)) return false;
  if (line) {
    if (Array.isArray(t.sku_ids) && t.sku_ids.length && !t.sku_ids.includes(line.sku_id)) return false;
  }
  return true;
}

export async function applySchemes(
  inputLines: PricedLine[],
  ctx: SchemeContext,
): Promise<SchemeResult> {
  const out: PricedLine[] = inputLines.map((l) => ({ ...l }));
  const applied: AppliedScheme[] = [];

  // 1. Pull active schemes overlapping ctx.date.
  const { data: schemes } = await supabaseAdmin
    .from('schemes').select('*')
    .eq('org_id', ctx.org_id)
    .eq('is_active', true)
    .lte('valid_from', ctx.date)
    .or(`valid_to.is.null,valid_to.gte.${ctx.date}`)
    .order('priority', { ascending: true });

  if (!schemes?.length) return { lines: out, applied, discount_total: 0, scheme_total: 0 };

  // Track per-SKU used flag so non-stackable schemes don't double-apply.
  const consumed = new Set<string>();

  let discount_total = 0;
  let scheme_total = 0;

  for (const s of schemes) {
    if (!targetingMatches(s.targeting, ctx)) continue;
    const rules: any = s.rules || {};
    let appliedHere: any = null;

    switch (s.type) {
      case 'QPS': {
        // rules: { target_sku_id, slabs:[{min_qty, free_qty, free_sku_id?}] }
        const target = out.find((l) => l.sku_id === rules.target_sku_id && !consumed.has(l.sku_id) && targetingMatches(s.targeting, ctx, l));
        if (!target) break;
        const slabs: Array<{ min_qty: number; free_qty: number; free_sku_id?: string }> = rules.slabs || [];
        const matched = slabs
          .filter((sl) => target.qty >= sl.min_qty)
          .sort((a, b) => b.min_qty - a.min_qty)[0];
        if (!matched) break;
        const freeSkuId = matched.free_sku_id || target.sku_id;
        const freeLine = makeFreeLine(target, freeSkuId, matched.free_qty);
        out.push(freeLine);
        appliedHere = { type: 'QPS', target_sku: target.sku_id, slab: matched };
        if (!s.stackable) consumed.add(target.sku_id);
        break;
      }
      case 'SLAB_DISCOUNT': {
        // rules: { sku_ids:[], slabs:[{min_qty, percent}] }
        const slabs: Array<{ min_qty: number; percent: number }> = rules.slabs || [];
        const skuFilter: string[] = rules.sku_ids || out.map((l) => l.sku_id);
        let appliedAny = false;
        for (const line of out) {
          if (line.is_free_good) continue;
          if (consumed.has(line.sku_id)) continue;
          if (!skuFilter.includes(line.sku_id)) continue;
          if (!targetingMatches(s.targeting, ctx, line)) continue;
          const slab = slabs.filter((sl) => line.qty >= sl.min_qty).sort((a, b) => b.min_qty - a.min_qty)[0];
          if (!slab) continue;
          const discountAmt = round2((line.taxable_value * slab.percent) / 100);
          line.discount_pct = slab.percent;
          line.discount_amt = discountAmt;
          line.taxable_value = round2(line.taxable_value - discountAmt);
          line.scheme_id = s.id;
          line.scheme_version = s.version;
          // Recompute tax on the discounted base.
          const tx = computeLineTax({ taxable_value: line.taxable_value, gst_rate: line.gst_rate, cess_rate: 0 }, ctx.intra_state);
          line.cgst = tx.cgst; line.sgst = tx.sgst; line.igst = tx.igst; line.cess = tx.cess;
          line.total = tx.total;
          discount_total += discountAmt;
          if (!s.stackable) consumed.add(line.sku_id);
          appliedAny = true;
        }
        if (appliedAny) appliedHere = { type: 'SLAB_DISCOUNT', percent_max: Math.max(...slabs.map((x) => x.percent)) };
        break;
      }
      case 'BXGY': {
        // rules: { buy_sku, buy_qty, get_sku, get_qty, max_per_order }
        const buy = out.find((l) => l.sku_id === rules.buy_sku && !consumed.has(l.sku_id));
        if (!buy) break;
        const sets = Math.floor(buy.qty / Math.max(1, Number(rules.buy_qty || 1)));
        const cap = Math.max(1, Number(rules.max_per_order || sets));
        const give = Math.min(sets, cap) * Math.max(1, Number(rules.get_qty || 1));
        if (give <= 0) break;
        const freeLine = makeFreeLine(buy, rules.get_sku, give);
        out.push(freeLine);
        appliedHere = { type: 'BXGY', buy_sku: rules.buy_sku, get_sku: rules.get_sku, sets: Math.min(sets, cap) };
        if (!s.stackable) consumed.add(rules.buy_sku);
        break;
      }
      case 'VALUE_DISCOUNT': {
        // rules: { min_value, percent? , flat_amount? }
        const cartTaxable = out.filter((l) => !l.is_free_good).reduce((sum, l) => sum + l.taxable_value, 0);
        if (cartTaxable < Number(rules.min_value || 0)) break;
        const flat = Number(rules.flat_amount || 0);
        const pct = Number(rules.percent || 0);
        const cut = pct > 0 ? round2((cartTaxable * pct) / 100) : flat;
        if (cut <= 0) break;
        // Allocate proportionally across non-free lines.
        for (const line of out) {
          if (line.is_free_good) continue;
          const share = round2((line.taxable_value / cartTaxable) * cut);
          line.discount_amt = round2((line.discount_amt || 0) + share);
          line.taxable_value = round2(line.taxable_value - share);
          const tx = computeLineTax({ taxable_value: line.taxable_value, gst_rate: line.gst_rate, cess_rate: 0 }, ctx.intra_state);
          line.cgst = tx.cgst; line.sgst = tx.sgst; line.igst = tx.igst; line.cess = tx.cess;
          line.total = tx.total;
          line.scheme_id = line.scheme_id || s.id;
          line.scheme_version = line.scheme_version || s.version;
        }
        discount_total += cut;
        appliedHere = { type: 'VALUE_DISCOUNT', cut, basis: pct > 0 ? `${pct}%` : `flat` };
        break;
      }
    }

    if (appliedHere) {
      applied.push({
        scheme_id: s.id,
        scheme_version: s.version,
        scheme_code: s.code,
        scheme_type: s.type,
        inputs: { line_count: inputLines.length, customer_class: ctx.customer_class, date: ctx.date },
        outputs: appliedHere,
      });
      // Free-good lines we just appended need to be flagged with scheme.
      for (const l of out) if (l.is_free_good && !l.scheme_id) { l.scheme_id = s.id; l.scheme_version = s.version; }
    }
  }

  scheme_total = round2(applied.reduce((s, a) => s + ((a.outputs as any)?.cut || 0), 0));

  // Renumber line_no after potential free-good additions.
  out.forEach((l, idx) => { l.line_no = idx + 1; });

  return { lines: out, applied, discount_total: round2(discount_total), scheme_total };
}

function makeFreeLine(refLine: PricedLine, sku_id: string, qty: number): PricedLine {
  // Free goods carry zero tax/value by default. Per-scheme `tax_on_mrp` flag
  // can override later if legal asks (not yet wired).
  return {
    sku_id,
    sku_name: refLine.sku_name,
    sku_code: refLine.sku_code,
    hsn_code: refLine.hsn_code,
    qty,
    uom: refLine.uom,
    pack_size: refLine.pack_size,
    unit_price: 0,
    mrp: refLine.mrp,
    discount_pct: 100,
    discount_amt: 0,
    scheme_id: null,
    scheme_version: null,
    is_free_good: true,
    taxable_value: 0,
    gst_rate: refLine.gst_rate,
    cgst: 0,
    sgst: 0,
    igst: 0,
    cess: 0,
    total: 0,
    price_list_version: refLine.price_list_version,
    line_no: 0, // renumbered
  };
}

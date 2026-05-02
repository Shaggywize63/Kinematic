/**
 * Indian GST tax computation for distribution invoices.
 *
 *  - Intra-state (place_of_supply == seller state)  → CGST + SGST
 *  - Inter-state (place_of_supply != seller state)  → IGST
 *  - Cess is additive to either case.
 *
 * All math is in paise internally (avoids float drift), exposed as numeric.
 */

export interface TaxLineInput {
  taxable_value: number;
  gst_rate: number;       // 0 | 5 | 12 | 18 | 28
  cess_rate: number;      // optional per-SKU cess
}

export interface TaxLineOutput {
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;          // taxable + tax
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeLineTax(input: TaxLineInput, intraState: boolean): TaxLineOutput {
  const { taxable_value, gst_rate, cess_rate } = input;
  const gst = round2((taxable_value * gst_rate) / 100);
  const cess = round2((taxable_value * cess_rate) / 100);
  if (intraState) {
    const half = round2(gst / 2);
    return {
      cgst: half,
      sgst: round2(gst - half),
      igst: 0,
      cess,
      total: round2(taxable_value + gst + cess),
    };
  }
  return { cgst: 0, sgst: 0, igst: gst, cess, total: round2(taxable_value + gst + cess) };
}

export function isIntraState(sellerStateCode?: string | null, placeOfSupply?: string | null): boolean {
  if (!sellerStateCode || !placeOfSupply) return true; // safe default
  return String(sellerStateCode).trim() === String(placeOfSupply).trim();
}

/**
 * Aggregate line totals into an order/invoice header total.
 * Optional banker-style round-off line to whole rupee.
 */
export function summariseTotals(lines: Array<{
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;
  discount_amt?: number;
}>, opts: { roundOff?: boolean } = {}) {
  const subtotal = round2(lines.reduce((s, l) => s + (l.taxable_value || 0) + (l.discount_amt || 0), 0));
  const discount_total = round2(lines.reduce((s, l) => s + (l.discount_amt || 0), 0));
  const taxable_value = round2(lines.reduce((s, l) => s + l.taxable_value, 0));
  const cgst = round2(lines.reduce((s, l) => s + l.cgst, 0));
  const sgst = round2(lines.reduce((s, l) => s + l.sgst, 0));
  const igst = round2(lines.reduce((s, l) => s + l.igst, 0));
  const cess = round2(lines.reduce((s, l) => s + l.cess, 0));
  const tax_total = round2(cgst + sgst + igst + cess);
  let grand = round2(taxable_value + tax_total);
  let round_off = 0;
  if (opts.roundOff) {
    const whole = Math.round(grand);
    round_off = round2(whole - grand);
    grand = whole;
  }
  return { subtotal, discount_total, taxable_value, cgst, sgst, igst, cess, round_off, grand_total: grand };
}

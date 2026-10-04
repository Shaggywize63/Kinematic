import { computeLineTax, isIntraState } from '../tax';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const num = (v: unknown, d = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : d;
};

export interface LineInput {
  item_id?: string | null;
  name: string;
  description?: string | null;
  hsn_sac?: string | null;
  quantity: number;
  unit?: string | null;
  rate: number;
  discount_pct?: number;
  gst_rate?: number;
}

export interface LineComputed extends Required<Pick<LineInput, 'name' | 'quantity' | 'rate'>> {
  item_id: string | null;
  description: string | null;
  hsn_sac: string | null;
  unit: string | null;
  discount_pct: number;
  gst_rate: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  discount_amt: number;
}

export interface Totals {
  subtotal: number;        // sum of qty*rate before discount
  discount_total: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax_total: number;
  adjustment: number;
  round_off: number;
  total: number;
}

/**
 * Compute line + document totals. Rounds the grand total to whole rupees
 * (round_off is stored separately, as on a GST invoice) after any adjustment.
 * `taxExempt` zeroes tax for tax-exempt customers.
 */
export function computeDocument(
  lines: LineInput[],
  opts: { sellerStateCode?: string | null; placeOfSupply?: string | null; adjustment?: number; taxExempt?: boolean },
): { lines: LineComputed[]; totals: Totals; intraState: boolean } {
  const intra = isIntraState(opts.sellerStateCode, opts.placeOfSupply);
  const out: LineComputed[] = lines.map((l) => {
    const gross = round2(num(l.quantity, 1) * num(l.rate));
    const pct = Math.min(100, Math.max(0, num(l.discount_pct)));
    const discount_amt = round2((gross * pct) / 100);
    const taxable = round2(gross - discount_amt);
    const rate = opts.taxExempt ? 0 : Math.max(0, num(l.gst_rate));
    const t = computeLineTax({ taxable_value: taxable, gst_rate: rate, cess_rate: 0 }, intra);
    return {
      item_id: l.item_id ?? null,
      name: l.name,
      description: l.description ?? null,
      hsn_sac: l.hsn_sac ?? null,
      quantity: num(l.quantity, 1),
      unit: l.unit ?? null,
      rate: num(l.rate),
      discount_pct: pct,
      gst_rate: rate,
      taxable_value: taxable,
      cgst: t.cgst,
      sgst: t.sgst,
      igst: t.igst,
      total: t.total,
      discount_amt,
    };
  });

  const sum = (f: (l: LineComputed) => number) => round2(out.reduce((s, l) => s + f(l), 0));
  const subtotal = sum((l) => l.quantity * l.rate);
  const discount_total = sum((l) => l.discount_amt);
  const taxable_value = sum((l) => l.taxable_value);
  const cgst = sum((l) => l.cgst);
  const sgst = sum((l) => l.sgst);
  const igst = sum((l) => l.igst);
  const tax_total = round2(cgst + sgst + igst);
  const adjustment = round2(num(opts.adjustment));
  const exact = round2(taxable_value + tax_total + adjustment);
  const total = Math.round(exact);
  return {
    lines: out,
    intraState: intra,
    totals: {
      subtotal: round2(subtotal),
      discount_total,
      taxable_value,
      cgst,
      sgst,
      igst,
      tax_total,
      adjustment,
      round_off: round2(total - exact),
      total,
    },
  };
}

// ── Amount in words (Indian numbering: lakh / crore) ────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

export function amountInWords(amount: number, currency = 'INR'): string {
  const abs = Math.abs(round2(amount));
  let rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  const segs: string[] = [];
  const crore = Math.floor(rupees / 10_000_000); rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000); rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) segs.push(`${below1000(crore)} Crore`);
  if (lakh) segs.push(`${below1000(lakh)} Lakh`);
  if (thousand) segs.push(`${below1000(thousand)} Thousand`);
  if (rupees) segs.push(below1000(rupees));
  const main = segs.length ? segs.join(' ') : 'Zero';
  if (currency !== 'INR') return `${currency} ${main}${paise ? ` and ${below1000(paise)} Cents` : ''} Only`;
  return `Indian Rupee ${main}${paise ? ` and ${below1000(paise)} Paise` : ''} Only`;
}

/**
 * Finance ↔ Expenses: GST on money you spend (input tax credit).
 *
 * Two sources feed one ledger:
 *   • bills   – business expenses entered in Finance (rent, cloud, vendors …)  → finance_expenses
 *   • claims  – Field Expense claim lines that carry GST details, once the claim is
 *               approved/reimbursed (rejected lines are left out)               → expense_claim_items
 *
 * Claim lines are never copied: they are read live, so editing a claim, a decision or the business
 * state in Finance Settings is reflected immediately. Tax is computed here, in one place
 * (`computeGst`), for both sources.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { FinanceScope, scoped } from './scope';
import { round2, num } from './money';
import { getSettings, pageParams, safeSearch } from './masters.service';
import { fetchAll, itemLines, Report } from './reports.service';

const db = () => supabaseAdmin;
const fail = (e: { message: string }) => new AppError(500, e.message, 'DB_ERROR');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Credit the law does not allow (Sec 17(5)) — food & beverages, entertainment, personal use. */
export const BLOCKED_ITC: Record<string, string> = {
  food: 'Food & beverages — credit is blocked (Sec 17(5))',
  entertainment: 'Entertainment — credit is blocked (Sec 17(5))',
  personal: 'Personal use — not a business expense',
  mileage: 'Mileage allowance carries no GST',
};

export const normalizeGstin = (g: unknown): string | null => {
  const t = String(g ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return t || null;
};
export const isValidGstin = (g: string | null | undefined): boolean => !!g && GSTIN_RE.test(g);
export const gstinState = (g: string | null | undefined): string | null => (g && /^\d{2}/.test(g) ? g.slice(0, 2) : null);

export interface GstInput {
  /** Amount as on the bill. */
  amount: number;
  /** true (default): `amount` already includes GST (a receipt's grand total). false: GST is added on top. */
  taxInclusive?: boolean;
  gstRate: number;
  /** Tax exactly as printed on the bill; overrides the rate-derived figure (rounding differences). */
  gstAmount?: number | null;
  /** 2-digit state of the supplier (GSTIN prefix / place of supply); null = assume same state. */
  supplierState: string | null;
  /** 2-digit state of the business; null = unknown → assume same state. */
  businessState: string | null;
}
export interface GstResult { taxable_value: number; cgst: number; sgst: number; igst: number; total_tax: number; total: number; intra: boolean }

export function computeGst(i: GstInput): GstResult {
  const amount = Math.max(0, num(i.amount));
  const rate = Math.max(0, num(i.gstRate));
  const incl = i.taxInclusive !== false;
  let tax: number; let taxable: number;
  if (i.gstAmount !== null && i.gstAmount !== undefined && Number.isFinite(Number(i.gstAmount))) {
    tax = round2(Math.min(Math.max(0, Number(i.gstAmount)), incl ? amount : Number.MAX_SAFE_INTEGER));
    taxable = incl ? round2(amount - tax) : round2(amount);
  } else if (incl) {
    taxable = round2(amount / (1 + rate / 100));
    tax = round2(amount - taxable);
  } else {
    taxable = round2(amount);
    tax = round2((taxable * rate) / 100);
  }
  const intra = !i.supplierState || !i.businessState || i.supplierState === i.businessState;
  const half = round2(tax / 2);
  const cgst = intra ? half : 0;
  const sgst = intra ? round2(tax - half) : 0;
  const igst = intra ? 0 : tax;
  return { taxable_value: taxable, cgst, sgst, igst, total_tax: tax, total: round2(taxable + tax), intra };
}

/** Default credit decision when the user hasn't made one. */
export function defaultItc(category: string, gstin: string | null, totalTax: number): { eligible: boolean; reason: string | null } {
  if (totalTax <= 0) return { eligible: false, reason: 'No GST on this expense' };
  const blocked = BLOCKED_ITC[String(category || '').toLowerCase()];
  if (blocked) return { eligible: false, reason: blocked };
  if (!isValidGstin(gstin)) return { eligible: false, reason: gstin ? 'Supplier GSTIN looks invalid' : 'Supplier GSTIN missing — credit needs a GST invoice' };
  return { eligible: true, reason: null };
}

// ── the unified ledger ──────────────────────────────────────────────────────
export interface ExpenseRecord {
  id: string;
  source: 'bill' | 'claim';
  date: string | null;
  vendor: string;
  vendor_gstin: string | null;
  bill_number: string | null;
  category: string;
  description: string | null;
  gst_rate: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  total_tax: number;
  total: number;
  itc_eligible: boolean;
  itc_reason: string | null;
  itc_cgst: number;
  itc_sgst: number;
  itc_igst: number;
  itc_total: number;
  receipt_url: string | null;
  claim_id: string | null;
  claim_title: string | null;
  claimed_by: string | null;
}

const withItc = (r: Omit<ExpenseRecord, 'itc_cgst' | 'itc_sgst' | 'itc_igst' | 'itc_total'>): ExpenseRecord => {
  const k = r.itc_eligible ? 1 : 0;
  return { ...r, itc_cgst: round2(r.cgst * k), itc_sgst: round2(r.sgst * k), itc_igst: round2(r.igst * k), itc_total: round2(r.total_tax * k) };
};

interface BillRow {
  id: string; expense_date: string; vendor_name: string; vendor_gstin: string | null; bill_number: string | null; category: string;
  description: string | null; gst_rate: number; taxable_value: number; cgst: number; sgst: number; igst: number; total: number;
  itc_eligible: boolean; itc_reason: string | null; receipt_url: string | null;
}
const billRecord = (b: BillRow): ExpenseRecord => withItc({
  id: b.id, source: 'bill', date: b.expense_date, vendor: b.vendor_name, vendor_gstin: b.vendor_gstin, bill_number: b.bill_number,
  category: b.category, description: b.description, gst_rate: Number(b.gst_rate), taxable_value: Number(b.taxable_value),
  cgst: Number(b.cgst), sgst: Number(b.sgst), igst: Number(b.igst), total_tax: round2(Number(b.cgst) + Number(b.sgst) + Number(b.igst)),
  total: Number(b.total), itc_eligible: !!b.itc_eligible, itc_reason: b.itc_reason, receipt_url: b.receipt_url,
  claim_id: null, claim_title: null, claimed_by: null,
});

interface ClaimLineRow {
  id: string; item_date: string | null; category: string; description: string | null; merchant: string | null; amount: number;
  supplier_gstin: string | null; supplier_invoice_no: string | null; gst_rate: number | null; gst_amount: number | null;
  itc_eligible: boolean | null; decision: string | null; receipt_url: string | null;
  claim: { id: string; title: string | null; status: string; user_id: string | null; client_id: string | null; created_at: string | null };
}

async function claimRecords(s: FinanceScope, from: string, to: string, businessState: string | null): Promise<ExpenseRecord[]> {
  const rows = await fetchAll<ClaimLineRow>((a, b) => db().from('expense_claim_items')
    .select('id,item_date,category,description,merchant,amount,supplier_gstin,supplier_invoice_no,gst_rate,gst_amount,itc_eligible,decision,receipt_url, claim:expense_claims!inner(id,title,status,user_id,client_id,created_at)')
    .eq('claim.org_id', s.org_id)
    .in('claim.status', ['approved', 'reimbursed'])
    .not('gst_rate', 'is', null)
    .gte('item_date', from).lte('item_date', to)
    .range(a, b) as unknown as PromiseLike<{ data: ClaimLineRow[] | null; error: { message: string } | null }>);
  const mine = rows.filter((r) => (r.claim.client_id ?? null) === (s.client_id ?? null) && r.decision !== 'rejected');
  const ids = Array.from(new Set(mine.map((r) => r.claim.user_id).filter(Boolean))) as string[];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data } = await db().from('users').select('id,name').in('id', ids);
    for (const u of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(u.id, u.name ?? '');
  }
  return mine.map((r) => {
    const gstin = normalizeGstin(r.supplier_gstin);
    const g = computeGst({ amount: Number(r.amount), taxInclusive: true, gstRate: Number(r.gst_rate), gstAmount: r.gst_amount, supplierState: gstinState(gstin), businessState });
    const d = r.itc_eligible === null || r.itc_eligible === undefined ? defaultItc(r.category, gstin, g.total_tax) : { eligible: !!r.itc_eligible, reason: r.itc_eligible ? null : 'Marked not claimable' };
    return withItc({
      id: r.id, source: 'claim', date: r.item_date, vendor: r.merchant || 'Field expense', vendor_gstin: gstin, bill_number: r.supplier_invoice_no,
      category: r.category, description: r.description, gst_rate: Number(r.gst_rate), taxable_value: g.taxable_value, cgst: g.cgst, sgst: g.sgst, igst: g.igst,
      total_tax: g.total_tax, total: g.total, itc_eligible: d.eligible && g.total_tax > 0, itc_reason: d.reason, receipt_url: r.receipt_url,
      claim_id: r.claim.id, claim_title: r.claim.title, claimed_by: r.claim.user_id ? names.get(r.claim.user_id) || null : null,
    });
  });
}

async function billRecords(s: FinanceScope, from: string, to: string): Promise<ExpenseRecord[]> {
  const rows = await fetchAll<BillRow>((a, b) => scoped(db().from('finance_expenses').select('*'), s)
    .is('deleted_at', null).gte('expense_date', from).lte('expense_date', to).range(a, b) as unknown as PromiseLike<{ data: BillRow[] | null; error: { message: string } | null }>);
  return rows.map(billRecord);
}

export async function loadLedger(s: FinanceScope, from: string, to: string, source: 'all' | 'bill' | 'claim' = 'all'): Promise<ExpenseRecord[]> {
  const settings = await getSettings(s);
  const businessState = (settings.state_code as string | null) || gstinState(normalizeGstin(settings.gstin)) || null;
  const [bills, claims] = await Promise.all([
    source === 'claim' ? Promise.resolve([] as ExpenseRecord[]) : billRecords(s, from, to),
    source === 'bill' ? Promise.resolve([] as ExpenseRecord[]) : claimRecords(s, from, to, businessState),
  ]);
  return [...bills, ...claims].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

function range(q: Record<string, unknown>) {
  const now = new Date();
  const to = DATE_RE.test(String(q.to)) ? String(q.to) : iso(now);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = DATE_RE.test(String(q.from)) ? String(q.from) : iso(start);
  return { from, to };
}

export function ledgerTotals(rows: ExpenseRecord[]) {
  const sum = (f: (r: ExpenseRecord) => number) => round2(rows.reduce((a, r) => a + f(r), 0));
  return {
    count: rows.length,
    spend: sum((r) => r.total),
    taxable: sum((r) => r.taxable_value),
    gst_paid: sum((r) => r.total_tax),
    itc_claimable: sum((r) => r.itc_total),
    itc_blocked: sum((r) => (r.itc_eligible ? 0 : r.total_tax)),
  };
}

// ── list / CRUD (bills) ─────────────────────────────────────────────────────
export async function listExpenses(s: FinanceScope, query: Record<string, unknown>) {
  const { page, limit } = pageParams(query, 50);
  const { from, to } = range(query);
  const source = query.source === 'bill' || query.source === 'claim' ? query.source : 'all';
  let rows = await loadLedger(s, from, to, source);
  if (query.category) rows = rows.filter((r) => r.category === String(query.category));
  if (query.itc === 'eligible') rows = rows.filter((r) => r.itc_eligible);
  if (query.itc === 'blocked') rows = rows.filter((r) => !r.itc_eligible && r.total_tax > 0);
  const term = safeSearch(query.q).toLowerCase();
  if (term) rows = rows.filter((r) => [r.vendor, r.vendor_gstin, r.bill_number, r.description, r.category].some((v) => String(v ?? '').toLowerCase().includes(term)));
  return { rows: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit, totals: ledgerTotals(rows), meta: { from, to } };
}

export interface BillInput {
  expense_date: string;
  vendor_name: string;
  vendor_gstin?: string | null;
  bill_number?: string | null;
  category?: string;
  description?: string | null;
  place_of_supply?: string | null;
  /** Amount on the bill. */
  amount: number;
  tax_inclusive?: boolean;
  gst_rate: number;
  gst_amount?: number | null;
  itc_eligible?: boolean | null;
  itc_reason?: string | null;
  receipt_url?: string | null;
  notes?: string | null;
}

async function toRow(s: FinanceScope, i: BillInput) {
  const settings = await getSettings(s);
  const businessState = (settings.state_code as string | null) || gstinState(normalizeGstin(settings.gstin)) || null;
  const gstin = normalizeGstin(i.vendor_gstin);
  if (gstin && !isValidGstin(gstin)) throw new AppError(400, 'Vendor GSTIN is not a valid 15-character GSTIN', 'VALIDATION');
  const pos = (i.place_of_supply || '').trim() || null;
  const supplierState = gstinState(gstin) || (pos ? pos.padStart(2, '0') : null);
  const g = computeGst({ amount: i.amount, taxInclusive: i.tax_inclusive, gstRate: i.gst_rate, gstAmount: i.gst_amount, supplierState, businessState });
  const category = (i.category || 'other').toLowerCase();
  const d = i.itc_eligible === null || i.itc_eligible === undefined
    ? defaultItc(category, gstin, g.total_tax)
    : { eligible: !!i.itc_eligible && g.total_tax > 0, reason: i.itc_eligible ? null : (i.itc_reason || 'Marked not claimable') };
  return {
    expense_date: i.expense_date, vendor_name: i.vendor_name.trim(), vendor_gstin: gstin, bill_number: i.bill_number?.trim() || null,
    category, description: i.description?.trim() || null, place_of_supply: supplierState,
    gst_rate: Math.max(0, num(i.gst_rate)), taxable_value: g.taxable_value, cgst: g.cgst, sgst: g.sgst, igst: g.igst, total: g.total,
    itc_eligible: d.eligible, itc_reason: d.reason, receipt_url: i.receipt_url || null, notes: i.notes?.trim() || null,
  };
}

export async function getExpense(s: FinanceScope, id: string) {
  const { data, error } = await scoped(db().from('finance_expenses').select('*'), s).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw fail(error);
  if (!data) throw new AppError(404, 'Expense not found', 'NOT_FOUND');
  return { ...data, amount: data.total };
}

export async function createExpense(s: FinanceScope, input: BillInput) {
  const row = { ...(await toRow(s, input)), org_id: s.org_id, client_id: s.client_id, created_by: s.actor || null };
  const { data, error } = await db().from('finance_expenses').insert(row).select('*').single();
  if (error) throw fail(error);
  return data;
}

export async function updateExpense(s: FinanceScope, id: string, input: BillInput) {
  await getExpense(s, id);
  const row = { ...(await toRow(s, input)), updated_at: new Date().toISOString() };
  const { data, error } = await scoped(db().from('finance_expenses').update(row), s).eq('id', id).select('*').single();
  if (error) throw fail(error);
  return data;
}

export async function deleteExpense(s: FinanceScope, id: string) {
  await getExpense(s, id);
  const { error } = await scoped(db().from('finance_expenses').update({ deleted_at: new Date().toISOString() }), s).eq('id', id);
  if (error) throw fail(error);
  return { ok: true };
}

// ── reports (served through /finance/reports/:name, CSV included) ───────────
const MONEY = 'money' as const;

export async function gstOnExpenses(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const rows = await loadLedger(s, from, to);
  const m = new Map<number, { gst_rate: number; count: number; taxable: number; cgst: number; sgst: number; igst: number; total_tax: number; itc: number; blocked: number }>();
  for (const r of rows) {
    const x = m.get(r.gst_rate) ?? { gst_rate: r.gst_rate, count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total_tax: 0, itc: 0, blocked: 0 };
    x.count += 1; x.taxable += r.taxable_value; x.cgst += r.cgst; x.sgst += r.sgst; x.igst += r.igst; x.total_tax += r.total_tax;
    x.itc += r.itc_total; x.blocked += r.itc_eligible ? 0 : r.total_tax;
    m.set(r.gst_rate, x);
  }
  const out = Array.from(m.values()).sort((a, b) => a.gst_rate - b.gst_rate).map((x) => ({
    gst_rate: `${x.gst_rate}%`, count: x.count, taxable: round2(x.taxable), cgst: round2(x.cgst), sgst: round2(x.sgst), igst: round2(x.igst),
    total_tax: round2(x.total_tax), itc_claimable: round2(x.itc), itc_blocked: round2(x.blocked),
  }));
  const sum = (k: 'count' | 'taxable' | 'cgst' | 'sgst' | 'igst' | 'total_tax' | 'itc_claimable' | 'itc_blocked') => round2(out.reduce((a, r) => a + r[k], 0));
  return {
    title: 'GST on Expenses (Input Tax Credit)',
    columns: [{ key: 'gst_rate', label: 'GST Rate' }, { key: 'count', label: 'Expenses', type: 'number' }, { key: 'taxable', label: 'Taxable Value', type: MONEY },
      { key: 'cgst', label: 'CGST', type: MONEY }, { key: 'sgst', label: 'SGST', type: MONEY }, { key: 'igst', label: 'IGST', type: MONEY },
      { key: 'total_tax', label: 'GST Paid', type: MONEY }, { key: 'itc_claimable', label: 'ITC Claimable', type: MONEY }, { key: 'itc_blocked', label: 'Not Claimable', type: MONEY }],
    rows: out,
    totals: { gst_rate: 'Total', count: sum('count'), taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), total_tax: sum('total_tax'), itc_claimable: sum('itc_claimable'), itc_blocked: sum('itc_blocked') },
    meta: { from, to, bills: rows.filter((r) => r.source === 'bill').length, claim_lines: rows.filter((r) => r.source === 'claim').length },
  };
}

export async function expenseGstDetails(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const rows = await loadLedger(s, from, to);
  const out = rows.map((r) => ({
    date: r.date, source: r.source === 'claim' ? 'Field claim' : 'Bill', vendor: r.vendor, gstin: r.vendor_gstin ?? '', bill_number: r.bill_number ?? '',
    category: r.category, gst_rate: `${r.gst_rate}%`, taxable: r.taxable_value, cgst: r.cgst, sgst: r.sgst, igst: r.igst, total_tax: r.total_tax,
    itc: r.itc_eligible ? 'Yes' : (r.itc_reason ?? 'No'), total: r.total,
  }));
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'total_tax' | 'total') => round2(out.reduce((a, r) => a + r[k], 0));
  return {
    title: 'Expense GST Details',
    columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'source', label: 'Source' }, { key: 'vendor', label: 'Vendor' }, { key: 'gstin', label: 'Vendor GSTIN' },
      { key: 'bill_number', label: 'Bill #' }, { key: 'category', label: 'Category' }, { key: 'gst_rate', label: 'Rate' }, { key: 'taxable', label: 'Taxable', type: MONEY },
      { key: 'cgst', label: 'CGST', type: MONEY }, { key: 'sgst', label: 'SGST', type: MONEY }, { key: 'igst', label: 'IGST', type: MONEY },
      { key: 'total_tax', label: 'GST', type: MONEY }, { key: 'itc', label: 'ITC claimable' }, { key: 'total', label: 'Total', type: MONEY }],
    rows: out,
    totals: { date: 'Total', taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), total_tax: sum('total_tax'), total: sum('total') },
    meta: { from, to },
  };
}

/** Output tax on sales minus eligible input credit on expenses, tax head by tax head. */
export async function netGstPayable(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const [lines, ledger] = await Promise.all([itemLines(s, from, to), loadLedger(s, from, to)]);
  const out = { cgst: 0, sgst: 0, igst: 0 };
  for (const l of lines) { out.cgst += Number(l.cgst); out.sgst += Number(l.sgst); out.igst += Number(l.igst); }
  const inp = { cgst: 0, sgst: 0, igst: 0 };
  for (const r of ledger) { inp.cgst += r.itc_cgst; inp.sgst += r.itc_sgst; inp.igst += r.itc_igst; }
  const heads = (['cgst', 'sgst', 'igst'] as const).map((k) => ({
    head: k.toUpperCase(), output: round2(out[k]), input: round2(inp[k]), net: round2(out[k] - inp[k]),
  }));
  const t = (k: 'output' | 'input' | 'net') => round2(heads.reduce((a, r) => a + r[k], 0));
  return {
    title: 'Net GST Payable (Output − Input Credit)',
    columns: [{ key: 'head', label: 'Tax head' }, { key: 'output', label: 'Output tax (sales)', type: MONEY }, { key: 'input', label: 'Input credit (expenses)', type: MONEY }, { key: 'net', label: 'Net payable / (credit)', type: MONEY }],
    rows: heads,
    totals: { head: 'Total', output: t('output'), input: t('input'), net: t('net') },
    meta: { from, to, note: 'Head-wise difference. Actual set-off follows GST rules (IGST credit is used first, then CGST/SGST) — confirm with your CA before filing.' },
  };
}

export const EXPENSE_REPORTS: Record<string, (s: FinanceScope, q: Record<string, unknown>) => Promise<Report>> = {
  'gst-expenses': gstOnExpenses,
  'expense-gst-details': expenseGstDetails,
  'net-gst-payable': netGstPayable,
};

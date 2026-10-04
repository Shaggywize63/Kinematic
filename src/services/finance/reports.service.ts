import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { FinanceScope, scoped } from './scope';
import { round2 } from './money';
import { getSettings } from './masters.service';

const db = () => supabaseAdmin;
const fail = (e: { message: string }) => new AppError(500, e.message, 'DB_ERROR');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
const REVENUE_STATUSES = ['sent', 'partially_paid', 'paid'];

/** Page through a PostgREST query (1000-row server cap). */
async function fetchAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw fail(error);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
    if (out.length >= 50_000) break; // safety valve
  }
  return out;
}

export interface Column { key: string; label: string; type?: 'text' | 'money' | 'number' | 'date' }
export interface Report { title: string; columns: Column[]; rows: Array<Record<string, unknown>>; totals?: Record<string, unknown>; meta: Record<string, unknown> }

function range(q: Record<string, unknown>) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to)) ? String(q.to) : todayIso();
  const fromDefault = new Date(); fromDefault.setUTCDate(1);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from)) ? String(q.from) : iso(fromDefault);
  return { from, to };
}

// ── Fiscal year helpers ─────────────────────────────────────────────────────
function fiscalYear(startMonth: number, period: string) {
  const now = new Date();
  const m = now.getUTCMonth() + 1;
  let startYear = m >= startMonth ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  if (period === 'last_fy') startYear -= 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 0));
  return { start, end, startYear };
}

// ── Dashboard ───────────────────────────────────────────────────────────────
export async function dashboard(s: FinanceScope, query: Record<string, unknown>) {
  const settings = await getSettings(s);
  const fy = fiscalYear(Number(settings.fiscal_year_start_month) || 4, String(query.period || 'this_fy'));
  const fyFrom = iso(fy.start), fyTo = iso(fy.end);

  const open = await fetchAll((a, b) => scoped(db().from('finance_documents').select('balance,due_date,status'), s)
    .eq('doc_type', 'invoice').in('status', ['sent', 'partially_paid']).gt('balance', 0).is('deleted_at', null).range(a, b));
  const buckets = { current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45_plus: 0 };
  const now = Date.now();
  let overdueCount = 0;
  for (const r of open) {
    const bal = Number(r.balance);
    const days = r.due_date ? Math.floor((now - new Date(`${r.due_date}T00:00:00Z`).getTime()) / 86_400_000) : 0;
    if (days <= 0) buckets.current += bal;
    else { overdueCount++; if (days <= 15) buckets.d1_15 += bal; else if (days <= 30) buckets.d16_30 += bal; else if (days <= 45) buckets.d31_45 += bal; else buckets.d45_plus += bal; }
  }

  const invoices = await fetchAll((a, b) => scoped(db().from('finance_documents').select('issue_date,total'), s)
    .eq('doc_type', 'invoice').in('status', REVENUE_STATUSES).is('deleted_at', null).gte('issue_date', fyFrom).lte('issue_date', fyTo).range(a, b));
  const pays = await fetchAll((a, b) => scoped(db().from('finance_payments').select('payment_date,amount'), s)
    .is('deleted_at', null).gte('payment_date', fyFrom).lte('payment_date', fyTo).range(a, b));

  const months: Array<{ month: string; label: string; sales: number; receipts: number }> = [];
  const idx = new Map<string, number>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(fy.start.getUTCFullYear(), fy.start.getUTCMonth() + i, 1));
    const key = iso(d).slice(0, 7);
    idx.set(key, months.length);
    months.push({ month: key, label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), sales: 0, receipts: 0 });
  }
  for (const r of invoices) { const i = idx.get(String(r.issue_date).slice(0, 7)); if (i !== undefined) months[i].sales += Number(r.total); }
  for (const r of pays) { const i = idx.get(String(r.payment_date).slice(0, 7)); if (i !== undefined) months[i].receipts += Number(r.amount); }
  months.forEach((m) => { m.sales = round2(m.sales); m.receipts = round2(m.receipts); });

  const counts = await Promise.all([
    scoped(db().from('finance_documents').select('id', { count: 'exact', head: true }), s).eq('doc_type', 'invoice').eq('status', 'draft').is('deleted_at', null),
    scoped(db().from('finance_documents').select('id', { count: 'exact', head: true }), s).eq('doc_type', 'quote').in('status', ['draft', 'sent']).is('deleted_at', null),
  ]);
  const totalReceivables = Object.values(buckets).reduce((x, y) => x + y, 0);
  return {
    period: { from: fyFrom, to: fyTo, label: `${fy.startYear}-${String(fy.startYear + 1).slice(2)}` },
    receivables: {
      total: round2(totalReceivables), current: round2(buckets.current), d1_15: round2(buckets.d1_15), d16_30: round2(buckets.d16_30),
      d31_45: round2(buckets.d31_45), d45_plus: round2(buckets.d45_plus), open_invoices: open.length, overdue_invoices: overdueCount,
    },
    totals: {
      sales: round2(months.reduce((x, m) => x + m.sales, 0)),
      receipts: round2(months.reduce((x, m) => x + m.receipts, 0)),
    },
    months,
    draft_invoices: counts[0].count ?? 0,
    open_quotes: counts[1].count ?? 0,
  };
}

// ── Tabular reports ─────────────────────────────────────────────────────────
export async function salesByCustomer(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const docs = await fetchAll((a, b) => scoped(db().from('finance_documents').select('customer_id,customer_snapshot,taxable_value,tax_total,total,amount_paid'), s)
    .eq('doc_type', 'invoice').in('status', REVENUE_STATUSES).is('deleted_at', null).gte('issue_date', from).lte('issue_date', to).range(a, b));
  const m = new Map<string, Record<string, number | string>>();
  for (const d of docs) {
    const k = String(d.customer_id);
    const r = m.get(k) ?? { customer: (d.customer_snapshot as { name?: string })?.name ?? '—', invoice_count: 0, sales: 0, tax: 0, total: 0, received: 0 };
    r.invoice_count = Number(r.invoice_count) + 1; r.sales = Number(r.sales) + Number(d.taxable_value);
    r.tax = Number(r.tax) + Number(d.tax_total); r.total = Number(r.total) + Number(d.total); r.received = Number(r.received) + Number(d.amount_paid);
    m.set(k, r);
  }
  const rows = Array.from(m.values()).map((r) => ({ ...r, sales: round2(Number(r.sales)), tax: round2(Number(r.tax)), total: round2(Number(r.total)), received: round2(Number(r.received)) }))
    .sort((a, b) => b.total - a.total);
  const sum = (k: string) => round2(rows.reduce((x, r) => x + Number((r as Record<string, unknown>)[k]), 0));
  return {
    title: 'Sales by Customer',
    columns: [{ key: 'customer', label: 'Customer' }, { key: 'invoice_count', label: 'Invoices', type: 'number' }, { key: 'sales', label: 'Sales (excl. tax)', type: 'money' },
      { key: 'tax', label: 'Tax', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'received', label: 'Received', type: 'money' }],
    rows, totals: { customer: 'Total', invoice_count: sum('invoice_count'), sales: sum('sales'), tax: sum('tax'), total: sum('total'), received: sum('received') },
    meta: { from, to },
  };
}

async function itemLines(s: FinanceScope, from: string, to: string) {
  return fetchAll((a, b) => db().from('finance_document_items')
    .select('name,hsn_sac,unit,quantity,taxable_value,cgst,sgst,igst,total,gst_rate, document:finance_documents!inner(doc_type,status,issue_date,org_id,client_id,deleted_at)')
    .eq('document.org_id', s.org_id)
    .eq('document.doc_type', 'invoice').in('document.status', REVENUE_STATUSES).is('document.deleted_at', null)
    .gte('document.issue_date', from).lte('document.issue_date', to)
    .range(a, b)).then((rows) => rows.filter((r) => {
      const d = (r as unknown as { document: { client_id: string | null } }).document;
      return (d.client_id ?? null) === (s.client_id ?? null);
    }));
}

export async function salesByItem(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const lines = await itemLines(s, from, to);
  const m = new Map<string, Record<string, number | string>>();
  for (const l of lines) {
    const k = `${l.name}|${l.hsn_sac ?? ''}`;
    const r = m.get(k) ?? { item: l.name as string, hsn_sac: (l.hsn_sac as string) ?? '', quantity: 0, sales: 0, tax: 0, total: 0 };
    r.quantity = Number(r.quantity) + Number(l.quantity); r.sales = Number(r.sales) + Number(l.taxable_value);
    r.tax = Number(r.tax) + Number(l.cgst) + Number(l.sgst) + Number(l.igst); r.total = Number(r.total) + Number(l.total);
    m.set(k, r);
  }
  const rows = Array.from(m.values()).map((r) => ({ ...r, sales: round2(Number(r.sales)), tax: round2(Number(r.tax)), total: round2(Number(r.total)) })).sort((a, b) => b.total - a.total);
  const sum = (k: string) => round2(rows.reduce((x, r) => x + Number((r as Record<string, unknown>)[k]), 0));
  return {
    title: 'Sales by Item',
    columns: [{ key: 'item', label: 'Item' }, { key: 'hsn_sac', label: 'HSN/SAC' }, { key: 'quantity', label: 'Qty Sold', type: 'number' },
      { key: 'sales', label: 'Sales (excl. tax)', type: 'money' }, { key: 'tax', label: 'Tax', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }],
    rows, totals: { item: 'Total', quantity: sum('quantity'), sales: sum('sales'), tax: sum('tax'), total: sum('total') }, meta: { from, to },
  };
}

export async function gstSummary(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const lines = await itemLines(s, from, to);
  const m = new Map<number, Record<string, number>>();
  for (const l of lines) {
    const k = Number(l.gst_rate);
    const r = m.get(k) ?? { gst_rate: k, taxable: 0, cgst: 0, sgst: 0, igst: 0, total_tax: 0 };
    r.taxable += Number(l.taxable_value); r.cgst += Number(l.cgst); r.sgst += Number(l.sgst); r.igst += Number(l.igst);
    r.total_tax += Number(l.cgst) + Number(l.sgst) + Number(l.igst);
    m.set(k, r);
  }
  const rows = Array.from(m.values()).sort((a, b) => a.gst_rate - b.gst_rate)
    .map((r) => ({ gst_rate: `${r.gst_rate}%`, taxable: round2(r.taxable), cgst: round2(r.cgst), sgst: round2(r.sgst), igst: round2(r.igst), total_tax: round2(r.total_tax) }));
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'total_tax') => round2(rows.reduce((x, r) => x + r[k], 0));
  return {
    title: 'GST Summary (Output Tax)',
    columns: [{ key: 'gst_rate', label: 'GST Rate' }, { key: 'taxable', label: 'Taxable Value', type: 'money' }, { key: 'cgst', label: 'CGST', type: 'money' },
      { key: 'sgst', label: 'SGST', type: 'money' }, { key: 'igst', label: 'IGST', type: 'money' }, { key: 'total_tax', label: 'Total Tax', type: 'money' }],
    rows, totals: { gst_rate: 'Total', taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), total_tax: sum('total_tax') }, meta: { from, to },
  };
}

export async function receivablesAgeing(s: FinanceScope, _query: Record<string, unknown>): Promise<Report> {
  const open = await fetchAll((a, b) => scoped(db().from('finance_documents').select('customer_id,customer_snapshot,balance,due_date'), s)
    .eq('doc_type', 'invoice').in('status', ['sent', 'partially_paid']).gt('balance', 0).is('deleted_at', null).range(a, b));
  const m = new Map<string, Record<string, number | string>>();
  const now = Date.now();
  for (const d of open) {
    const k = String(d.customer_id);
    const r = m.get(k) ?? { customer: (d.customer_snapshot as { name?: string })?.name ?? '—', current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45_plus: 0, total: 0 };
    const days = d.due_date ? Math.floor((now - new Date(`${d.due_date}T00:00:00Z`).getTime()) / 86_400_000) : 0;
    const key = days <= 0 ? 'current' : days <= 15 ? 'd1_15' : days <= 30 ? 'd16_30' : days <= 45 ? 'd31_45' : 'd45_plus';
    r[key] = Number(r[key]) + Number(d.balance); r.total = Number(r.total) + Number(d.balance);
    m.set(k, r);
  }
  const rows = Array.from(m.values()).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? round2(v) : v])))
    .sort((a, b) => Number(b.total) - Number(a.total));
  const sum = (k: string) => round2(rows.reduce((x, r) => x + Number(r[k]), 0));
  return {
    title: 'Receivables Ageing Summary',
    columns: [{ key: 'customer', label: 'Customer' }, { key: 'current', label: 'Current', type: 'money' }, { key: 'd1_15', label: '1-15 Days', type: 'money' },
      { key: 'd16_30', label: '16-30 Days', type: 'money' }, { key: 'd31_45', label: '31-45 Days', type: 'money' }, { key: 'd45_plus', label: '> 45 Days', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }],
    rows, totals: { customer: 'Total', current: sum('current'), d1_15: sum('d1_15'), d16_30: sum('d16_30'), d31_45: sum('d31_45'), d45_plus: sum('d45_plus'), total: sum('total') },
    meta: { as_of: todayIso() },
  };
}

export async function paymentsReceived(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const pays = await fetchAll((a, b) => scoped(db().from('finance_payments').select('payment_number,payment_date,mode,reference,amount,unused_amount,customer:finance_customers(display_name)'), s)
    .is('deleted_at', null).gte('payment_date', from).lte('payment_date', to).order('payment_date', { ascending: true }).range(a, b));
  const rows = pays.map((p) => ({
    date: p.payment_date, payment_number: p.payment_number, customer: (p as unknown as { customer?: { display_name?: string } }).customer?.display_name ?? '—',
    mode: String(p.mode).replace('_', ' '), reference: p.reference ?? '', amount: Number(p.amount), unused: Number(p.unused_amount),
  }));
  return {
    title: 'Payments Received',
    columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'payment_number', label: 'Payment #' }, { key: 'customer', label: 'Customer' }, { key: 'mode', label: 'Mode' },
      { key: 'reference', label: 'Reference' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'unused', label: 'Unused', type: 'money' }],
    rows, totals: { date: 'Total', amount: round2(rows.reduce((x, r) => x + r.amount, 0)), unused: round2(rows.reduce((x, r) => x + r.unused, 0)) }, meta: { from, to },
  };
}

export async function invoiceDetails(s: FinanceScope, query: Record<string, unknown>): Promise<Report> {
  const { from, to } = range(query);
  const docs = await fetchAll((a, b) => scoped(db().from('finance_documents').select('number,issue_date,due_date,status,customer_snapshot,taxable_value,tax_total,total,amount_paid,balance'), s)
    .eq('doc_type', 'invoice').neq('status', 'draft').is('deleted_at', null).gte('issue_date', from).lte('issue_date', to).order('issue_date', { ascending: true }).range(a, b));
  const t = todayIso();
  const rows = docs.map((d) => ({
    date: d.issue_date, number: d.number, customer: (d.customer_snapshot as { name?: string })?.name ?? '—', due_date: d.due_date,
    status: (d.status === 'sent' || d.status === 'partially_paid') && d.due_date && String(d.due_date) < t ? 'overdue' : String(d.status).replace('_', ' '),
    taxable: Number(d.taxable_value), tax: Number(d.tax_total), total: Number(d.total), paid: Number(d.amount_paid), balance: Number(d.balance),
  }));
  const sum = (k: 'taxable' | 'tax' | 'total' | 'paid' | 'balance') => round2(rows.reduce((x, r) => x + r[k], 0));
  return {
    title: 'Invoice Details',
    columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Invoice #' }, { key: 'customer', label: 'Customer' }, { key: 'due_date', label: 'Due Date', type: 'date' },
      { key: 'status', label: 'Status' }, { key: 'taxable', label: 'Taxable', type: 'money' }, { key: 'tax', label: 'Tax', type: 'money' }, { key: 'total', label: 'Total', type: 'money' },
      { key: 'paid', label: 'Paid', type: 'money' }, { key: 'balance', label: 'Balance', type: 'money' }],
    rows, totals: { date: 'Total', taxable: sum('taxable'), tax: sum('tax'), total: sum('total'), paid: sum('paid'), balance: sum('balance') }, meta: { from, to },
  };
}

export const REPORTS: Record<string, (s: FinanceScope, q: Record<string, unknown>) => Promise<Report>> = {
  'sales-by-customer': salesByCustomer,
  'sales-by-item': salesByItem,
  'gst-summary': gstSummary,
  'receivables-ageing': receivablesAgeing,
  'payments-received': paymentsReceived,
  'invoice-details': invoiceDetails,
};

/** CSV with the same filters/columns as the on-screen report. */
export function reportToCsv(r: Report): string {
  const cell = (v: unknown) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [r.columns.map((c) => cell(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => cell(row[c.key])).join(','));
  if (r.totals) lines.push(r.columns.map((c) => cell(r.totals![c.key])).join(','));
  return lines.join('\n');
}

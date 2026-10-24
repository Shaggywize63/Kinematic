// Consolidated multi-company report: the same figures per company plus an all-company total.
export interface CompanyRef { id: string; name: string }
export interface OrderRow { client_id: string | null; grand_total: number | string | null }
export interface InvoiceRow { client_id: string | null; grand_total: number | string | null }
export interface PaymentRow { client_id: string | null; amount: number | string | null; mode: string | null }
export interface ReturnRow { client_id: string | null; total_value: number | string | null }

export interface CompanyTotals {
  orders: number; order_value: number;
  invoices: number; invoice_value: number;
  collected: number; collected_by_mode: Record<string, number>;
  returns: number; return_value: number;
}
export interface CompanyLine extends CompanyTotals { client_id: string | null; name: string }

const n = (v: unknown) => Number(v || 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const empty = (): CompanyTotals => ({
  orders: 0, order_value: 0, invoices: 0, invoice_value: 0,
  collected: 0, collected_by_mode: {}, returns: 0, return_value: 0,
});

export function buildCompanyReport(
  companies: CompanyRef[],
  rows: { orders: OrderRow[]; invoices: InvoiceRow[]; payments: PaymentRow[]; returns: ReturnRow[] },
): { companies: CompanyLine[]; total: CompanyTotals } {
  const known = new Set(companies.map((c) => c.id));
  const buckets = new Map<string | null, CompanyTotals>(companies.map((c) => [c.id, empty()]));
  // Rows with no company (or one outside the list) are kept visible rather than silently dropped.
  const slot = (id: string | null) => {
    const key = id && known.has(id) ? id : null;
    if (!buckets.has(key)) buckets.set(key, empty());
    return buckets.get(key)!;
  };

  rows.orders.forEach((o) => { const t = slot(o.client_id); t.orders += 1; t.order_value += n(o.grand_total); });
  rows.invoices.forEach((i) => { const t = slot(i.client_id); t.invoices += 1; t.invoice_value += n(i.grand_total); });
  rows.payments.forEach((p) => {
    const t = slot(p.client_id);
    const mode = p.mode || 'other';
    t.collected += n(p.amount);
    t.collected_by_mode[mode] = (t.collected_by_mode[mode] || 0) + n(p.amount);
  });
  rows.returns.forEach((x) => { const t = slot(x.client_id); t.returns += 1; t.return_value += n(x.total_value); });

  const round = (t: CompanyTotals): CompanyTotals => ({
    ...t,
    order_value: r2(t.order_value), invoice_value: r2(t.invoice_value),
    collected: r2(t.collected), return_value: r2(t.return_value),
    collected_by_mode: Object.fromEntries(Object.entries(t.collected_by_mode).map(([k, v]) => [k, r2(v)])),
  });

  const lines: CompanyLine[] = [];
  const total = empty();
  buckets.forEach((t, id) => {
    const isUnassigned = id === null;
    if (isUnassigned && t.orders + t.invoices + t.returns + t.collected === 0) return;
    lines.push({ client_id: id, name: isUnassigned ? 'No company' : companies.find((c) => c.id === id)!.name, ...round(t) });
    total.orders += t.orders; total.order_value += t.order_value;
    total.invoices += t.invoices; total.invoice_value += t.invoice_value;
    total.collected += t.collected; total.returns += t.returns; total.return_value += t.return_value;
    Object.entries(t.collected_by_mode).forEach(([k, v]) => { total.collected_by_mode[k] = (total.collected_by_mode[k] || 0) + v; });
  });
  return { companies: lines, total: round(total) };
}

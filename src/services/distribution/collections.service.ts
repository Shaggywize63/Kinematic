/**
 * Collections / outstanding service (Gomant C2).
 *
 * Everything here is DERIVED — no schema change and no invoice mutation:
 *
 *   paid(invoice)    = SUM(entry.amount) over `payments.applied_to_invoices` entries
 *                      that reference the invoice, counting only payments whose
 *                      status is `cleared` or `pending` (a `bounced` / `cancelled`
 *                      payment stops counting the instant its status flips).
 *   balance(invoice) = invoices.grand_total - paid
 *   open invoice     = invoices.status = 'issued' AND balance > 0
 *
 * The pure helpers (paidByInvoice / buildInvoiceBalances / allocateFifo /
 * validateManualAllocations) take plain rows so they can be unit-tested without
 * a database; the `load*` functions are the thin Supabase readers around them.
 *
 * Invoice columns relied on: invoices.id, invoice_no, outlet_id, distributor_id,
 * grand_total, issued_at, status, org_id.   (There is NO invoices.due_date column;
 * `due_date` is derived = issued date (IST) + distributors.payment_terms_days when
 * that is > 0, else null.)
 */
import { supabaseAdmin } from '../../lib/supabase';

// ── Types ────────────────────────────────────────────────────────────────────
export interface InvoiceRow {
  id: string;
  invoice_no: string | null;
  outlet_id?: string | null;
  distributor_id?: string | null;
  grand_total: number | string | null;
  issued_at: string | null;
  status?: string | null;
}

export interface PaymentLike {
  status?: string | null;
  applied_to_invoices?: unknown;
}

/** One persisted allocation entry on a payment. */
export interface AllocationEntry {
  invoice_id: string;
  invoice_no: string;
  amount: number;
}

export interface InvoiceBalance {
  invoice_id: string;
  invoice_no: string;
  /** IST calendar date of issued_at, YYYY-MM-DD. */
  invoice_date: string;
  /** invoice_date + distributor payment terms (days) when terms > 0, else null. */
  due_date: string | null;
  total: number;
  paid: number;
  balance: number;
  /** Raw issued_at, used only for oldest-first ordering. */
  issued_at: string;
}

/** (Not a discriminated union: the project compiles with strict=false, where `ok` would not narrow.) */
export interface ManualValidation {
  ok: boolean;
  /** Present (and non-empty) only when ok. */
  allocations: AllocationEntry[];
  /** Present only when !ok. */
  error?: string;
  /** Offending invoice ids, when the failure is about specific invoices. */
  invoice_ids?: string[];
}

/** Payment statuses whose allocations count as "paid". */
export const COUNTED_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['cleared', 'pending']);

// ── Small numeric / date helpers ─────────────────────────────────────────────
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** Money epsilon: amounts within half a paisa are treated as equal. */
const EPS = 0.005;

const IST_OFFSET_MS = 5.5 * 3600_000;
/** IST calendar date (YYYY-MM-DD) of an ISO timestamp; '' when unparseable. */
export function istDateOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD + N days (pure calendar arithmetic, no TZ drift). */
export function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Pure: paid derivation ────────────────────────────────────────────────────
/**
 * invoice_id -> amount already paid, from `applied_to_invoices` entries of payments
 * whose status is cleared|pending. Malformed entries (no invoice_id, non-positive
 * or non-numeric amount) are ignored. A payment with no/invalid JSON is skipped.
 */
export function paidByInvoice(payments: PaymentLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of payments || []) {
    const status = String(p?.status ?? '').toLowerCase();
    if (!COUNTED_PAYMENT_STATUSES.has(status)) continue;
    const apps = p?.applied_to_invoices;
    if (!Array.isArray(apps)) continue;
    for (const a of apps) {
      const id = a && typeof a === 'object' ? (a as any).invoice_id : null;
      const amount = num(a && typeof a === 'object' ? (a as any).amount : 0);
      if (!id || typeof id !== 'string' || amount <= 0) continue;
      out.set(id, round2((out.get(id) || 0) + amount));
    }
  }
  return out;
}

/**
 * Balance rows for the given invoices (cancelled / non-issued ones are dropped),
 * sorted oldest-first (issued_at asc, then invoice_no, then id for determinism).
 * Rows with balance <= 0 are KEPT here (the manual-allocation validator needs to
 * see them to explain "already fully paid"); use {@link openInvoices} to list the
 * collectible ones.
 */
export function buildInvoiceBalances(
  invoices: InvoiceRow[],
  payments: PaymentLike[],
  paymentTermsDays: Map<string, number> = new Map(),
): InvoiceBalance[] {
  const paid = paidByInvoice(payments);
  const rows: InvoiceBalance[] = [];
  for (const inv of invoices || []) {
    if (!inv?.id) continue;
    if (String(inv.status ?? 'issued').toLowerCase() !== 'issued') continue;
    const total = round2(num(inv.grand_total));
    const p = round2(paid.get(inv.id) || 0);
    const invoice_date = istDateOf(inv.issued_at);
    const terms = inv.distributor_id ? paymentTermsDays.get(inv.distributor_id) || 0 : 0;
    rows.push({
      invoice_id: inv.id,
      invoice_no: inv.invoice_no ?? '',
      invoice_date,
      due_date: invoice_date && terms > 0 ? addDaysToDate(invoice_date, terms) : null,
      total,
      paid: p,
      balance: round2(total - p),
      issued_at: inv.issued_at ?? '',
    });
  }
  rows.sort((a, b) =>
    (a.issued_at || '').localeCompare(b.issued_at || '') ||
    a.invoice_no.localeCompare(b.invoice_no) ||
    a.invoice_id.localeCompare(b.invoice_id));
  return rows;
}

/** Only the collectible invoices (balance > 0), oldest first. */
export function openInvoices(balances: InvoiceBalance[]): InvoiceBalance[] {
  return balances.filter((b) => b.balance > EPS);
}

// ── Pure: FIFO auto-allocation ───────────────────────────────────────────────
/**
 * Oldest-first allocation of `amount` across `open` (assumed already oldest-first
 * and balance > 0). Each invoice receives min(remaining, its balance). Whatever is
 * left over stays unallocated ("on account").
 */
export function allocateFifo(
  open: InvoiceBalance[],
  amount: number,
): { allocations: AllocationEntry[]; allocated: number; unallocated: number } {
  let remaining = round2(Math.max(0, num(amount)));
  const allocations: AllocationEntry[] = [];
  for (const inv of open) {
    if (remaining <= EPS) break;
    if (inv.balance <= EPS) continue;
    const take = round2(Math.min(remaining, inv.balance));
    if (take <= 0) continue;
    allocations.push({ invoice_id: inv.invoice_id, invoice_no: inv.invoice_no, amount: take });
    remaining = round2(remaining - take);
  }
  const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
  return { allocations, allocated, unallocated: round2(num(amount) - allocated) };
}

// ── Pure: manual allocation validation ───────────────────────────────────────
/**
 * Validate caller-supplied `applied_to_invoices` against the outlet's invoices.
 *
 * `outletBalances` must be the balances of invoices that belong to the payment's
 * org + outlet ONLY (see {@link loadOutletInvoiceBalances}); any invoice_id that
 * is not in that set is therefore "not this outlet's invoice" (wrong outlet,
 * wrong org, cancelled, or nonexistent) and is rejected.
 *
 * Rules (any violation rejects the whole request):
 *   - invoice must be one of the outlet's issued invoices
 *   - duplicate invoice_ids are merged (amounts summed) before checking
 *   - each (merged) amount must be <= that invoice's current balance
 *   - the total allocated must not exceed the payment amount
 * The returned entries always carry the SERVER's invoice_no (a client-sent
 * invoice_no is never trusted).
 */
export function validateManualAllocations(
  entries: Array<{ invoice_id?: string; amount?: number; invoice_no?: string | null }>,
  outletBalances: InvoiceBalance[],
  paymentAmount: number,
): ManualValidation {
  const byId = new Map(outletBalances.map((b) => [b.invoice_id, b]));
  const merged = new Map<string, number>();
  for (const e of entries) {
    merged.set(e.invoice_id, round2((merged.get(e.invoice_id) || 0) + num(e.amount)));
  }

  const foreign = [...merged.keys()].filter((id) => !byId.has(id));
  if (foreign.length) {
    return {
      ok: false,
      allocations: [],
      error: 'applied_to_invoices contains invoices that do not belong to this outlet',
      invoice_ids: foreign,
    };
  }

  const over: string[] = [];
  for (const [id, amount] of merged) {
    if (amount > byId.get(id)!.balance + EPS) over.push(id);
  }
  if (over.length) {
    return {
      ok: false,
      allocations: [],
      error: 'applied_to_invoices amount exceeds the outstanding balance of an invoice',
      invoice_ids: over,
    };
  }

  const allocations: AllocationEntry[] = [...merged].map(([id, amount]) => ({
    invoice_id: id,
    invoice_no: byId.get(id)!.invoice_no,
    amount,
  }));
  const total = round2(allocations.reduce((s, a) => s + a.amount, 0));
  if (total > round2(num(paymentAmount)) + EPS) {
    return { ok: false, allocations: [], error: 'applied_to_invoices total exceeds the payment amount' };
  }
  return { ok: true, allocations };
}

// ── DB readers ───────────────────────────────────────────────────────────────
const PAGE = 1000;
const MAX_PAGES = 20;

/** Page through a query builder factory until a short page (bounded). */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    const got = data ?? [];
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  return rows;
}

/**
 * Balances (every issued invoice, including fully-paid ones) for ONE outlet in
 * ONE org, oldest first. Reads invoices + the outlet's cleared/pending payments +
 * the distributors' payment terms. Callers must have already verified that the
 * outlet belongs to the caller's org/client (the invoices query is org + outlet
 * scoped; client scoping is enforced on the outlet, not the invoice, because
 * legacy invoices may carry client_id = null).
 */
export async function loadOutletInvoiceBalances(orgId: string, outletId: string): Promise<InvoiceBalance[]> {
  const invoices = await fetchAll<InvoiceRow>((from, to) =>
    supabaseAdmin.from('invoices')
      .select('id, invoice_no, outlet_id, distributor_id, grand_total, issued_at, status')
      .eq('org_id', orgId).eq('outlet_id', outletId).eq('status', 'issued')
      .order('issued_at', { ascending: true }).order('id', { ascending: true })
      .range(from, to) as any);
  if (!invoices.length) return [];

  const payments = await fetchAll<PaymentLike & { id: string }>((from, to) =>
    supabaseAdmin.from('payments')
      .select('id, status, applied_to_invoices')
      .eq('org_id', orgId).eq('outlet_id', outletId).in('status', [...COUNTED_PAYMENT_STATUSES])
      .order('received_at', { ascending: true }).order('id', { ascending: true })
      .range(from, to) as any);

  const distIds = [...new Set(invoices.map((i) => i.distributor_id).filter(Boolean))] as string[];
  const terms = new Map<string, number>();
  if (distIds.length) {
    const { data: dists } = await supabaseAdmin.from('distributors')
      .select('id, payment_terms_days').eq('org_id', orgId).in('id', distIds);
    for (const d of (dists as any[]) || []) terms.set(d.id, num(d.payment_terms_days));
  }
  return buildInvoiceBalances(invoices, payments, terms);
}

/** Latest ledger running balance for an outlet, or null when it has no ledger rows. */
export async function loadLedgerBalance(orgId: string, outletId: string): Promise<number | null> {
  const { data } = await supabaseAdmin.from('ledger_entries')
    .select('running_balance')
    .eq('org_id', orgId).eq('outlet_id', outletId)
    .order('posted_at', { ascending: false }).order('id', { ascending: false })
    .limit(1);
  const row = (data as any[] | null)?.[0];
  return row && row.running_balance != null ? round2(num(row.running_balance)) : null;
}

/**
 * balance = ledger running balance when the outlet has ledger rows, else the sum
 * of its open invoice balances (contract C2).
 */
export function resolveOutstandingBalance(ledgerBalance: number | null, open: InvoiceBalance[]): number {
  if (ledgerBalance != null) return ledgerBalance;
  return round2(open.reduce((s, b) => s + b.balance, 0));
}

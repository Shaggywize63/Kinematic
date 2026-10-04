import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { FinanceScope, scoped } from './scope';
import { round2 } from './money';
import { getCustomer, pageParams, safeSearch } from './masters.service';
import { insertNumbered } from './documents.service';

const db = () => supabaseAdmin;
const fail = (e: { message: string }) => new AppError(500, e.message, 'DB_ERROR');
const EPS = 0.005;

export interface Allocation { document_id: string; amount: number }
export interface PaymentInput {
  customer_id: string;
  payment_date?: string;
  amount: number;
  mode?: 'cash' | 'bank_transfer' | 'upi' | 'cheque' | 'card' | 'other';
  reference?: string | null;
  notes?: string | null;
  allocations?: Allocation[];
  /** When no allocations are given, settle the customer's oldest open invoices first. */
  auto_apply?: boolean;
}

/** Recompute amount_paid / balance / status of an invoice from its live allocations. */
export async function recalcInvoice(s: FinanceScope, documentId: string) {
  const { data: doc, error } = await scoped(db().from('finance_documents').select('id,total,status,sent_at'), s).eq('id', documentId).maybeSingle();
  if (error) throw fail(error);
  if (!doc) return;
  const al = await db().from('finance_payment_allocations')
    .select('amount, payment:finance_payments(deleted_at)').eq('document_id', documentId);
  if (al.error) throw fail(al.error);
  const paid = round2((al.data ?? [])
    .filter((a) => !(a as unknown as { payment?: { deleted_at?: string | null } }).payment?.deleted_at)
    .reduce((sum, a) => sum + Number(a.amount), 0));
  const balance = round2(Number(doc.total) - paid);
  let status = doc.status as string;
  if (status !== 'void' && status !== 'draft') status = balance <= EPS ? 'paid' : paid > 0 ? 'partially_paid' : 'sent';
  const up = await scoped(db().from('finance_documents').update({ amount_paid: paid, balance: Math.max(balance, 0), status }), s).eq('id', documentId);
  if (up.error) throw fail(up.error);
}

async function openInvoices(s: FinanceScope, customerId: string, ids?: string[]) {
  let q = scoped(db().from('finance_documents').select('id,number,balance,status,issue_date,customer_id'), s)
    .eq('doc_type', 'invoice').eq('customer_id', customerId).is('deleted_at', null).in('status', ['sent', 'partially_paid']).gt('balance', 0);
  if (ids) q = q.in('id', ids);
  const { data, error } = await q.order('issue_date', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw fail(error);
  return data ?? [];
}

async function validateAllocations(s: FinanceScope, customerId: string, allocations: Allocation[], available: number) {
  const merged = new Map<string, number>();
  for (const a of allocations) merged.set(a.document_id, round2((merged.get(a.document_id) ?? 0) + a.amount));
  const sum = round2(Array.from(merged.values()).reduce((x, y) => x + y, 0));
  if (sum > available + EPS) throw new AppError(400, `Applied amount (${sum.toFixed(2)}) exceeds the available amount (${available.toFixed(2)})`, 'OVER_ALLOCATED');
  const open = await openInvoices(s, customerId, Array.from(merged.keys()));
  const byId = new Map(open.map((o) => [o.id as string, o]));
  for (const [docId, amt] of Array.from(merged.entries())) {
    const inv = byId.get(docId);
    if (!inv) throw new AppError(400, 'One of the invoices is not open for this customer', 'BAD_INVOICE');
    if (amt > Number(inv.balance) + EPS) throw new AppError(400, `${inv.number}: amount exceeds the balance due (${Number(inv.balance).toFixed(2)})`, 'OVER_BALANCE');
  }
  return { merged, sum };
}

export async function recordPayment(s: FinanceScope, input: PaymentInput) {
  await getCustomer(s, input.customer_id);
  const amount = round2(input.amount);
  if (!(amount > 0)) throw new AppError(400, 'Amount must be greater than zero', 'VALIDATION');

  let allocations = input.allocations ?? [];
  if (!allocations.length && input.auto_apply) {
    let left = amount;
    for (const inv of await openInvoices(s, input.customer_id)) {
      if (left <= EPS) break;
      const take = round2(Math.min(left, Number(inv.balance)));
      allocations.push({ document_id: inv.id as string, amount: take });
      left = round2(left - take);
    }
  }
  const { merged, sum } = await validateAllocations(s, input.customer_id, allocations, amount);

  const { data: pay, number: payment_number } = await insertNumbered(s, 'payment', (n) =>
    db().from('finance_payments').insert({
      org_id: s.org_id, client_id: s.client_id, payment_number: n, customer_id: input.customer_id,
      payment_date: input.payment_date || new Date().toISOString().slice(0, 10),
      amount, unused_amount: round2(amount - sum), mode: input.mode ?? 'bank_transfer',
      reference: input.reference ?? null, notes: input.notes ?? null, created_by: s.user_id || null,
    }).select('*').single());

  if (merged.size) {
    const ins = await db().from('finance_payment_allocations').insert(
      Array.from(merged.entries()).map(([document_id, amt]) => ({ org_id: s.org_id, payment_id: pay.id, document_id, amount: amt })));
    if (ins.error) {
      await db().from('finance_payments').delete().eq('id', pay.id);
      throw fail(ins.error);
    }
  }
  for (const docId of Array.from(merged.keys())) {
    await recalcInvoice(s, docId);
    await db().from('finance_document_events').insert({
      org_id: s.org_id, document_id: docId, event: 'payment_recorded', actor: s.actor || null,
      detail: { payment_number, amount: merged.get(docId), mode: input.mode ?? 'bank_transfer' },
    });
  }
  return getPayment(s, pay.id as string);
}

/** Apply the unused part of an existing payment (advance / over-payment) to open invoices. */
export async function applyPayment(s: FinanceScope, paymentId: string, allocations: Allocation[]) {
  const pay = await getPayment(s, paymentId);
  const { merged, sum } = await validateAllocations(s, pay.customer_id as string, allocations, Number(pay.unused_amount));
  if (!merged.size) throw new AppError(400, 'Choose at least one invoice', 'VALIDATION');
  const ins = await db().from('finance_payment_allocations').insert(
    Array.from(merged.entries()).map(([document_id, amt]) => ({ org_id: s.org_id, payment_id: paymentId, document_id, amount: amt })));
  if (ins.error) throw fail(ins.error);
  const up = await scoped(db().from('finance_payments').update({ unused_amount: round2(Number(pay.unused_amount) - sum), updated_at: new Date().toISOString() }), s).eq('id', paymentId);
  if (up.error) throw fail(up.error);
  for (const docId of Array.from(merged.keys())) await recalcInvoice(s, docId);
  return getPayment(s, paymentId);
}

export async function getPayment(s: FinanceScope, id: string) {
  const { data, error } = await scoped(db().from('finance_payments').select(
    '*, customer:finance_customers(id,display_name,email), allocations:finance_payment_allocations(id,amount,document:finance_documents(id,number,total,issue_date))'), s)
    .eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw fail(error);
  if (!data) throw new AppError(404, 'Payment not found', 'NOT_FOUND');
  return data;
}

export async function listPayments(s: FinanceScope, query: Record<string, unknown>) {
  const { page, limit, from, to } = pageParams(query);
  let q = scoped(db().from('finance_payments').select('*, customer:finance_customers(id,display_name)', { count: 'exact' }), s).is('deleted_at', null);
  if (query.customer_id) q = q.eq('customer_id', String(query.customer_id));
  if (query.mode) q = q.eq('mode', String(query.mode));
  if (query.from) q = q.gte('payment_date', String(query.from));
  if (query.to) q = q.lte('payment_date', String(query.to));
  const term = safeSearch(query.q);
  if (term) q = q.or(`payment_number.ilike.%${term}%,reference.ilike.%${term}%`);
  const { data, error, count } = await q.order('payment_date', { ascending: false }).order('created_at', { ascending: false }).range(from, to);
  if (error) throw fail(error);
  return { rows: data ?? [], total: count ?? 0, page, limit };
}

export async function updatePayment(s: FinanceScope, id: string, patch: { payment_date?: string; mode?: PaymentInput['mode']; reference?: string | null; notes?: string | null }) {
  await getPayment(s, id);
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ['payment_date', 'mode', 'reference', 'notes'] as const) if (patch[k] !== undefined) row[k] = patch[k];
  const { error } = await scoped(db().from('finance_payments').update(row), s).eq('id', id);
  if (error) throw fail(error);
  return getPayment(s, id);
}

export async function deletePayment(s: FinanceScope, id: string) {
  await getPayment(s, id);
  const al = await db().from('finance_payment_allocations').select('document_id').eq('payment_id', id);
  if (al.error) throw fail(al.error);
  const docIds = Array.from(new Set((al.data ?? []).map((a) => a.document_id as string)));
  const delA = await db().from('finance_payment_allocations').delete().eq('payment_id', id);
  if (delA.error) throw fail(delA.error);
  const del = await scoped(db().from('finance_payments').update({ deleted_at: new Date().toISOString() }), s).eq('id', id);
  if (del.error) throw fail(del.error);
  for (const d of docIds) await recalcInvoice(s, d);
  return { id };
}

/** Open invoices for the payment form's "apply to" table. */
export async function openInvoicesForCustomer(s: FinanceScope, customerId: string) {
  await getCustomer(s, customerId);
  return openInvoices(s, customerId);
}

/**
 * Client Management → Account & Billing helpers.
 *
 * Powers the per-client account summary shown in Client Management:
 *   - allocated : the org's seat cap (org_settings 'limits.max_active_users')
 *   - active    : how many non-staff users are active right now (mirrors
 *                 assertActiveUserCap's population exactly, so "active vs
 *                 allocated" matches what the cap actually enforces)
 *   - next_payment : the client's next unpaid invoice, looked up in the
 *                 PARENT org's finance data via the linked finance customer
 *                 (clients.settings.billing.finance_customer_id). "Next
 *                 payment date = the invoice's due date" — the billing model
 *                 the operator chose.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { round2 } from './finance/money';
import { addDays, addMonths, specFromRow, type RecurrenceSpec } from './finance/recurrence';
import type { FinanceScope } from './finance/scope';
import * as docs from './finance/documents.service';

// Internal/staff domains never count toward a seat cap (see assertActiveUserCap
// in misc.controller). Kept in sync here so the displayed "active" equals the
// number the cap is measured against.
const STAFF_DOMAINS = new Set([
  'kinematicapp.com', 'horizontechstudio.com', 'kinematic.com', 'kaiyotechnologylabs.com',
]);
const domainOf = (email?: string | null): string => String(email || '').split('@')[1]?.toLowerCase().trim() || '';

/** True for an internal / staff email, which never counts toward a seat cap. */
export const isStaffEmail = (email?: string | null): boolean => STAFF_DOMAINS.has(domainOf(email));

export interface NextPayment {
  invoice_id: string | null;
  number: string | null;
  due_date: string | null;
  total: number | null;
  balance: number | null;
  status: string;
  share_token: string | null;
  /** True when nothing has actually been invoiced yet — due_date is the linked
   *  recurring invoice's next_invoice_date, a projection, not a real unpaid bill. */
  scheduled: boolean;
}

/** The finance customer this client is billed as, if linked. */
export function financeCustomerIdOf(client: { settings?: unknown } | null | undefined): string | null {
  const s = (client as { settings?: { billing?: { finance_customer_id?: unknown } } } | null)?.settings;
  const id = s?.billing?.finance_customer_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** The reverse of financeCustomerIdOf: which client (if any), owned by this
 *  org, is billed as this finance customer. Used to auto-apply pending seat
 *  charges the moment a new invoice is raised for that customer (see
 *  documents.service.ts createDocument). A full scan + JS filter rather than
 *  a JSON-path query — org-scoped client counts are small, and this sidesteps
 *  owner_org_id, which doesn't exist on every project (see CLAUDE.md). */
export async function findClientByFinanceCustomer(orgId: string, customerId: string): Promise<{ id: string } | null> {
  if (!orgId || !customerId) return null;
  const { data } = await supabaseAdmin.from('clients').select('id, settings').eq('org_id', orgId);
  for (const row of (data ?? []) as Array<{ id: string; settings?: unknown }>) {
    if (financeCustomerIdOf(row) === customerId) return { id: row.id };
  }
  return null;
}

/** Read the seat cap for an org (null = no cap). */
export async function readSeatCap(admin: SupabaseClient, orgId: string): Promise<number | null> {
  const { data } = await admin
    .from('org_settings').select('value').eq('org_id', orgId).eq('key', 'limits.max_active_users').maybeSingle();
  const n = parseInt(String((data as { value?: unknown } | null)?.value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Count active, non-staff users in an org — the same population the seat cap enforces. */
export async function countActiveUsers(admin: SupabaseClient, orgId: string): Promise<number> {
  const { data } = await admin.from('users').select('id, email').eq('org_id', orgId).eq('is_active', true);
  return (data || []).filter((u) => !STAFF_DOMAINS.has(domainOf((u as { email?: string }).email))).length;
}

/** Active, non-staff user counts for many orgs at once (one query). Keyed by org_id; absent = 0. */
export async function countActiveUsersByOrg(admin: SupabaseClient, orgIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!orgIds.length) return out;
  const { data } = await admin.from('users').select('org_id, email').in('org_id', orgIds).eq('is_active', true);
  for (const u of (data || []) as Array<{ org_id?: string; email?: string }>) {
    if (!u.org_id || STAFF_DOMAINS.has(domainOf(u.email))) continue;
    out[u.org_id] = (out[u.org_id] ?? 0) + 1;
  }
  return out;
}

/** The next unpaid invoice for many linked finance customers at once (one query per finance org).
 *  Keyed by customer_id → the soonest-due open invoice; absent = nothing outstanding. */
export async function nextUnpaidInvoicesByCustomer(financeOrgId: string, customerIds: string[]): Promise<Record<string, NextPayment>> {
  const out: Record<string, NextPayment> = {};
  if (!financeOrgId || !customerIds.length) return out;
  const { data, error } = await supabaseAdmin
    .from('finance_documents')
    .select('id, number, due_date, total, balance, status, share_token, customer_id')
    .eq('org_id', financeOrgId)
    .eq('doc_type', 'invoice')
    .in('customer_id', customerIds)
    .is('deleted_at', null)
    .in('status', ['sent', 'partially_paid'])
    .gt('balance', 0)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error || !data) return out;
  for (const d of data as Array<{
    id: string; number: string; due_date: string | null; total: number | string; balance: number | string; status: string; share_token: string | null; customer_id: string;
  }>) {
    if (out[d.customer_id]) continue; // ordered soonest-due first, so the first per customer wins
    out[d.customer_id] = {
      invoice_id: d.id, number: d.number, due_date: d.due_date ?? null,
      total: Number(d.total), balance: Number(d.balance), status: d.status, share_token: d.share_token ?? null,
      scheduled: false,
    };
  }
  return out;
}

/** Batched form of currentCycleFor's lookup — the soonest next_invoice_date per
 *  customer, for clients with no real unpaid invoice yet (see nextPaymentsFor). */
export async function scheduledNextInvoicesByCustomer(financeOrgId: string, customerIds: string[]): Promise<Record<string, NextPayment>> {
  const out: Record<string, NextPayment> = {};
  if (!financeOrgId || !customerIds.length) return out;
  const { data, error } = await supabaseAdmin
    .from('finance_documents')
    .select('customer_id, next_invoice_date')
    .eq('org_id', financeOrgId)
    .eq('doc_type', 'invoice')
    .in('customer_id', customerIds)
    .eq('recurrence_enabled', true)
    .is('deleted_at', null)
    .not('next_invoice_date', 'is', null)
    .order('next_invoice_date', { ascending: true });
  if (error || !data) return out;
  for (const d of data as Array<{ customer_id: string; next_invoice_date: string }>) {
    if (out[d.customer_id]) continue; // ordered soonest-first, so the first per customer wins
    out[d.customer_id] = {
      invoice_id: null, number: null, due_date: d.next_invoice_date, total: null, balance: null,
      status: 'scheduled', share_token: null, scheduled: true,
    };
  }
  return out;
}

/**
 * The client's next payment, for display: a real unpaid invoice if one
 * exists, else the linked recurring invoice's next_invoice_date as a
 * "scheduled" projection (nothing owed yet, but this is when the next
 * charge is due to go out) — rather than showing no date at all just
 * because the client is currently paid up. Batched sibling of
 * nextUnpaidInvoicesByCustomer + scheduledNextInvoicesByCustomer, for the
 * client list; nextPaymentFor below is the single-client form.
 */
export async function nextPaymentsFor(financeOrgId: string, customerIds: string[]): Promise<Record<string, NextPayment>> {
  const real = await nextUnpaidInvoicesByCustomer(financeOrgId, customerIds);
  const missing = customerIds.filter((id) => !real[id]);
  const scheduled = missing.length ? await scheduledNextInvoicesByCustomer(financeOrgId, missing) : {};
  return { ...real, ...scheduled };
}

/**
 * The client's next unpaid invoice (soonest due first) for a linked finance
 * customer, looked up in the finance org that raised it (the managing org).
 * Returns null when nothing is outstanding or no customer is linked.
 */
export async function nextUnpaidInvoice(financeOrgId: string, customerId: string): Promise<NextPayment | null> {
  const { data, error } = await supabaseAdmin
    .from('finance_documents')
    .select('id, number, due_date, total, balance, status, share_token')
    .eq('org_id', financeOrgId)
    .eq('doc_type', 'invoice')
    .eq('customer_id', customerId)
    .is('deleted_at', null)
    .in('status', ['sent', 'partially_paid'])
    .gt('balance', 0)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const d = data[0] as {
    id: string; number: string; due_date: string | null; total: number | string; balance: number | string; status: string; share_token: string | null;
  };
  return {
    invoice_id: d.id,
    number: d.number,
    due_date: d.due_date ?? null,
    total: Number(d.total),
    balance: Number(d.balance),
    status: d.status,
    share_token: d.share_token ?? null,
    scheduled: false,
  };
}

/** Single-client form of nextPaymentsFor — see its doc comment. */
export async function nextPaymentFor(financeOrgId: string, customerId: string): Promise<NextPayment | null> {
  const real = await nextUnpaidInvoice(financeOrgId, customerId);
  if (real) return real;
  const cycle = await currentCycleFor(financeOrgId, customerId);
  if (!cycle) return null;
  return {
    invoice_id: null, number: null, due_date: cycle.cycle_end, total: null, balance: null,
    status: 'scheduled', share_token: null, scheduled: true,
  };
}

// ── Pro-rated mid-cycle seat charges ─────────────────────────────────────────
//
// Opt-in per client: set clients.settings.billing.price_per_user to start
// tracking. When a seat is added partway through a billing cycle (see the
// call sites — misc.controller.ts createUser/updateUser, clientAdmins.service
// createClientAdmin/setClientAdminActive), queueSeatCharge() records a
// client_seat_charges row prorated for the days remaining in the cycle. An
// admin applies the pending charges to the client's next invoice from the
// Account & Billing panel (client.controller.ts applySeatCharges), which adds
// them as extra line items via the finance module.

const MONTHS_FOR_INTERVAL: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

export interface CycleWindow {
  cycle_start: string;
  cycle_end: string;
  cycle_days: number;
}

export interface SeatCharge {
  id: string;
  client_id: string;
  user_id: string | null;
  user_label: string;
  added_on: string;
  cycle_start: string | null;
  cycle_end: string | null;
  cycle_days: number | null;
  days_charged: number | null;
  price_per_user: number;
  prorated_amount: number;
  status: 'pending' | 'invoiced' | 'voided';
  invoice_document_id: string | null;
  created_at: string;
}

/** The per-seat price a client is billed, if the operator has configured one. */
export function priceOf(client: { settings?: unknown } | null | undefined): number | null {
  const s = (client as { settings?: { billing?: { price_per_user?: unknown } } } | null)?.settings;
  const n = Number(s?.billing?.price_per_user);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000);
}

/** The date one cadence before `endIso` — the mirror of recurrence.ts's addInterval, negated. */
function cycleStartBefore(endIso: string, spec: RecurrenceSpec): string {
  if (spec.interval === 'weekly') return addDays(endIso, -7);
  if (spec.interval === 'custom') {
    const n = Math.max(1, Math.floor(Number(spec.customEvery) || 1));
    return spec.customUnit === 'day' ? addDays(endIso, -n) : addMonths(endIso, -n);
  }
  return addMonths(endIso, -(MONTHS_FOR_INTERVAL[spec.interval] ?? 1));
}

/**
 * The client's current billing-cycle window, derived from the recurring
 * invoice template linked to its finance customer (the soonest-due one, if
 * more than one is somehow set up). Null when the client isn't linked to a
 * finance customer, or has no recurring invoice — proration then falls back
 * to charging the full seat price (see queueSeatCharge).
 */
export async function currentCycleFor(financeOrgId: string, customerId: string): Promise<CycleWindow | null> {
  if (!financeOrgId || !customerId) return null;
  const { data } = await supabaseAdmin
    .from('finance_documents')
    .select('next_invoice_date, recurrence_interval, recurrence_custom_every, recurrence_custom_unit')
    .eq('org_id', financeOrgId)
    .eq('doc_type', 'invoice')
    .eq('customer_id', customerId)
    .eq('recurrence_enabled', true)
    .is('deleted_at', null)
    .not('next_invoice_date', 'is', null)
    .order('next_invoice_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  const row = data as { next_invoice_date?: string | null; recurrence_interval?: string | null; recurrence_custom_every?: number | null; recurrence_custom_unit?: string | null } | null;
  if (!row?.next_invoice_date) return null;
  const spec = specFromRow(row);
  if (!spec) return null;
  const cycle_end = row.next_invoice_date;
  const cycle_start = cycleStartBefore(cycle_end, spec);
  return { cycle_start, cycle_end, cycle_days: daysBetween(cycle_start, cycle_end) };
}

// ── Renewal (billing-cycle) status + overdue status, for Client Management ──
//
// "Days left for renewal" and the 90%-consumed red highlight are derived from
// the SAME recurring-invoice cycle currentCycleFor already computes for
// proration — there's no separate "renewal date" field on clients (and none is
// added here), so this stays driven by real Finance data rather than a second,
// parallel source of truth. A client not linked to a finance customer, or
// linked but with no recurring invoice, has no renewal info — the UI shows
// "—", not a guess.

export interface RenewalInfo {
  cycle_start: string;
  cycle_end: string;
  cycle_days: number;
  /** Negative once the cycle has run past cycle_end (the next recurring invoice
   *  hasn't fired/been picked up yet) — the UI treats <= 0 the same as "ended". */
  days_left: number;
  /** 0–100, how much of the current cycle has elapsed. */
  percent_consumed: number;
}

function renewalInfoFromCycle(cycle: CycleWindow): RenewalInfo {
  const today = new Date().toISOString().slice(0, 10);
  const daysLeft = daysBetween(today, cycle.cycle_end);
  const consumedPct = cycle.cycle_days > 0 ? ((cycle.cycle_days - daysLeft) / cycle.cycle_days) * 100 : 100;
  return {
    cycle_start: cycle.cycle_start,
    cycle_end: cycle.cycle_end,
    cycle_days: cycle.cycle_days,
    days_left: daysLeft,
    percent_consumed: Math.max(0, Math.min(100, Math.round(consumedPct))),
  };
}

/** Single-client renewal window — see currentCycleFor for the source. Null when not linked to a
 *  finance customer, or linked but no recurring invoice is set up (nothing to derive a cycle from). */
export async function renewalInfoFor(financeOrgId: string, customerId: string): Promise<RenewalInfo | null> {
  const cycle = await currentCycleFor(financeOrgId, customerId);
  return cycle ? renewalInfoFromCycle(cycle) : null;
}

/** Batched form of renewalInfoFor, for the client list — one query per finance org. Mirrors
 *  scheduledNextInvoicesByCustomer's query shape, adding the recurrence fields needed to derive the
 *  cycle. First (soonest-due) recurring invoice per customer wins, like currentCycleFor. */
export async function renewalInfoByCustomer(financeOrgId: string, customerIds: string[]): Promise<Record<string, RenewalInfo>> {
  const out: Record<string, RenewalInfo> = {};
  if (!financeOrgId || !customerIds.length) return out;
  const { data, error } = await supabaseAdmin
    .from('finance_documents')
    .select('customer_id, next_invoice_date, recurrence_interval, recurrence_custom_every, recurrence_custom_unit')
    .eq('org_id', financeOrgId)
    .eq('doc_type', 'invoice')
    .in('customer_id', customerIds)
    .eq('recurrence_enabled', true)
    .is('deleted_at', null)
    .not('next_invoice_date', 'is', null)
    .order('next_invoice_date', { ascending: true });
  if (error || !data) return out;
  for (const row of data as Array<{
    customer_id: string; next_invoice_date: string; recurrence_interval: string | null;
    recurrence_custom_every: number | null; recurrence_custom_unit: string | null;
  }>) {
    if (out[row.customer_id]) continue; // ordered soonest-first, so the first per customer wins
    const spec = specFromRow(row);
    if (!spec) continue;
    const cycle_end = row.next_invoice_date;
    const cycle_start = cycleStartBefore(cycle_end, spec);
    out[row.customer_id] = renewalInfoFromCycle({ cycle_start, cycle_end, cycle_days: daysBetween(cycle_start, cycle_end) });
  }
  return out;
}

export interface OverdueInfo {
  invoice_id: string;
  number: string | null;
  due_date: string;
  balance: number | null;
  days_overdue: number;
}

/** Derived from an already-fetched NextPayment — no extra query. Overdue only when it's a REAL unpaid
 *  invoice (not a "scheduled" projection with nothing actually billed yet) whose due date has passed.
 *  Same day-count formula as the Finance module's receivables-ageing buckets (finance/reports.service.ts). */
export function overdueInfoFrom(payment: NextPayment | null | undefined): OverdueInfo | null {
  if (!payment || payment.scheduled || !payment.due_date || !payment.invoice_id) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (payment.due_date >= today) return null;
  return {
    invoice_id: payment.invoice_id,
    number: payment.number,
    due_date: payment.due_date,
    balance: payment.balance,
    days_overdue: daysBetween(payment.due_date, today),
  };
}

/**
 * A per-seat price inferred from the client's own recurring invoice, for a
 * client that never set one explicitly in Client Management. Finds the most
 * recent invoice for the linked finance customer and reads the rate off
 * whichever line item's quantity matches the current active-user count (the
 * conventional "N users x rate" bundle line) — falling back to the
 * highest-quantity line if nothing matches exactly. Null when there's no
 * linked customer, no invoice, or no line that looks like a per-seat charge.
 */
export async function detectSeatPriceFromInvoice(financeOrgId: string, customerId: string, activeUsers: number): Promise<number | null> {
  if (!financeOrgId || !customerId) return null;
  const { data: doc } = await supabaseAdmin
    .from('finance_documents')
    .select('id')
    .eq('org_id', financeOrgId)
    .eq('doc_type', 'invoice')
    .eq('customer_id', customerId)
    .is('deleted_at', null)
    .order('issue_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const docId = (doc as { id?: string } | null)?.id;
  if (!docId) return null;

  const { data: items } = await supabaseAdmin.from('finance_document_items').select('quantity, rate').eq('document_id', docId);
  const rows = (items ?? []) as Array<{ quantity: number | string; rate: number | string }>;
  if (!rows.length) return null;

  const exact = rows.find((r) => Number(r.quantity) === activeUsers);
  if (exact) return round2(Number(exact.rate));
  const byQty = [...rows].sort((a, b) => Number(b.quantity) - Number(a.quantity))[0];
  return byQty && Number(byQty.quantity) > 1 ? round2(Number(byQty.rate)) : null;
}

/** Convenience wrapper: the detected per-seat price for a client row (see
 *  detectSeatPriceFromInvoice), resolving its finance org/customer/active count. */
export async function detectedSeatPrice(client: { org_id?: string | null; settings?: unknown } | null | undefined): Promise<number | null> {
  if (!client) return null;
  const financeOrgId = String(client.org_id || '');
  const customerId = financeCustomerIdOf(client as { settings?: unknown });
  if (!financeOrgId || !customerId) return null;
  const activeUsers = await countActiveUsers(supabaseAdmin, financeOrgId);
  return detectSeatPriceFromInvoice(financeOrgId, customerId, activeUsers);
}

/**
 * Record a pro-rated charge for a seat added today, for a client that has a
 * per-seat price configured — explicitly (clients.settings.billing
 * .price_per_user) or, failing that, detected from its own recurring invoice
 * (detectedSeatPrice) — so a client whose invoicing already prices per seat
 * needs no manual setup at all. Never throws — a billing hiccup must not
 * block creating or reactivating a user. A no-op when neither source yields
 * a price (nothing changes for a client the operator hasn't opted in and
 * whose invoice has no per-seat line).
 */
export async function queueSeatCharge(clientId: string | null | undefined, userId: string | null, userLabel: string): Promise<void> {
  if (!clientId) return;
  try {
    const { data: client } = await supabaseAdmin.from('clients').select('id, org_id, settings').eq('id', clientId).maybeSingle();
    if (!client) return;

    const financeOrgId = String((client as { org_id?: string }).org_id || '');
    const customerId = financeCustomerIdOf(client as { settings?: unknown });
    const pricePerUser = priceOf(client) ?? await detectedSeatPrice(client as { org_id?: string | null; settings?: unknown });
    if (!pricePerUser) return;

    const addedOn = new Date().toISOString().slice(0, 10);
    const cycle = customerId ? await currentCycleFor(financeOrgId, customerId) : null;

    const daysCharged = cycle ? Math.max(0, Math.min(cycle.cycle_days, daysBetween(addedOn, cycle.cycle_end))) : null;
    const proratedAmount = cycle && cycle.cycle_days > 0
      ? round2(pricePerUser * (daysCharged ?? 0) / cycle.cycle_days)
      : round2(pricePerUser);

    const { error } = await supabaseAdmin.from('client_seat_charges').insert({
      client_id: clientId,
      user_id: userId,
      user_label: userLabel || 'New user',
      added_on: addedOn,
      cycle_start: cycle?.cycle_start ?? null,
      cycle_end: cycle?.cycle_end ?? null,
      cycle_days: cycle?.cycle_days ?? null,
      days_charged: daysCharged,
      price_per_user: pricePerUser,
      prorated_amount: proratedAmount,
      status: 'pending',
    });
    if (error) logger.warn(`[clientBilling] queueSeatCharge insert failed for client ${clientId}: ${error.message}`);
  } catch (e) {
    logger.warn(`[clientBilling] queueSeatCharge failed for client ${clientId}: ${(e as Error).message}`);
  }
}

/** The soonest-due recurring invoice (id + schedule) for a linked finance customer, or null. */
async function recurringInvoiceForCustomer(financeOrgId: string, customerId: string): Promise<
  { id: string; next_invoice_date: string | null; recurrence_interval: string | null; recurrence_custom_every: number | null; recurrence_custom_unit: string | null } | null> {
  if (!financeOrgId || !customerId) return null;
  const { data } = await supabaseAdmin
    .from('finance_documents')
    .select('id, next_invoice_date, recurrence_interval, recurrence_custom_every, recurrence_custom_unit')
    .eq('org_id', financeOrgId).eq('doc_type', 'invoice').eq('customer_id', customerId)
    .eq('recurrence_enabled', true).is('deleted_at', null)
    .not('next_invoice_date', 'is', null).order('next_invoice_date', { ascending: true })
    .limit(1).maybeSingle();
  return (data as never) ?? null;
}

/** How many seats the recurring invoice already bills each cycle — the per-seat line's quantity
 *  (the line whose rate matches the per-seat price, else the highest-quantity "N × rate" line). 0 when
 *  no such line, so every active seat is treated as not-yet-billed. */
async function recurringBaselineSeats(invoiceId: string, pricePerUser: number): Promise<number> {
  const { data: items } = await supabaseAdmin.from('finance_document_items').select('quantity, rate').eq('document_id', invoiceId);
  const rows = (items ?? []) as Array<{ quantity: number | string; rate: number | string }>;
  if (!rows.length) return 0;
  const match = rows.find((r) => round2(Number(r.rate)) === round2(pricePerUser));
  if (match) return Math.max(0, Math.floor(Number(match.quantity)));
  const byQty = [...rows].sort((a, b) => Number(b.quantity) - Number(a.quantity))[0];
  return byQty && Number(byQty.quantity) > 1 ? Math.max(0, Math.floor(Number(byQty.quantity))) : 0;
}

export interface BillCurrentSeatsResult {
  queued: number;
  active_seats: number;
  baseline_seats: number;
  already_pending: number;
  prorated_each: number;
  total: number;
  days_charged: number;
  cycle_days: number;
  cycle_end: string;
}

/**
 * Catch up billing for seats that are active now but not yet charged — the seats beyond what the
 * client's recurring invoice already bills (active − baseline − already-pending). Each is queued as a
 * pro-rated seat charge for the days left in the current cycle, then applied to an invoice from the
 * Account & Billing panel like any auto-queued charge. Requires a per-seat price AND a recurring
 * invoice (which defines both the cycle to pro-rate against and the baseline already billed), so it
 * never double-bills seats the recurring invoice already covers. Idempotent: re-running only tops up
 * the difference, because already-pending charges are subtracted.
 */
export async function billCurrentSeats(clientId: string): Promise<BillCurrentSeatsResult> {
  const { data: client } = await supabaseAdmin.from('clients').select('id, org_id, settings').eq('id', clientId).maybeSingle();
  if (!client) throw new Error('Client not found');
  const financeOrgId = String((client as { org_id?: string }).org_id || '');
  const customerId = financeCustomerIdOf(client as { settings?: unknown });
  const price = priceOf(client) ?? await detectedSeatPrice(client as { org_id?: string | null; settings?: unknown });
  if (!price) throw new Error('Set a price per seat first, then try again.');
  if (!customerId) throw new Error('Link this client to a finance customer first.');

  const inv = await recurringInvoiceForCustomer(financeOrgId, customerId);
  if (!inv?.next_invoice_date) throw new Error('Set up a recurring invoice for this client first — the billing cycle is needed to pro-rate.');
  const spec = specFromRow(inv);
  if (!spec) throw new Error('The recurring invoice has no valid repeat schedule, so the billing cycle cannot be worked out.');
  const cycle_end = inv.next_invoice_date;
  const cycle_start = cycleStartBefore(cycle_end, spec);
  const cycle_days = daysBetween(cycle_start, cycle_end);
  if (cycle_days <= 0) throw new Error('The billing cycle length could not be determined from the recurring invoice.');

  const baselineSeats = await recurringBaselineSeats(inv.id, price);
  const activeSeats = await countActiveUsers(supabaseAdmin, financeOrgId);
  const alreadyPending = (await listPendingSeatCharges(clientId)).length;
  const toBill = Math.max(0, activeSeats - baselineSeats - alreadyPending);

  const addedOn = new Date().toISOString().slice(0, 10);
  const daysCharged = Math.max(0, Math.min(cycle_days, daysBetween(addedOn, cycle_end)));
  const proratedEach = round2(price * daysCharged / cycle_days);

  if (toBill > 0) {
    const rows = Array.from({ length: toBill }, () => ({
      client_id: clientId, user_id: null, user_label: 'Current seat',
      added_on: addedOn, cycle_start, cycle_end, cycle_days,
      days_charged: daysCharged, price_per_user: price, prorated_amount: proratedEach, status: 'pending',
    }));
    const { error } = await supabaseAdmin.from('client_seat_charges').insert(rows);
    if (error) throw new Error(error.message);
  }

  return {
    queued: toBill, active_seats: activeSeats, baseline_seats: baselineSeats, already_pending: alreadyPending,
    prorated_each: proratedEach, total: round2(proratedEach * toBill), days_charged: daysCharged, cycle_days, cycle_end,
  };
}

/** Pending (not yet invoiced) seat charges for a client, oldest first. */
export async function listPendingSeatCharges(clientId: string): Promise<SeatCharge[]> {
  const { data, error } = await supabaseAdmin
    .from('client_seat_charges')
    .select('*')
    .eq('client_id', clientId)
    .eq('status', 'pending')
    .order('added_on', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SeatCharge[];
}

/** Set (or clear) the per-seat price a client is billed. Merges into clients.settings.billing. */
export async function setSeatPrice(clientId: string, pricePerUser: number | null): Promise<void> {
  const { data: client, error: readErr } = await supabaseAdmin.from('clients').select('settings').eq('id', clientId).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!client) throw new Error('Client not found');
  const curSettings = (client as { settings?: Record<string, unknown> }).settings || {};
  const curBilling = (curSettings.billing as Record<string, unknown>) || {};
  const settings = { ...curSettings, billing: { ...curBilling, price_per_user: pricePerUser } };
  const { error } = await supabaseAdmin.from('clients').update({ settings }).eq('id', clientId);
  if (error) throw new Error(error.message);
}

export interface ApplySeatChargesResult {
  applied: number;
  total: number;
  invoice_id: string;
}

/**
 * Add every pending seat charge for a client as a line item on the given
 * invoice, then mark them invoiced. Preserves the invoice's own recurrence
 * schedule (updateDocument re-derives it from whatever is passed in, so the
 * current values are carried through explicitly rather than left to default
 * to "off").
 */
export async function applySeatChargesToInvoice(scope: FinanceScope, clientId: string, documentId: string): Promise<ApplySeatChargesResult> {
  const charges = await listPendingSeatCharges(clientId);
  if (charges.length === 0) throw new Error('No pending seat charges for this client');

  const doc = await docs.getDocument(scope, documentId, 'invoice');
  const base = docs.inputFromDocument(doc);
  const d = doc as unknown as {
    recurrence_enabled?: boolean; recurrence_interval?: string | null;
    recurrence_custom_every?: number | null; recurrence_custom_unit?: string | null;
    recurrence_start?: string | null; recurrence_reminder_email?: boolean;
  };
  const extraItems = charges.map((c) => ({
    name: `Pro-rated seat — ${c.user_label}`,
    description: c.cycle_days
      ? `Added ${c.added_on} · ${c.days_charged} of ${c.cycle_days} days in the cycle`
      : `Added ${c.added_on} · full price (no billing cycle found at the time)`,
    quantity: 1,
    rate: c.prorated_amount,
  }));

  await docs.updateDocument(scope, 'invoice', documentId, {
    ...base,
    items: [...base.items, ...extraItems],
    recurrence_enabled: d.recurrence_enabled,
    recurrence_interval: d.recurrence_interval,
    recurrence_custom_every: d.recurrence_custom_every,
    recurrence_custom_unit: d.recurrence_custom_unit,
    recurrence_start: d.recurrence_start,
    recurrence_reminder_email: d.recurrence_reminder_email,
  });

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('client_seat_charges')
    .update({ status: 'invoiced', invoice_document_id: documentId, applied_at: now })
    .in('id', charges.map((c) => c.id));
  if (error) logger.warn(`[clientBilling] marking seat charges invoiced failed: ${error.message}`);

  return {
    applied: charges.length,
    total: round2(charges.reduce((sum, c) => sum + c.prorated_amount, 0)),
    invoice_id: documentId,
  };
}

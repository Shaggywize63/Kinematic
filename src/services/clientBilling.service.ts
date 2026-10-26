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

// Internal/staff domains never count toward a seat cap (see assertActiveUserCap
// in misc.controller). Kept in sync here so the displayed "active" equals the
// number the cap is measured against.
const STAFF_DOMAINS = new Set([
  'kinematicapp.com', 'horizontechstudio.com', 'kinematic.com', 'kaiyotechnologylabs.com',
]);
const domainOf = (email?: string | null): string => String(email || '').split('@')[1]?.toLowerCase().trim() || '';

export interface NextPayment {
  invoice_id: string;
  number: string;
  due_date: string | null;
  total: number;
  balance: number;
  status: string;
  share_token: string | null;
}

/** The finance customer this client is billed as, if linked. */
export function financeCustomerIdOf(client: { settings?: unknown } | null | undefined): string | null {
  const s = (client as { settings?: { billing?: { finance_customer_id?: unknown } } } | null)?.settings;
  const id = s?.billing?.finance_customer_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
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
  };
}

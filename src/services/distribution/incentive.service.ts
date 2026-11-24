/**
 * Incentive accrual for sales orders.
 *
 * A client configures ONE active rule (rate, basis, earning status) in `incentive_rules`.
 * Nothing is hard-coded: a client with no active rule accrues nothing, so turning the module
 * on for a tenant means creating its rule — no per-client branch anywhere in this file.
 *
 * `incentive_entries` has a UNIQUE index on order_id, so accrual is idempotent: a repeated
 * approve, a retried request or a double-fired hook can never pay the same order twice.
 *
 * Earning on `approved` (the common choice) means an order can still be cancelled afterwards,
 * so cancellation REVERSES the entry rather than deleting it — the history stays auditable and
 * the dashboard can show what was clawed back.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

export type IncentiveBasis = 'taxable_value' | 'grand_total';
export type EarnOn = 'placed' | 'approved' | 'invoiced';

export interface IncentiveRule {
  id: string;
  org_id: string;
  client_id: string | null;
  name: string;
  rate_pct: number;
  basis: IncentiveBasis;
  earn_on: EarnOn;
  is_active: boolean;
}

/** A PostgREST error that just means "this database has not had migration_incentives.sql applied". */
export function isMissingIncentiveSchema(e: { code?: string; message?: string } | null | undefined): boolean {
  const msg = String(e?.message ?? '').toLowerCase();
  return e?.code === '42P01' || msg.includes('incentive_rules') || msg.includes('incentive_entries');
}

/** The one active rule for this scope, or null. A client's own rule beats an org-wide one. */
export async function activeRule(orgId: string, clientId: string | null): Promise<IncentiveRule | null> {
  try {
    let q = supabaseAdmin.from('incentive_rules').select('*').eq('org_id', orgId).eq('is_active', true);
    q = clientId ? q.or(`client_id.is.null,client_id.eq.${clientId}`) : q.is('client_id', null);
    const { data, error } = await q;
    if (error) return null;
    const rows = (data ?? []) as IncentiveRule[];
    if (!rows.length) return null;
    // Prefer the client-specific rule over the org-wide fallback.
    return rows.sort((a, b) => Number(!!b.client_id) - Number(!!a.client_id))[0];
  } catch {
    return null;
  }
}

/** Round to paise; never return a negative incentive. */
function money(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

export interface OrderLike {
  id: string;
  org_id: string;
  client_id?: string | null;
  salesman_id?: string | null;
  status?: string | null;
  taxable_value?: number | string | null;
  grand_total?: number | string | null;
}

/** The figure the rule is a percentage OF. */
export function basisAmount(order: OrderLike, basis: IncentiveBasis): number {
  const raw = basis === 'grand_total' ? order.grand_total : order.taxable_value;
  const n = typeof raw === 'string' ? Number(raw) : (raw ?? 0);
  return Number.isFinite(n) ? Number(n) : 0;
}

export interface AccrualResult {
  accrued: boolean;
  reason?: 'no_rule' | 'wrong_status' | 'no_salesman' | 'zero_value' | 'already_exists' | 'error';
  amount?: number;
}

/**
 * Accrue the incentive for one order. Safe to call more than once and on any status — it
 * checks the rule itself, so callers do not need to know the configuration.
 */
export async function accrueForOrder(order: OrderLike): Promise<AccrualResult> {
  if (!order?.id || !order.org_id) return { accrued: false, reason: 'error' };
  if (!order.salesman_id) return { accrued: false, reason: 'no_salesman' };

  const rule = await activeRule(order.org_id, order.client_id ?? null);
  if (!rule) return { accrued: false, reason: 'no_rule' };
  if ((order.status ?? '') !== rule.earn_on) return { accrued: false, reason: 'wrong_status' };

  const base = basisAmount(order, rule.basis);
  const amount = money((base * Number(rule.rate_pct)) / 100);
  if (amount <= 0) return { accrued: false, reason: 'zero_value' };

  const { error } = await supabaseAdmin.from('incentive_entries').insert({
    org_id: order.org_id,
    client_id: order.client_id ?? null,
    order_id: order.id,
    salesman_id: order.salesman_id,
    rule_id: rule.id,
    basis: rule.basis,
    basis_amount: base,
    rate_pct: Number(rule.rate_pct),
    amount,
    status: 'earned',
    earned_at: new Date().toISOString(),
  });

  if (error) {
    // 23505 = the UNIQUE(order_id) guard firing: this order already earned. Not an error.
    if (error.code === '23505') return { accrued: false, reason: 'already_exists' };
    if (isMissingIncentiveSchema(error)) return { accrued: false, reason: 'error' };
    logger.warn(`[incentives] accrual failed for order ${order.id}: ${error.message}`);
    return { accrued: false, reason: 'error' };
  }
  return { accrued: true, amount };
}

/**
 * Reverse an order's incentive — used when an order is cancelled after it had already earned.
 * Leaves the row in place with status 'reversed' so the clawback is visible, and never touches
 * an entry that was already paid out (that needs a human decision, not an automatic rewrite).
 */
export async function reverseForOrder(orderId: string, reason: string): Promise<boolean> {
  if (!orderId) return false;
  try {
    const { data, error } = await supabaseAdmin.from('incentive_entries')
      .update({
        status: 'reversed',
        reversed_at: new Date().toISOString(),
        reversal_reason: reason?.slice(0, 300) || 'Order cancelled',
      })
      .eq('order_id', orderId).eq('status', 'earned').select('id');
    if (error) {
      if (!isMissingIncentiveSchema(error)) {
        logger.warn(`[incentives] reversal failed for order ${orderId}: ${error.message}`);
      }
      return false;
    }
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/** Fire-and-forget wrappers: an incentive problem must never fail the order action itself. */
export function accrueInBackground(order: OrderLike): void {
  accrueForOrder(order).catch((e) => logger.warn(`[incentives] accrual threw: ${(e as Error).message}`));
}
export function reverseInBackground(orderId: string, reason: string): void {
  reverseForOrder(orderId, reason).catch((e) => logger.warn(`[incentives] reversal threw: ${(e as Error).message}`));
}

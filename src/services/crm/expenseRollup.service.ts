/**
 * What did it cost to win this lead / deal? Rolls the expense claims linked to a CRM lead or deal
 * (expense_claims.lead_id / deal_id, migration_expense_lead_deal_links.sql) into one block the lead and
 * deal pages show: total spend, visits made, and spend as a percentage of the opportunity value
 * (3,000 spent on a 10,000 deal = 30%).
 *
 * Claim status → bucket (expense_claims.status is draft | submitted | approved | rejected | reimbursed | cancelled):
 *
 *   spent_amount     submitted + approved + reimbursed   money committed: past draft, not rejected, not cancelled
 *   pending_amount   submitted                           the part of spent_amount still awaiting approval
 *   draft_amount     draft                               not filed yet
 *   rejected_amount  rejected                            refused — kept out of spent_amount
 *   (cancelled)      ignored everywhere                  not counted, not listed
 *
 * An approved / reimbursed claim counts for what was approved (approved_amount, which is lower than the
 * claimed total after a partial approval); every other claim counts for its total_amount.
 * claim_count is every claim that is not cancelled. expense_claims has no soft-delete column — a claim is
 * cancelled, not deleted.
 *
 * Privacy: the numbers (totals, visits, percentage) are shown to anyone who can see the lead / deal; the
 * per-claim `claims` list is returned in full only to expense approvers / admins (access.isApprover) and
 * otherwise holds just the caller's own claims — so a rep cannot read a colleague's claim titles or amounts.
 *
 * Resilience: a tenant database without the lead_id / deal_id columns answers zeros and an empty list
 * (never a 500); a failing visit count is 0.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { Actor, isApprover } from '../expenses/access';
import { isUndefinedColumn } from '../expenses/dbErrors';
import { stampNames, stampLeadDeal } from '../expenses/expenses.service';
import { restoreCarrierType } from './activityTypeFallback';
import { activityBucket, UUID_RE } from './analytics-plus.helpers';

export interface ExpenseRollupTotals {
  claim_count: number;
  spent_amount: number;
  pending_amount: number;
  draft_amount: number;
  rejected_amount: number;
}

export interface ExpenseRollupClaim {
  id: string;
  claim_no: string | null;
  title: string | null;
  status: string;
  total_amount: number;
  currency: string;
  created_at: string | null;
  user_id: string;
  user_name: string | null;
  lead_id: string | null;
  deal_id: string | null;
  deal_name: string | null;
}

export interface ExpenseRollup {
  currency: string;
  totals: ExpenseRollupTotals;
  visit_count: number;
  opportunity_value: number | null;
  spent_pct_of_value: number | null;
  claims: ExpenseRollupClaim[];
}

/** The caller as the roll-up needs them: the expense Actor, whose client_id is the request's client scope. */
export type RollupActor = Actor;

const CLAIM_CAP = 5000;
const ACTIVITY_CAP = 5000;
const SPENT = ['submitted', 'approved', 'reimbursed'];

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** What a claim is worth for the totals: the approved amount once approved, else what was claimed. */
function countedAmount(c: any): number {
  if ((c.status === 'approved' || c.status === 'reimbursed') && c.approved_amount != null) return num(c.approved_amount);
  return num(c.total_amount);
}

/** Bucket the (non-cancelled) claims. Pure, so the arithmetic is unit-testable. */
export function totalsOf(claims: any[]): ExpenseRollupTotals {
  const live = claims.filter((c) => c.status !== 'cancelled');
  const sum = (pred: (c: any) => boolean) => round2(live.filter(pred).reduce((s, c) => s + countedAmount(c), 0));
  return {
    claim_count: live.length,
    spent_amount: sum((c) => SPENT.includes(c.status)),
    pending_amount: sum((c) => c.status === 'submitted'),
    draft_amount: sum((c) => c.status === 'draft'),
    rejected_amount: sum((c) => c.status === 'rejected'),
  };
}

/** spent / value as a percentage with one decimal; null when there is no value to compare against. */
export function spentPct(spent: number, value: number | null): number | null {
  return value != null && value > 0 ? round1((spent / value) * 100) : null;
}

/** The request's client scope must match the record's client; a record with no client is visible (as in GET-by-id). */
function assertClientVisible(row: { client_id?: string | null }, clientId: string | null | undefined, what: string): void {
  if (clientId && row.client_id && row.client_id.toLowerCase() !== clientId.toLowerCase()) throw new AppError(404, `${what} not found`, 'NOT_FOUND');
}

function assertUuidParam(id: string, what: string): void {
  if (!UUID_RE.test(String(id ?? ''))) throw new AppError(404, `${what} not found`, 'NOT_FOUND');
}

/** The claims linked to a lead (`lead_id`) or a deal (`deal_id`), in the actor's org and client scope, newest first. */
async function loadClaims(actor: Actor, column: 'lead_id' | 'deal_id', id: string): Promise<any[]> {
  let q = supabaseAdmin.from('expense_claims').select('*').eq('org_id', actor.org_id).eq(column, id)
    .neq('status', 'cancelled').order('created_at', { ascending: false }).limit(CLAIM_CAP);
  if (actor.client_id) q = q.eq('client_id', actor.client_id);
  const { data, error } = await q;
  if (error) {
    if (isUndefinedColumn(error)) {
      logger.warn(`[expenseRollup] expense_claims has no ${column} column (${error.message}); answering zeros — apply migration_expense_lead_deal_links.sql`);
      return [];
    }
    throw new AppError(500, error.message, 'DB');
  }
  return ((data as any[]) ?? []).filter((c) => c.status !== 'cancelled');
}

/** Completed site visits / meetings on the lead, or on the deal plus its lead. 0 if the lookup fails. */
async function countVisits(org_id: string, leadId: string | null, dealId: string | null): Promise<number> {
  try {
    let q = supabaseAdmin.from('crm_activities').select('type, metadata').eq('org_id', org_id)
      .is('deleted_at', null).in('status', ['completed', 'done']).limit(ACTIVITY_CAP);
    if (dealId && leadId) q = q.or(`deal_id.eq.${dealId},lead_id.eq.${leadId}`);
    else if (dealId) q = q.eq('deal_id', dealId);
    else if (leadId) q = q.eq('lead_id', leadId);
    else return 0;
    const { data, error } = await q;
    if (error) { logger.warn(`[expenseRollup] visit count failed: ${error.message}`); return 0; }
    // A custom type saved under a carrier type (activityTypeFallback) reads back as its real type first.
    return ((data as any[]) ?? []).map((r) => activityBucket(String(restoreCarrierType(r).type ?? '')))
      .filter((b) => b === 'site_visit' || b === 'meeting').length;
  } catch (e: any) {
    logger.warn(`[expenseRollup] visit count failed: ${e?.message || e}`);
    return 0;
  }
}

async function shape(
  actor: Actor, claims: any[], visit_count: number, opportunity_value: number | null, currency: string | null,
): Promise<ExpenseRollup> {
  const totals = totalsOf(claims);
  // Everyone sees the numbers; the claim rows themselves only an approver / admin, or the claimant for their own.
  const visible = isApprover(actor) ? claims : claims.filter((c) => c.user_id === actor.id);
  const rows = await stampLeadDeal(await stampNames(visible.map((c) => ({ ...c }))));
  return {
    currency: currency || claims[0]?.currency || 'INR',
    totals,
    visit_count,
    opportunity_value,
    spent_pct_of_value: spentPct(totals.spent_amount, opportunity_value),
    claims: rows.map((c) => ({
      id: c.id, claim_no: c.claim_no ?? null, title: c.title ?? null, status: c.status, total_amount: num(c.total_amount),
      currency: c.currency || 'INR', created_at: c.created_at ?? null, user_id: c.user_id, user_name: c.user_name ?? null,
      lead_id: c.lead_id ?? null, deal_id: c.deal_id ?? null, deal_name: c.deal_name ?? null,
    })),
  };
}

/** GET /crm/leads/:id/expenses — everything spent on this lead (its deals' claims carry the lead id too). */
export async function leadExpenseRollup(actor: Actor, leadId: string): Promise<ExpenseRollup> {
  assertUuidParam(leadId, 'Lead');
  const { data: lead } = await supabaseAdmin.from('crm_leads').select('id, client_id')
    .eq('org_id', actor.org_id).eq('id', leadId).is('deleted_at', null).maybeSingle();
  if (!lead) throw new AppError(404, 'Lead not found', 'NOT_FOUND');
  assertClientVisible(lead as any, actor.client_id, 'Lead');

  const [claims, visits, deals] = await Promise.all([
    loadClaims(actor, 'lead_id', leadId),
    countVisits(actor.org_id, leadId, null),
    supabaseAdmin.from('crm_deals').select('amount, currency').eq('org_id', actor.org_id).eq('lead_id', leadId).is('deleted_at', null),
  ]);
  const dealRows = ((deals.data as any[]) ?? []);
  const value = round2(dealRows.reduce((s, d) => s + num(d.amount), 0));
  return shape(actor, claims, visits, value > 0 ? value : null, dealRows.find((d) => d.currency)?.currency ?? null);
}

/** GET /crm/deals/:id/expenses — everything spent on this deal; visits are the deal's plus its lead's. */
export async function dealExpenseRollup(actor: Actor, dealId: string): Promise<ExpenseRollup> {
  assertUuidParam(dealId, 'Deal');
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('id, client_id, lead_id, amount, currency')
    .eq('org_id', actor.org_id).eq('id', dealId).is('deleted_at', null).maybeSingle();
  if (!deal) throw new AppError(404, 'Deal not found', 'NOT_FOUND');
  const d = deal as any;
  assertClientVisible(d, actor.client_id, 'Deal');

  const leadId = d.lead_id && UUID_RE.test(String(d.lead_id)) ? String(d.lead_id) : null;
  const [claims, visits] = await Promise.all([
    loadClaims(actor, 'deal_id', dealId),
    countVisits(actor.org_id, leadId, dealId),
  ]);
  const amount = num(d.amount);
  return shape(actor, claims, visits, amount > 0 ? round2(amount) : null, d.currency ?? null);
}

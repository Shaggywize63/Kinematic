/**
 * Odometer history: the vehicle / odometer lines a person has recorded, newest first, so the apps
 * can pre-fill "before" with the last "after" and an admin can audit readings.
 *
 * One query over expense_claim_items joined to its claim (PostgREST embed over
 * fk_expense_item_claim) so the filters on the claim — whose it is, which client, not cancelled —
 * apply BEFORE the limit. Photos are returned as short-lived signed links (signReceipt), the same
 * way a claim's own detail view does.
 *
 * Visibility: your own lines by default. Another person's, or everybody's, only for an approver
 * (access.isApprover), and then only inside the approver's org AND client.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { Actor, isApprover } from './access';
import { hasOdometerColumns } from './vehicleAllowance';
import { resolvePoliciesForUsers } from './policy.service';
import { signReceipt } from './receipts.service';

export const ODOMETER_HISTORY_DEFAULT_LIMIT = 50;
export const ODOMETER_HISTORY_MAX_LIMIT = 200;
const SIGN_CONCURRENCY = 10;

export interface OdometerHistoryQuery {
  limit?: number;
  from?: string;      // YYYY-MM-DD, on the line's date
  to?: string;
  user_id?: string;   // approvers only (or yourself)
  all?: boolean;      // approvers only: everybody in the org / client
}

export interface OdometerHistoryRow {
  id: string;
  claim_id: string;
  claim_no: string | null;
  claim_status: string | null;
  user_id: string;
  user_name: string | null;
  item_date: string | null;
  vehicle_type: string | null;
  vehicle_label: string | null;
  odometer_start: number | null;
  odometer_end: number | null;
  distance_km: number | null;
  amount: number;
  start_photo_url: string | null;
  end_photo_url: string | null;
  created_at: string | null;
}

const COLUMNS = 'id, claim_id, item_date, vehicle_type, odometer_start, odometer_end, distance_km, amount, '
  + 'odometer_start_photo_url, odometer_end_photo_url, created_at, '
  + 'claim:expense_claims!inner(claim_no, status, user_id, client_id, org_id)';

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Run `fn` over `items` with at most `n` in flight, keeping the order. */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export async function odometerHistory(actor: Actor, q: OdometerHistoryQuery = {}): Promise<OdometerHistoryRow[]> {
  const others = !!q.all || (!!q.user_id && q.user_id !== actor.id);
  if (others && !isApprover(actor)) {
    throw new AppError(403, "Only an approver can view other people's odometer history", 'FORBIDDEN');
  }
  if (q.from && q.to && q.from > q.to) throw new AppError(400, 'The end date is before the start date', 'VALIDATION');
  const limit = Math.min(ODOMETER_HISTORY_MAX_LIMIT, Math.max(1, Math.round(Number(q.limit) || ODOMETER_HISTORY_DEFAULT_LIMIT)));

  // Databases that never ran migrations/expense_odometer.sql have no odometer columns — and no history.
  if (!(await hasOdometerColumns())) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabaseAdmin.from('expense_claim_items').select(COLUMNS)
    .eq('org_id', actor.org_id)
    .eq('claim.org_id', actor.org_id)
    .or('odometer_start.not.is.null,odometer_end.not.is.null')
    .neq('claim.status', 'cancelled');
  if (others) {
    // Inside the approver's own client — never across tenants that share an org.
    if (actor.client_id) query = query.eq('claim.client_id', actor.client_id);
    if (q.user_id) query = query.eq('claim.user_id', q.user_id);
  } else {
    query = query.eq('claim.user_id', actor.id);
  }
  if (q.from) query = query.gte('item_date', q.from);
  if (q.to) query = query.lte('item_date', q.to);
  const { data, error } = await query
    .order('item_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new AppError(500, error.message, 'DB');

  const lines = ((data as any[]) ?? [])
    .map((r) => ({ ...r, claim: Array.isArray(r.claim) ? r.claim[0] : r.claim }))
    .filter((r) => r.claim && r.claim.user_id);
  if (!lines.length) return [];

  // Who they are, and what their vehicles are called (the policy that governs each person).
  const userIds = Array.from(new Set(lines.map((r) => r.claim.user_id as string)));
  const names = new Map<string, string>();
  const { data: us } = await supabaseAdmin.from('users').select('id, name').in('id', userIds);
  for (const u of (us as any[]) ?? []) names.set(u.id, u.name);

  const labels = new Map<string, Map<string, string>>(); // user -> vehicle id -> label
  try {
    const policies = await resolvePoliciesForUsers(actor.org_id, actor.client_id ?? null, userIds);
    for (const [uid, p] of policies) labels.set(uid, new Map((p.rules.vehicle_rates ?? []).map((v) => [v.id, v.label])));
  } catch (e: any) {
    logger.warn(`[expenses] odometer history: vehicle labels unavailable: ${e?.message || e}`);
  }

  return mapLimit(lines, SIGN_CONCURRENCY, async (r): Promise<OdometerHistoryRow> => {
    const [start, end] = await Promise.all([
      signReceipt(actor.org_id, r.odometer_start_photo_url),
      signReceipt(actor.org_id, r.odometer_end_photo_url),
    ]);
    const vehicle = (r.vehicle_type as string | null) ?? null;
    return {
      id: r.id,
      claim_id: r.claim_id,
      claim_no: r.claim.claim_no ?? null,
      claim_status: r.claim.status ?? null,
      user_id: r.claim.user_id,
      user_name: names.get(r.claim.user_id) ?? null,
      item_date: r.item_date ?? null,
      vehicle_type: vehicle,
      vehicle_label: vehicle ? (labels.get(r.claim.user_id)?.get(vehicle) ?? vehicle) : null,
      odometer_start: numOrNull(r.odometer_start),
      odometer_end: numOrNull(r.odometer_end),
      distance_km: numOrNull(r.distance_km),
      amount: Number(r.amount || 0),
      start_photo_url: start,
      end_photo_url: end,
      created_at: r.created_at ?? null,
    };
  });
}

/**
 * Manager / admin views over expense claims: a filterable, paginated list of
 * every claim they may see, a summary for the dashboard, and a CSV export.
 *
 * List and CSV share one filter builder, so an export always matches what the
 * list showed.
 *
 * Visibility: an admin sees every claim in their org (their client, when they
 * are a client admin). Any other approver sees claims routed to them — as the
 * current approver or anywhere in the approval trail.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { Actor, isApprover } from './access';
import { stampNames } from './expenses.service';

export interface ClaimFilters {
  status?: string;        // comma separated
  user_id?: string;
  from?: string;          // YYYY-MM-DD, on submitted_at
  to?: string;
  category?: string;
  policy_id?: string;
  q?: string;
  city?: string;
  page?: number;
  limit?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HIDDEN_BY_DEFAULT = ['draft', 'cancelled'];
const EXPORT_CAP = 5000;

async function chunked<T>(ids: string[], size: number, fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

/** Claim ids the actor may see, or null when that is "everything in scope". */
async function visibleClaimIds(actor: Actor): Promise<string[] | null> {
  if (isApprover(actor)) return null;
  const { data } = await supabaseAdmin.from('expense_approvals').select('claim_id').eq('org_id', actor.org_id).eq('approver_id', actor.id).limit(2000);
  return Array.from(new Set(((data as any[]) ?? []).map((r) => r.claim_id)));
}

/** Build the filtered query. Returns null when the filters can match nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildQuery(actor: Actor, f: ClaimFilters, columns: string, count: boolean): Promise<any | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabaseAdmin.from('expense_claims').select(columns, count ? { count: 'exact' } : undefined).eq('org_id', actor.org_id);
  if (actor.client_id) q = q.eq('client_id', actor.client_id);

  const mine = await visibleClaimIds(actor);
  if (mine) q = mine.length ? q.or(`approver_id.eq.${actor.id},id.in.(${mine.join(',')})`) : q.eq('approver_id', actor.id);

  const statuses = (f.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  q = statuses.length ? q.in('status', statuses) : q.not('status', 'in', `(${HIDDEN_BY_DEFAULT.join(',')})`);

  if (f.user_id) { if (!UUID_RE.test(f.user_id)) throw new AppError(400, 'Invalid user', 'VALIDATION'); q = q.eq('user_id', f.user_id); }
  if (f.policy_id) { if (!UUID_RE.test(f.policy_id)) throw new AppError(400, 'Invalid policy', 'VALIDATION'); q = q.eq('policy_id', f.policy_id); }
  if (f.from) { if (!DATE_RE.test(f.from)) throw new AppError(400, 'Invalid from date', 'VALIDATION'); q = q.gte('submitted_at', `${f.from}T00:00:00.000Z`); }
  if (f.to) { if (!DATE_RE.test(f.to)) throw new AppError(400, 'Invalid to date', 'VALIDATION'); q = q.lte('submitted_at', `${f.to}T23:59:59.999Z`); }

  if (f.category) {
    const { data } = await supabaseAdmin.from('expense_claim_items').select('claim_id').eq('org_id', actor.org_id).eq('category', f.category).limit(EXPORT_CAP);
    const ids = Array.from(new Set(((data as any[]) ?? []).map((r) => r.claim_id)));
    if (!ids.length) return null;
    q = q.in('id', ids);
  }

  const term = (f.q ?? '').replace(/[^\w\s@.\-]/g, '').trim();
  if (term) {
    const { data: us } = await supabaseAdmin.from('users').select('id').eq('org_id', actor.org_id).ilike('name', `%${term}%`).limit(50);
    const uids = ((us as any[]) ?? []).map((u) => u.id);
    q = q.or([`claim_no.ilike.%${term}%`, `title.ilike.%${term}%`, ...(uids.length ? [`user_id.in.(${uids.join(',')})`] : [])].join(','));
  }
  return q;
}

async function applyCity(rows: any[], city?: string) {
  if (!city || !rows.length) return rows;
  const ids = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
  const { data: us } = await supabaseAdmin.from('users').select('id, city').in('id', ids);
  const cityOf = new Map((us ?? []).map((u: any) => [u.id, (u.city || '').toLowerCase()]));
  return rows.filter((r) => cityOf.get(r.user_id) === city.toLowerCase());
}

export async function listAllClaims(actor: Actor, f: ClaimFilters) {
  const limit = Math.min(100, Math.max(1, Math.round(Number(f.limit) || 25)));
  const page = Math.max(1, Math.round(Number(f.page) || 1));
  const q = await buildQuery(actor, f, '*', true);
  if (!q) return { rows: [], total: 0, page, limit };
  const { data, error, count } = await q.order('submitted_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  if (error) throw new AppError(500, error.message, 'DB');
  const rows = await applyCity((data as any[]) ?? [], f.city);
  return { rows: await stampNames(rows), total: f.city ? rows.length : (count ?? rows.length), page, limit };
}

async function fetchForReport(actor: Actor, f: ClaimFilters) {
  const q = await buildQuery(actor, f, '*', false);
  if (!q) return [];
  const { data, error } = await q.order('submitted_at', { ascending: false, nullsFirst: false }).limit(EXPORT_CAP);
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(await applyCity((data as any[]) ?? [], f.city));
}

async function itemsFor(claimIds: string[]) {
  return chunked(claimIds, 200, async (part) => {
    const { data } = await supabaseAdmin.from('expense_claim_items').select('*').in('claim_id', part);
    return (data as any[]) ?? [];
  });
}

const amountOf = (c: any) => (c.approved_amount != null ? Number(c.approved_amount) : Number(c.total_amount || 0));

export async function claimsSummary(actor: Actor, f: ClaimFilters) {
  // A summary is about money in play — drafts and cancelled claims never count.
  const claims = await fetchForReport(actor, { ...f, status: f.status || 'submitted,approved,rejected,reimbursed' });
  const by = <K extends string>(rows: any[], key: (r: any) => K, val: (r: any) => number) => {
    const m = new Map<K, { amount: number; claims: number }>();
    for (const r of rows) { const k = key(r); const a = m.get(k) || { amount: 0, claims: 0 }; a.amount += val(r); a.claims += 1; m.set(k, a); }
    return m;
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const status = Array.from(by(claims, (c) => c.status, (c) => Number(c.total_amount || 0)).entries())
    .map(([s, v]) => ({ status: s, claims: v.claims, amount: r2(v.amount) }));

  const money = claims.filter((c) => c.status !== 'rejected');
  const months = Array.from(by(money, (c) => String(c.submitted_at || c.created_at).slice(0, 7), amountOf).entries())
    .map(([month, v]) => ({ month, amount: r2(v.amount), claims: v.claims })).sort((a, b) => a.month.localeCompare(b.month));
  const people = Array.from(by(money, (c) => c.user_id, amountOf).entries())
    .map(([user_id, v]) => ({ user_id, name: claims.find((c) => c.user_id === user_id)?.user_name ?? null, amount: r2(v.amount), claims: v.claims }))
    .sort((a, b) => b.amount - a.amount).slice(0, 10);
  const policies = Array.from(by(money, (c) => c.policy_name || 'No policy', amountOf).entries())
    .map(([policy, v]) => ({ policy, amount: r2(v.amount), claims: v.claims })).sort((a, b) => b.amount - a.amount);

  // Category split is over lines, so a partial approval counts only what was paid.
  const items = await itemsFor(money.map((c) => c.id));
  const cat = new Map<string, number>();
  for (const it of items) if (it.decision !== 'rejected') cat.set(it.category, (cat.get(it.category) ?? 0) + Number(it.amount || 0));
  const categories = Array.from(cat.entries()).map(([category, amount]) => ({ category, amount: r2(amount) })).sort((a, b) => b.amount - a.amount);

  const decided = claims.filter((c) => c.reviewed_at && c.submitted_at && !c.auto_approved);
  const avgHours = decided.length
    ? r2(decided.reduce((s, c) => s + (Date.parse(c.reviewed_at) - Date.parse(c.submitted_at)) / 3_600_000, 0) / decided.length) : null;
  const sum = (rows: any[], val: (r: any) => number) => r2(rows.reduce((s, r) => s + val(r), 0));
  const of = (st: string) => claims.filter((c) => c.status === st);

  return {
    totals: {
      claims: claims.length,
      claimed: sum(claims, (c) => Number(c.total_amount || 0)),
      pending_count: of('submitted').length, pending_amount: sum(of('submitted'), (c) => Number(c.total_amount || 0)),
      approved_count: of('approved').length, approved_amount: sum(of('approved'), amountOf),
      reimbursed_count: of('reimbursed').length, reimbursed_amount: sum(of('reimbursed'), amountOf),
      rejected_count: of('rejected').length, rejected_amount: sum(of('rejected'), (c) => Number(c.total_amount || 0)),
      auto_approved_count: claims.filter((c) => c.auto_approved).length,
      avg_turnaround_hours: avgHours,
    },
    by_status: status, by_month: months, by_category: categories, top_people: people, by_policy: policies,
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────
export function cell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // A cell starting with = + - @ would run as a formula in Excel / Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per expense line, so finance can pivot freely. */
export async function claimsCsv(actor: Actor, f: ClaimFilters): Promise<string> {
  const claims = await fetchForReport(actor, f);
  const items = await itemsFor(claims.map((c) => c.id));
  return buildClaimsCsv(claims, items);
}

/** The CSV text for these claims and their lines (pure, so it can be tested without a database). */
export function buildClaimsCsv(claims: any[], items: any[]): string {
  const byClaim = new Map<string, any[]>();
  for (const it of items) byClaim.set(it.claim_id, [...(byClaim.get(it.claim_id) ?? []), it]);

  const head = ['Claim no', 'Claimant', 'Employee ID', 'Status', 'Policy', 'Submitted', 'Decided', 'Decided by', 'Claim remark',
    'Category', 'Line date', 'Merchant', 'Description', 'Amount', 'Line status', 'Line remark', 'Receipt',
    'Claim total', 'Approved amount', 'Reimbursed on', 'Reimbursement ref'];
  // Travel allowance by vehicle: appended only when a claim in this report has odometer data, so
  // every other tenant's export keeps exactly the columns it has always had.
  const withTrip = items.some((it) => it.vehicle_type || it.odometer_start != null || it.odometer_end != null);
  if (withTrip) head.push('Distance (km)', 'Vehicle', 'Odometer before', 'Odometer after');
  const out: string[] = [head.map(cell).join(',')];
  const day = (d: unknown) => (d ? String(d).slice(0, 10) : '');
  for (const c of claims) {
    const lines = (byClaim.get(c.id) ?? [{}]).sort((a, b) => String(a.item_date ?? '').localeCompare(String(b.item_date ?? '')));
    for (const it of lines) {
      out.push([
        c.claim_no, c.user_name, c.employee_id, c.status, c.policy_name, day(c.submitted_at), day(c.reviewed_at), c.reviewer_name, c.review_note,
        it.category, day(it.item_date), it.merchant, it.description, it.amount, it.decision ?? '', it.decision_note, it.receipt_url ? 'Yes' : 'No',
        c.total_amount, c.approved_amount ?? '', day(c.reimbursed_at), c.reimbursed_ref,
        ...(withTrip ? [it.distance_km ?? '', it.vehicle_type ?? '', it.odometer_start ?? '', it.odometer_end ?? ''] : []),
      ].map(cell).join(','));
    }
  }
  return out.join('\n');
}

/**
 * Incentive management: the rep's own earnings, the management dashboard, the leaderboard,
 * the entry ledger and the rule an admin configures.
 *
 * Scoping follows the rest of distribution: everything is filtered to the caller's org, and
 * to their client when one is in scope. A FIELD user may only ever see their own entries —
 * `/me` and the leaderboard are open to them, the ledger and the rule are not.
 */
import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, forbidden } from '../../utils';
import { istDate, istMonth } from '../../services/crm/targetEntries.service';
import { isMissingIncentiveSchema } from '../../services/distribution/incentive.service';

const FIELD_USER_ROLES = ['field_executive', 'executive'];
const isFieldRole = (role: unknown): boolean => FIELD_USER_ROLES.includes(String(role));

/** 503 rather than a raw 500 when migration_incentives.sql has not been applied. */
function notMigrated(res: Response) {
  return res.status(503).json({
    success: false,
    error: { code: 'NOT_MIGRATED', message: 'Incentives are not set up in this database yet. Apply migration_incentives.sql.' },
  });
}

type Row = Record<string, unknown>;

/** org + client scope shared by every read here. */
function scoped(q: any, user: any) {
  let r = q.eq('org_id', user.org_id);
  if (user.client_id) r = r.eq('client_id', user.client_id);
  return r;
}

/** The IST window a period name covers, as ISO instants. `all` means no lower bound. */
function windowFor(period: string): { from?: string; label: string } {
  const now = Date.now();
  if (period === 'today') return { from: `${istDate(now)}T00:00:00+05:30`, label: 'Today' };
  if (period === 'week') {
    const d = new Date(now + 330 * 60000);
    const dow = d.getUTCDay();                       // 0 = Sunday
    const back = dow === 0 ? 6 : dow - 1;            // week starts Monday, IST
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
    const iso = start.toISOString().slice(0, 10);
    return { from: `${iso}T00:00:00+05:30`, label: 'This week' };
  }
  if (period === 'all') return { label: 'All time' };
  return { from: `${istMonth(now).start}T00:00:00+05:30`, label: 'This month' };   // default
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

/** Name lookup for a set of user ids, so the UI never has to join client-side. */
async function namesFor(ids: string[]): Promise<Record<string, { name: string; employee_id: string | null }>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return {};
  const { data } = await supabaseAdmin.from('users').select('id, name, employee_id').in('id', unique);
  const out: Record<string, { name: string; employee_id: string | null }> = {};
  (data ?? []).forEach((u: Row) => {
    out[String(u.id)] = { name: String(u.name ?? '—'), employee_id: (u.employee_id as string) ?? null };
  });
  return out;
}

// ── GET /distribution/incentives/me ─────────────────────────────────────────
// The signed-in rep's own earnings. Any role may call it; it is always their own data.
export const mine = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { from, label } = windowFor(String(req.query.period ?? 'month'));

  let q = scoped(supabaseAdmin.from('incentive_entries').select('*'), user).eq('salesman_id', user.id);
  if (from) q = q.gte('earned_at', from);
  const { data, error } = await q.order('earned_at', { ascending: false }).limit(200);
  if (error) return isMissingIncentiveSchema(error) ? notMigrated(res) : badRequest(res, error.message);

  const rows = (data ?? []) as Row[];
  const earned = rows.filter((r) => r.status === 'earned');
  const paid = rows.filter((r) => r.status === 'paid');
  const reversed = rows.filter((r) => r.status === 'reversed');
  const sum = (list: Row[]) => Math.round(list.reduce((t, r) => t + num(r.amount), 0) * 100) / 100;

  ok(res, {
    period: label,
    earned_amount: sum(earned),
    paid_amount: sum(paid),
    reversed_amount: sum(reversed),
    payable_amount: sum(earned),
    order_count: earned.length,
    entries: rows.slice(0, 50),
  });
});

// ── GET /distribution/incentives/leaderboard ────────────────────────────────
// Ranked by incentive EARNED in the window. Visible to everyone with the module: a
// leaderboard nobody can see motivates nobody. Shows amounts only, never another rep's orders.
export const leaderboard = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { from, label } = windowFor(String(req.query.period ?? 'month'));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

  let q = scoped(supabaseAdmin.from('incentive_entries').select('salesman_id, amount, basis_amount, status'), user)
    .in('status', ['earned', 'paid']);
  if (from) q = q.gte('earned_at', from);
  const { data, error } = await q.limit(10000);
  if (error) return isMissingIncentiveSchema(error) ? notMigrated(res) : badRequest(res, error.message);

  const byRep = new Map<string, { amount: number; sales: number; orders: number }>();
  ((data ?? []) as Row[]).forEach((r) => {
    const id = String(r.salesman_id);
    const cur = byRep.get(id) ?? { amount: 0, sales: 0, orders: 0 };
    cur.amount += num(r.amount);
    cur.sales += num(r.basis_amount);
    cur.orders += 1;
    byRep.set(id, cur);
  });

  const names = await namesFor(Array.from(byRep.keys()));
  const entries = Array.from(byRep.entries())
    .map(([id, v]) => ({
      user_id: id,
      name: names[id]?.name ?? '—',
      employee_id: names[id]?.employee_id ?? null,
      incentive_amount: Math.round(v.amount * 100) / 100,
      sales_value: Math.round(v.sales * 100) / 100,
      order_count: v.orders,
      is_me: id === user.id,
    }))
    .sort((a, b) => b.incentive_amount - a.incentive_amount)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  ok(res, {
    period: label,
    entries: entries.slice(0, limit),
    my_rank: entries.find((e) => e.is_me)?.rank ?? null,
    total_participants: entries.length,
  });
});

// ── GET /distribution/incentives/dashboard ──────────────────────────────────
// Management view: totals by status for the window, plus the top earners.
export const dashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isFieldRole(user.role)) return forbidden(res, 'The incentive dashboard is for managers.');
  const { from, label } = windowFor(String(req.query.period ?? 'month'));

  let q = scoped(supabaseAdmin.from('incentive_entries').select('salesman_id, amount, basis_amount, status'), user);
  if (from) q = q.gte('earned_at', from);
  const { data, error } = await q.limit(20000);
  if (error) return isMissingIncentiveSchema(error) ? notMigrated(res) : badRequest(res, error.message);

  const rows = (data ?? []) as Row[];
  const total = (st: string, field: 'amount' | 'basis_amount' = 'amount') =>
    Math.round(rows.filter((r) => r.status === st).reduce((t, r) => t + num(r[field]), 0) * 100) / 100;

  const byRep = new Map<string, number>();
  rows.filter((r) => r.status !== 'reversed').forEach((r) => {
    const id = String(r.salesman_id);
    byRep.set(id, (byRep.get(id) ?? 0) + num(r.amount));
  });
  const names = await namesFor(Array.from(byRep.keys()));
  const topEarners = Array.from(byRep.entries())
    .map(([id, amount]) => ({ user_id: id, name: names[id]?.name ?? '—', amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount).slice(0, 10);

  ok(res, {
    period: label,
    earned_amount: total('earned'),
    paid_amount: total('paid'),
    reversed_amount: total('reversed'),
    payable_amount: total('earned'),
    sales_value: Math.round(rows.filter((r) => r.status !== 'reversed')
      .reduce((t, r) => t + num(r.basis_amount), 0) * 100) / 100,
    order_count: rows.filter((r) => r.status !== 'reversed').length,
    reversed_count: rows.filter((r) => r.status === 'reversed').length,
    participating_reps: byRep.size,
    top_earners: topEarners,
  });
});

// ── GET /distribution/incentives/entries ────────────────────────────────────
// The ledger. Managers see the whole scope; a field user is forced to their own rows.
export const entries = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
  const { from } = windowFor(String(req.query.period ?? 'month'));

  let q = scoped(supabaseAdmin.from('incentive_entries').select('*'), user);
  if (isFieldRole(user.role)) q = q.eq('salesman_id', user.id);
  else if (req.query.salesman_id) q = q.eq('salesman_id', String(req.query.salesman_id));
  if (req.query.status) q = q.eq('status', String(req.query.status));
  if (from) q = q.gte('earned_at', from);

  const { data, error } = await q.order('earned_at', { ascending: false }).limit(limit);
  if (error) return isMissingIncentiveSchema(error) ? notMigrated(res) : badRequest(res, error.message);

  const rows = (data ?? []) as Row[];
  const names = await namesFor(rows.map((r) => String(r.salesman_id)));
  ok(res, rows.map((r) => ({ ...r, salesman_name: names[String(r.salesman_id)]?.name ?? '—' })));
});

// ── GET / PUT /distribution/incentives/rule ─────────────────────────────────
const ruleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  rate_pct: z.number().min(0).max(100),
  basis: z.enum(['taxable_value', 'grand_total']).optional(),
  earn_on: z.enum(['placed', 'approved', 'invoiced']).optional(),
  is_active: z.boolean().optional(),
});

export const getRule = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isFieldRole(user.role)) return forbidden(res, 'Only a manager can view the incentive rule.');
  const { data, error } = await scoped(
    supabaseAdmin.from('incentive_rules').select('*').eq('is_active', true), user,
  ).maybeSingle();
  if (error) return isMissingIncentiveSchema(error) ? notMigrated(res) : badRequest(res, error.message);
  ok(res, data ?? null);
});

/** Upsert the single active rule for this scope. */
export const putRule = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isFieldRole(user.role)) return forbidden(res, 'Only a manager can change the incentive rule.');
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  const existing = await scoped(
    supabaseAdmin.from('incentive_rules').select('id').eq('is_active', true), user,
  ).maybeSingle();
  if (existing.error && isMissingIncentiveSchema(existing.error)) return notMigrated(res);

  const payload = {
    name: parsed.data.name ?? 'Sales incentive',
    rate_pct: parsed.data.rate_pct,
    basis: parsed.data.basis ?? 'taxable_value',
    earn_on: parsed.data.earn_on ?? 'approved',
    is_active: parsed.data.is_active ?? true,
    updated_by: user.id,
  };

  if (existing.data?.id) {
    const { data, error } = await supabaseAdmin.from('incentive_rules')
      .update(payload).eq('id', existing.data.id).select().single();
    if (error) return badRequest(res, error.message);
    return ok(res, data);
  }
  const { data, error } = await supabaseAdmin.from('incentive_rules').insert({
    ...payload, org_id: user.org_id, client_id: user.client_id ?? null, created_by: user.id,
  }).select().single();
  if (error) return isMissingIncentiveSchema(error) ? notMigrated(res) : badRequest(res, error.message);
  ok(res, data);
});

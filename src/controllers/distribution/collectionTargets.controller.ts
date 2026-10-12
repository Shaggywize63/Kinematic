/**
 * Employee-wise monthly ₹ collection targets + achievement. Opt-in by data: no targets ⇒ the report simply lists every
 * eligible user with a zero target and their actual collection, so an admin can start setting them.
 *
 * Routes (mounted under /api/v1/distribution/collection-targets, requireModule('reports') + requireAdminOrAbove):
 *   GET  /?month=YYYY-MM        report: each rep/supervisor's target, actual, % and band for the month
 *   POST /                      upsert one user's target for a month
 *   DELETE /:id                 remove a target
 */
import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../../utils';
import { audit } from '../../utils/audit';
import {
  monthStart, monthRangeUtc, cleanAmount, isTargetRole, buildReport, round2,
  COUNTED_PAYMENT_STATUSES, type TargetRow, type CollectorActual, type UserLite,
} from '../../services/distribution/collectionTargets.service';

const thisMonthIst = () => {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ── GET / — report ───────────────────────────────────────────────────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const month = monthStart((req.query.month as string) || thisMonthIst());
  if (!month) return badRequest(res, 'month must be YYYY-MM');
  const { startUtc, endUtc } = monthRangeUtc(month);

  const [{ data: users }, { data: targets }, { data: pays }] = await Promise.all([
    supabaseAdmin.from('users')
      .select('id, name, role, employee_id')
      .eq('org_id', user.org_id).eq('is_active', true).is('deleted_at', null),
    supabaseAdmin.from('distribution_collection_targets')
      .select('id, user_id, target_amount, note').eq('org_id', user.org_id).eq('period_month', month),
    supabaseAdmin.from('payments')
      .select('salesman_id, amount, status, received_at')
      .eq('org_id', user.org_id).gte('received_at', startUtc).lt('received_at', endUtc),
  ]);

  const actualByUser = new Map<string, number>();
  for (const p of (pays || []) as any[]) {
    if (!p.salesman_id || !COUNTED_PAYMENT_STATUSES.has(String(p.status))) continue;
    actualByUser.set(p.salesman_id, (actualByUser.get(p.salesman_id) || 0) + (Number(p.amount) || 0));
  }
  const actuals: CollectorActual[] = Array.from(actualByUser, ([user_id, actual]) => ({ user_id, actual }));
  const targetRows: TargetRow[] = (targets || []).map((t: any) => ({ user_id: t.user_id, target_amount: Number(t.target_amount), id: t.id, note: t.note }));
  const userRows: UserLite[] = (users || []).map((u: any) => ({ id: u.id, name: u.name, role: u.role, employee_id: u.employee_id }));

  const rows = buildReport(userRows, targetRows, actuals);
  const summary = {
    users: rows.length,
    with_target: rows.filter((r) => r.target_amount > 0).length,
    total_target: round2(rows.reduce((s, r) => s + r.target_amount, 0)),
    total_actual: round2(rows.reduce((s, r) => s + r.actual, 0)),
  };
  ok(res, { month, rows, summary });
});

// ── POST / — upsert ──────────────────────────────────────────────────────────
const upsertSchema = z.object({
  user_id: z.string().uuid(),
  month: z.string(),
  target_amount: z.union([z.number(), z.string()]),
  note: z.string().max(300).optional().nullable(),
});

export const upsert = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const month = monthStart(parsed.data.month);
  if (!month) return badRequest(res, 'month must be YYYY-MM');
  const amount = cleanAmount(parsed.data.target_amount);
  if (amount === null) return badRequest(res, 'target_amount must be a non-negative number');

  // The user must belong to the caller's org and be a target-role user.
  const { data: target } = await supabaseAdmin.from('users')
    .select('id, role, org_id').eq('id', parsed.data.user_id).maybeSingle();
  if (!target || target.org_id !== user.org_id) return badRequest(res, 'User not in your organisation');
  if (!isTargetRole(target.role)) return badRequest(res, 'Targets can only be set for field reps and supervisors');

  const { data, error } = await supabaseAdmin.from('distribution_collection_targets')
    .upsert({
      org_id: user.org_id, client_id: user.client_id ?? null, user_id: parsed.data.user_id,
      period_month: month, target_amount: amount, note: parsed.data.note ?? null,
      created_by: user.id, updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,user_id,period_month' })
    .select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'collection_target.upsert', 'distribution_collection_targets', data.id, null, { user_id: parsed.data.user_id, month, amount });
  created(res, data, 'Collection target saved');
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────
export const remove = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data: row } = await supabaseAdmin.from('distribution_collection_targets')
    .select('id').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!row) return notFound(res, 'Target not found');
  const { error } = await supabaseAdmin.from('distribution_collection_targets').delete().eq('id', req.params.id).eq('org_id', user.org_id);
  if (error) return badRequest(res, error.message);
  await audit(req, 'collection_target.delete', 'distribution_collection_targets', req.params.id, null, null);
  ok(res, { id: req.params.id }, 'Target removed');
});

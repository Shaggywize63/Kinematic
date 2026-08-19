import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';

/**
 * Trade Promotion Management (module `distribution_promotions`).
 *
 * A trade promotion is a budgeted trade-spend program (price-off, free goods,
 * display, slotting, volume rebate, visibility) run over a period against a
 * customer/channel/SKU scope, optionally linked to a scheme (the offer mechanic
 * reps actually see). Distributors file CLAIMS against a promotion; claims are
 * approved and settled. The summary endpoint rolls up budget vs claimed/approved/
 * settled spend and generated sales for a simple ROI.
 *
 * Tables: trade_promotions, tp_claims (settlement inline). Org-scoped via
 * supabaseAdmin (service_role); RLS-enabled (deny-all to anon/authenticated).
 */

const PROMO_TYPES = ['price_off', 'free_goods', 'display', 'slotting', 'volume_rebate', 'visibility', 'other'] as const;
const FUNDING = ['brand', 'distributor', 'shared'] as const;
const PROMO_STATUS = ['draft', 'active', 'paused', 'closed'] as const;

const targetingSchema = z.object({
  customer_classes: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  sku_ids: z.array(z.string().uuid()).optional(),
  distributor_ids: z.array(z.string().uuid()).optional(),
}).partial();

const upsertPromotionSchema = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  promo_type: z.enum(PROMO_TYPES).optional(),
  status: z.enum(PROMO_STATUS).optional(),
  funding_source: z.enum(FUNDING).optional(),
  objective: z.string().max(500).optional(),
  budget_amount: z.number().nonnegative().optional(),
  currency: z.string().max(8).optional(),
  valid_from: z.string().optional(),
  valid_to: z.string().optional(),
  targeting: targetingSchema.optional(),
  linked_scheme_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).optional(),
});

const claimSchema = z.object({
  distributor_id: z.string().uuid().optional(),
  claim_no: z.string().max(60).optional(),
  period_from: z.string().optional(),
  period_to: z.string().optional(),
  claimed_amount: z.number().nonnegative(),
  evidence: z.array(z.object({ url: z.string().url().optional(), note: z.string().optional() })).optional(),
  notes: z.string().max(1000).optional(),
});

// ── Promotions CRUD ─────────────────────────────────────────────────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('trade_promotions')
    .select('*')
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit as string) || 100, 300));
  if (req.query.status) q = q.eq('status', req.query.status as string);
  if (req.query.promo_type) q = q.eq('promo_type', req.query.promo_type as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return notFound(res, 'Promotion not found');
  const { data, error } = await supabaseAdmin.from('trade_promotions')
    .select('*, tp_claims(*)')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Promotion not found');
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = upsertPromotionSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const b = parsed.data;
  const { data, error } = await supabaseAdmin.from('trade_promotions').insert({
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    code: b.code,
    name: b.name,
    promo_type: b.promo_type ?? 'price_off',
    status: b.status ?? 'draft',
    funding_source: b.funding_source ?? 'brand',
    objective: b.objective ?? null,
    budget_amount: b.budget_amount ?? 0,
    currency: b.currency ?? 'INR',
    valid_from: b.valid_from ?? null,
    valid_to: b.valid_to ?? null,
    targeting: b.targeting ?? {},
    linked_scheme_id: b.linked_scheme_id ?? null,
    notes: b.notes ?? null,
    created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'trade_promotion.create', 'trade_promotions', data.id, null, data);
  created(res, data, 'Trade promotion created');
});

export const update = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = upsertPromotionSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { data: before } = await supabaseAdmin.from('trade_promotions').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Promotion not found');
  const { data, error } = await supabaseAdmin.from('trade_promotions')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'trade_promotion.update', 'trade_promotions', data.id, before, data);
  ok(res, data, 'Trade promotion updated');
});

export const setStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const status = (req.body?.status || '').toString();
  if (!(PROMO_STATUS as readonly string[]).includes(status)) {
    return badRequest(res, `status must be one of ${PROMO_STATUS.join(', ')}`);
  }
  const { data, error } = await supabaseAdmin.from('trade_promotions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id).select().maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Promotion not found');
  await audit(req, 'trade_promotion.status', 'trade_promotions', data.id, null, { status });
  ok(res, data, `Promotion ${status}`);
});

// ── Claims ──────────────────────────────────────────────────────────────────
export const listClaims = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin.from('tp_claims')
    .select('*')
    .eq('org_id', user.org_id).eq('promotion_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const createClaim = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  // Verify the promotion exists in this org before attaching a claim.
  const { data: promo } = await supabaseAdmin.from('trade_promotions').select('id')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!promo) return notFound(res, 'Promotion not found');
  const b = parsed.data;
  const { data, error } = await supabaseAdmin.from('tp_claims').insert({
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    promotion_id: req.params.id,
    distributor_id: b.distributor_id ?? null,
    claim_no: b.claim_no ?? null,
    period_from: b.period_from ?? null,
    period_to: b.period_to ?? null,
    claimed_amount: b.claimed_amount,
    status: 'submitted',
    evidence: b.evidence ?? [],
    notes: b.notes ?? null,
    submitted_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'tp_claim.create', 'tp_claims', data.id, null, data);
  created(res, data, 'Claim submitted');
});

async function transitionClaim(
  req: AuthRequest, res: Response, claimId: string,
  patch: Record<string, unknown>, action: string, okMsg: string,
) {
  const user = req.user!;
  const { data: before } = await supabaseAdmin.from('tp_claims').select('*')
    .eq('id', claimId).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Claim not found');
  const { data, error } = await supabaseAdmin.from('tp_claims')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', claimId).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, action, 'tp_claims', data.id, before, data);
  ok(res, data, okMsg);
}

export const approveClaim = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const approved = req.body?.approved_amount;
  const patch: Record<string, unknown> = {
    status: 'approved',
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  };
  if (typeof approved === 'number' && approved >= 0) patch.approved_amount = approved;
  return transitionClaim(req, res, req.params.claimId, patch, 'tp_claim.approve', 'Claim approved');
});

export const rejectClaim = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  return transitionClaim(req, res, req.params.claimId, {
    status: 'rejected', approved_by: user.id, approved_at: new Date().toISOString(),
    notes: (req.body?.reason || '').toString().slice(0, 1000) || undefined,
  }, 'tp_claim.reject', 'Claim rejected');
});

export const settleClaim = asyncHandler(async (req: AuthRequest, res: Response) => {
  const settled = req.body?.settled_amount;
  const patch: Record<string, unknown> = {
    status: 'settled',
    settled_at: new Date().toISOString(),
    payment_ref: (req.body?.payment_ref || '').toString().slice(0, 120) || null,
  };
  if (typeof settled === 'number' && settled >= 0) patch.settled_amount = settled;
  return settleGuard(req, res, patch);
});

// Settlement is only valid from an approved claim.
async function settleGuard(req: AuthRequest, res: Response, patch: Record<string, unknown>) {
  const user = req.user!;
  const { data: before } = await supabaseAdmin.from('tp_claims').select('*')
    .eq('id', req.params.claimId).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Claim not found');
  if (before.status !== 'approved' && before.status !== 'settled') {
    return conflict(res, `Cannot settle a claim in status=${before.status} (must be approved)`);
  }
  // Default the settled amount to the approved (or claimed) amount when not given.
  if (patch.settled_amount == null) {
    patch.settled_amount = before.approved_amount ?? before.claimed_amount ?? 0;
  }
  const { data, error } = await supabaseAdmin.from('tp_claims')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', req.params.claimId).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'tp_claim.settle', 'tp_claims', data.id, before, data);
  ok(res, data, 'Claim settled');
}

// ── Summary / ROI ───────────────────────────────────────────────────────────
export const summary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data: promo, error: pErr } = await supabaseAdmin.from('trade_promotions')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (pErr) return badRequest(res, pErr.message);
  if (!promo) return notFound(res, 'Promotion not found');

  const { data: claims } = await supabaseAdmin.from('tp_claims')
    .select('claimed_amount, approved_amount, settled_amount, status')
    .eq('org_id', user.org_id).eq('promotion_id', promo.id);

  const sum = (arr: any[], f: (c: any) => number) => (arr || []).reduce((s, c) => s + (Number(f(c)) || 0), 0);
  const claimed_total = sum(claims || [], (c) => c.claimed_amount);
  const approved_total = sum((claims || []).filter((c) => ['approved', 'settled'].includes(c.status)), (c) => c.approved_amount ?? c.claimed_amount);
  const settled_total = sum((claims || []).filter((c) => c.status === 'settled'), (c) => c.settled_amount ?? c.approved_amount ?? c.claimed_amount);

  // Generated sales: orders placed within the promo window, scoped to its
  // targeting where present (distributor_ids / customer_classes). Best-effort;
  // an unscoped promo counts all org orders in the window.
  let sales_q = supabaseAdmin.from('orders')
    .select('grand_total')
    .eq('org_id', user.org_id)
    .neq('status', 'cancelled');
  if (promo.valid_from) sales_q = sales_q.gte('placed_at', promo.valid_from);
  if (promo.valid_to) sales_q = sales_q.lte('placed_at', `${promo.valid_to}T23:59:59`);
  const targeting = (promo.targeting || {}) as any;
  if (Array.isArray(targeting.distributor_ids) && targeting.distributor_ids.length) {
    sales_q = sales_q.in('distributor_id', targeting.distributor_ids);
  }
  if (Array.isArray(targeting.customer_classes) && targeting.customer_classes.length) {
    sales_q = sales_q.in('customer_class', targeting.customer_classes);
  }
  const { data: salesRows } = await sales_q;
  const generated_sales = sum(salesRows || [], (o) => o.grand_total);

  const budget = Number(promo.budget_amount) || 0;
  const spend = settled_total || approved_total; // recognised spend
  const round2 = (v: number) => Math.round(v * 100) / 100;

  ok(res, {
    promotion_id: promo.id,
    budget_amount: budget,
    currency: promo.currency,
    claimed_total: round2(claimed_total),
    approved_total: round2(approved_total),
    settled_total: round2(settled_total),
    claim_count: (claims || []).length,
    generated_sales: round2(generated_sales),
    budget_utilization_pct: budget > 0 ? Math.round((spend / budget) * 100) : null,
    roi: spend > 0 ? round2(generated_sales / spend) : null,
    order_count: (salesRows || []).length,
  });
});

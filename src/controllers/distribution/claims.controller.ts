import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';

/**
 * Distributor claims & settlements (module `distribution_claims`).
 *
 * Generalises the promotion-only `tp_claims` to ALL distributor claim types
 * (damage, expiry, scheme, price-protection, freight, shortage…). A claim is
 * submitted → (under_review) → approved / rejected → settled. Settlement is
 * inline (credit-note / adjustment), distributor-level, so it does NOT touch the
 * outlet-scoped `ledger_entries`; financial rollups come from this table.
 *
 * When a claim is raised from damage-register entries (ref_type 'damage'), those
 * entries are marked `claimed`, and on settlement `written_off`.
 */

const CLAIM_TYPES = ['damage', 'expiry', 'scheme', 'promotion', 'price_protection', 'freight', 'shortage', 'other'] as const;

// ── GET /distribution/claims/summary — rollup ────────────────────────────────
export const summary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { total: 0, by_status: {}, claimed_amount: 0, approved_amount: 0, settled_amount: 0 });
  let q = supabaseAdmin.from('distribution_claims')
    .select('status, claimed_amount, approved_amount, settled_amount')
    .eq('org_id', user.org_id);
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  const rows = data || [];
  const by_status: Record<string, number> = {};
  let claimed = 0, approved = 0, settled = 0;
  for (const r of rows as any[]) {
    by_status[r.status] = (by_status[r.status] || 0) + 1;
    claimed += Number(r.claimed_amount) || 0;
    if (['approved', 'settled'].includes(r.status)) approved += Number(r.approved_amount ?? r.claimed_amount) || 0;
    if (r.status === 'settled') settled += Number(r.settled_amount ?? r.approved_amount ?? 0) || 0;
  }
  ok(res, { total: rows.length, by_status, claimed_amount: claimed, approved_amount: approved, settled_amount: settled });
});

// ── GET /distribution/claims ─────────────────────────────────────────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('distribution_claims')
    .select('*, distributors:distributor_id(name)')
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit as string) || 200, 500));
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.status)         q = q.eq('status', req.query.status as string);
  if (req.query.claim_type)     q = q.eq('claim_type', req.query.claim_type as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  const rows = (data || []).map((r: any) => ({ ...r, distributor_name: r.distributors?.name ?? null }));
  ok(res, rows);
});

// ── GET /distribution/claims/:id — with linked damage entries ────────────────
export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin.from('distribution_claims')
    .select('*, distributors:distributor_id(name)')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Claim not found');
  const { data: damages } = await supabaseAdmin.from('distribution_damage_entries')
    .select('*, skus:sku_id(name, sku_code)')
    .eq('org_id', user.org_id).eq('claim_id', req.params.id);
  ok(res, { ...data, distributor_name: (data as any).distributors?.name ?? null, damage_entries: damages || [] });
});

// ── POST /distribution/claims — raise a claim ────────────────────────────────
const createSchema = z.object({
  distributor_id: z.string().uuid(),
  claim_type: z.enum(CLAIM_TYPES),
  claimed_amount: z.number().nonnegative(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  currency: z.string().max(8).optional(),
  claim_no: z.string().max(60).optional(),
  ref_type: z.string().max(32).optional(),
  ref_ids: z.array(z.string().uuid()).optional(),
  evidence_urls: z.array(z.string()).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
});
export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const b = parsed.data;
  const { data, error } = await supabaseAdmin.from('distribution_claims').insert({
    org_id: user.org_id, client_id: user.client_id ?? null,
    distributor_id: b.distributor_id, claim_type: b.claim_type, claimed_amount: b.claimed_amount,
    title: b.title ?? null, description: b.description ?? null, currency: b.currency ?? 'INR',
    claim_no: b.claim_no ?? null, ref_type: b.ref_type ?? null, ref_ids: b.ref_ids ?? null,
    evidence_urls: b.evidence_urls ?? null, period_start: b.period_start ?? null, period_end: b.period_end ?? null,
    status: 'submitted', created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);

  // Roll damage-register entries into this claim (mark them 'claimed').
  if (b.ref_type === 'damage' && b.ref_ids && b.ref_ids.length) {
    await supabaseAdmin.from('distribution_damage_entries')
      .update({ status: 'claimed', claim_id: data.id, updated_at: new Date().toISOString() })
      .eq('org_id', user.org_id).in('id', b.ref_ids);
  }
  await audit(req, 'claim.create', 'distribution_claims', data.id, null, data);
  created(res, data, 'Claim submitted');
});

// ── POST /distribution/claims/:id/status — review (approve/reject/under_review)
const statusSchema = z.object({
  status: z.enum(['under_review', 'approved', 'rejected']),
  approved_amount: z.number().nonnegative().optional(),
  review_notes: z.string().max(1000).optional(),
});
export const updateStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const b = parsed.data;
  const { data: before } = await supabaseAdmin.from('distribution_claims')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Claim not found');
  if (before.status === 'settled') return conflict(res, 'Claim is already settled');

  const patch: Record<string, any> = {
    status: b.status, review_notes: b.review_notes ?? before.review_notes,
    reviewed_by: user.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (b.status === 'approved') patch.approved_amount = b.approved_amount ?? before.claimed_amount;
  const { data, error } = await supabaseAdmin.from('distribution_claims')
    .update(patch).eq('id', req.params.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'claim.status', 'distribution_claims', data.id, before, data, { status: b.status });
  ok(res, data, `Claim ${b.status}`);
});

// ── POST /distribution/claims/:id/settle — inline settlement ─────────────────
const settleSchema = z.object({
  settled_amount: z.number().nonnegative(),
  settlement_ref: z.string().max(120).optional(),
  settlement_mode: z.enum(['credit_note', 'bank_transfer', 'adjustment', 'cheque']).optional(),
});
export const settle = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = settleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const b = parsed.data;
  const { data: before } = await supabaseAdmin.from('distribution_claims')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Claim not found');
  if (before.status !== 'approved') return conflict(res, `Can only settle an approved claim (status=${before.status})`);

  const { data, error } = await supabaseAdmin.from('distribution_claims').update({
    status: 'settled', settled_amount: b.settled_amount,
    settlement_ref: b.settlement_ref ?? null, settlement_mode: b.settlement_mode ?? 'credit_note',
    settled_by: user.id, settled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);

  // Written off: any damage entries this claim covered are now settled.
  if (before.ref_type === 'damage' && Array.isArray(before.ref_ids) && before.ref_ids.length) {
    await supabaseAdmin.from('distribution_damage_entries')
      .update({ status: 'written_off', updated_at: new Date().toISOString() })
      .eq('org_id', user.org_id).in('id', before.ref_ids);
  }
  await audit(req, 'claim.settle', 'distribution_claims', data.id, before, data, { settled_amount: b.settled_amount });
  ok(res, data, 'Claim settled');
});

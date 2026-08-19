import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { applyStockDelta } from './stock.controller';

/**
 * Distributor damaged / expiry register (module `distribution_damage`).
 *
 * Goods physically damaged / expired / near-expiry HELD at a distributor —
 * distinct from `returns` (sales returns against an invoice). An entry is
 * `logged`, then an admin `confirm`s it: confirming decrements the distributor's
 * on-hand stock via applyStockDelta(reason 'damage') and stamps the register.
 * Confirmed entries can be rolled into a claim (see claims.controller).
 */

const REASONS = ['damaged', 'expired', 'near_expiry', 'breakage', 'other'] as const;

// ── GET /distribution/damage ─────────────────────────────────────────────────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  let q = supabaseAdmin.from('distribution_damage_entries')
    .select('*, skus:sku_id(name, sku_code), distributors:distributor_id(name)')
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit as string) || 200, 500));
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  if (req.query.status)         q = q.eq('status', req.query.status as string);
  if (req.query.reason)         q = q.eq('reason', req.query.reason as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  const rows = (data || []).map((r: any) => ({
    ...r,
    sku_name: r.skus?.name ?? null, sku_code: r.skus?.sku_code ?? null,
    distributor_name: r.distributors?.name ?? null,
  }));
  ok(res, rows);
});

// ── POST /distribution/damage — log an entry ─────────────────────────────────
const createSchema = z.object({
  distributor_id: z.string().uuid(),
  sku_id: z.string().uuid(),
  qty: z.number().int().positive(),
  reason: z.enum(REASONS),
  batch_no: z.string().max(120).optional(),
  expiry_date: z.string().optional(),
  unit_value: z.number().nonnegative().optional(),
  evidence_urls: z.array(z.string()).optional(),
  note: z.string().max(1000).optional(),
});
export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const b = parsed.data;
  const { data, error } = await supabaseAdmin.from('distribution_damage_entries').insert({
    org_id: user.org_id, client_id: user.client_id ?? null,
    distributor_id: b.distributor_id, sku_id: b.sku_id, qty: b.qty, reason: b.reason,
    batch_no: b.batch_no ?? null, expiry_date: b.expiry_date ?? null,
    unit_value: b.unit_value ?? null, evidence_urls: b.evidence_urls ?? null,
    note: b.note ?? null, status: 'logged', created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'damage.create', 'distribution_damage_entries', data.id, null, data);
  created(res, data, 'Damage entry logged');
});

// ── POST /distribution/damage/:id/confirm — decrement on-hand ────────────────
export const confirm = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { data: before } = await supabaseAdmin.from('distribution_damage_entries')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Damage entry not found');
  if (before.status !== 'logged') return conflict(res, `Cannot confirm from status=${before.status}`);

  // Write off the damaged qty from the distributor's on-hand balance (once).
  if (!before.stock_adjusted) {
    await applyStockDelta({
      orgId: user.org_id, clientId: user.client_id ?? null, distributorId: before.distributor_id,
      skuId: before.sku_id, delta: -Math.abs(before.qty), reason: 'damage',
      refType: 'damage', refId: before.id, note: before.reason, createdBy: user.id,
    });
  }
  const { data, error } = await supabaseAdmin.from('distribution_damage_entries').update({
    status: 'confirmed', stock_adjusted: true,
    confirmed_by: user.id, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'damage.confirm', 'distribution_damage_entries', data.id, before, data);
  ok(res, data, 'Damage confirmed & written off from on-hand');
});

// ── POST /distribution/damage/:id/reject ─────────────────────────────────────
export const reject = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const reason = (req.body?.reason || '').toString().slice(0, 500);
  const { data: before } = await supabaseAdmin.from('distribution_damage_entries')
    .select('*').eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Damage entry not found');
  if (before.status !== 'logged') return conflict(res, `Cannot reject from status=${before.status}`);
  const { data, error } = await supabaseAdmin.from('distribution_damage_entries').update({
    status: 'rejected', note: reason || before.note, updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('org_id', user.org_id).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'damage.reject', 'distribution_damage_entries', data.id, before, data, { reason });
  ok(res, data, 'Damage entry rejected');
});

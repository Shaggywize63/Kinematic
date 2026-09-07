import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { receiveBatch, consumeStock, listBatches, expiryReport, expiryAlerts, BatchStatus } from '../../services/distribution/batchStock.service';

// ── GET /distribution/batches?distributor_id=&sku_id=&status=&near_days= ──────
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);
  const rows = await listBatches({
    orgId: user.org_id,
    distributorId: (req.query.distributor_id as string) || null,
    skuId: (req.query.sku_id as string) || null,
    status: ((req.query.status as string) || 'all') as BatchStatus | 'all',
    nearDays: req.query.near_days ? parseInt(req.query.near_days as string, 10) : undefined,
    includeEmpty: String(req.query.include_empty || '') === 'true',
  });
  ok(res, rows);
});

// ── GET /distribution/batches/expiry-report?distributor_id=&within_days= ──────
export const expiry = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { near_expiry: [], expired: [] });
  const rep = await expiryReport({
    orgId: user.org_id,
    distributorId: (req.query.distributor_id as string) || null,
    withinDays: req.query.within_days ? parseInt(req.query.within_days as string, 10) : undefined,
  });
  ok(res, rep);
});

// ── GET /distribution/batches/alerts?distributor_id=&within_days= ─────────────
// Near-expiry + expired batches for proactive alerting, with roll-up counts.
// (SCM Phase 2 — same near-expiry window rules as listBatches / expiry-report.)
export const alerts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { near_expiry: [], expired: [], counts: { near_expiry: 0, expired: 0, total: 0 } });
  const out = await expiryAlerts({
    orgId: user.org_id,
    distributorId: (req.query.distributor_id as string) || null,
    withinDays: req.query.within_days ? parseInt(req.query.within_days as string, 10) : undefined,
  });
  ok(res, out);
});

// ── POST /distribution/receiving  — GRN (module distribution_receiving) ───────
const receiveSchema = z.object({
  distributor_id: z.string().uuid(),
  sku_id: z.string().uuid(),
  qty: z.number().positive(),
  batch_no: z.string().max(120).optional(),
  expiry_date: z.string().optional(),
  mfg_date: z.string().optional(),
  unit_cost: z.number().nonnegative().optional(),
  reference: z.string().max(200).optional(),
});
export const receive = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { batch: { id: 'demo' }, balance: 0 }, 'Received (Demo)');
  const p = receiveSchema.safeParse(req.body);
  if (!p.success) return badRequest(res, 'Validation failed', p.error.errors);
  const b = p.data;
  try {
    const out = await receiveBatch({
      orgId: user.org_id, clientId: user.client_id ?? null, distributorId: b.distributor_id, skuId: b.sku_id,
      qty: b.qty, batchNo: b.batch_no ?? null, expiryDate: b.expiry_date ?? null, mfgDate: b.mfg_date ?? null,
      unitCost: b.unit_cost ?? null, reference: b.reference ?? null, createdBy: user.id,
    });
    await audit(req, 'stock_batch.receive', 'distribution_stock_batches', out.batch.id, null, { ...b, balance: out.balance });
    created(res, out, 'Batch received');
  } catch (e) {
    return badRequest(res, e instanceof Error ? e.message : 'Receive failed');
  }
});

// ── POST /distribution/batches/consume  — FEFO/FIFO draw-down ─────────────────
const consumeSchema = z.object({
  distributor_id: z.string().uuid(),
  sku_id: z.string().uuid(),
  qty: z.number().positive(),
  strategy: z.enum(['fefo', 'fifo']).optional(),
  reason: z.enum(['sale', 'consume', 'damage', 'van_load']).optional(),
  note: z.string().max(500).optional(),
});
export const consume = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { consumed: [], totalCost: 0, balance: 0 }, 'Consumed (Demo)');
  const p = consumeSchema.safeParse(req.body);
  if (!p.success) return badRequest(res, 'Validation failed', p.error.errors);
  const b = p.data;
  try {
    const out = await consumeStock({
      orgId: user.org_id, clientId: user.client_id ?? null, distributorId: b.distributor_id, skuId: b.sku_id,
      qty: b.qty, strategy: b.strategy, reason: b.reason, refType: 'manual', note: b.note ?? null, createdBy: user.id,
    });
    await audit(req, 'stock_batch.consume', 'distribution_stock_batches', b.sku_id, null, { ...b, totalCost: out.totalCost });
    created(res, out, 'Stock consumed');
  } catch (e) {
    return badRequest(res, e instanceof Error ? e.message : 'Consume failed');
  }
});

/**
 * Field Expense / Travel Claims. Mounted at /api/v1/expenses
 * (requireAuth + requireModule('field_expenses') applied at mount).
 *
 *   Rep:      GET  policy, GET claims[?status], GET claims/:id, POST claims,
 *             POST claims/:id/submit, PATCH claims/:id/cancel,
 *             GET  mileage (GPS-derived suggestion), POST scan-receipt (AI OCR)
 *   Approver: GET  claims/pending, PATCH claims/:id/decision
 *   Admin:    PUT  policy, POST claims/:id/reimburse
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireSupervisorOrAbove, requireAdminOrAbove } from '../middleware/auth';
import { AuthRequest } from '../types';
import { AppError } from '../utils';
import * as expenses from '../services/expenses/expenses.service';
import { scanReceipt, ReceiptMediaType } from '../services/expenses/receiptScan.service';

const router = Router();

function actor(req: AuthRequest): expenses.Actor {
  const u = req.user as any;
  return { id: u.id, org_id: u.org_id, role: u.role, client_id: u.client_id ?? null };
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || 'Invalid input', 'VALIDATION');
  return r.data;
}
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const category = z.enum(['mileage', 'travel', 'food', 'lodging', 'fuel', 'toll', 'misc']);

const itemSchema = z.object({
  category,
  item_date: dateStr.optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  amount: z.number().min(0).max(10_000_000).optional().nullable(),
  distance_km: z.number().min(0).max(100_000).optional().nullable(),
  from_location: z.string().max(200).optional().nullable(),
  to_location: z.string().max(200).optional().nullable(),
  merchant: z.string().max(200).optional().nullable(),
  receipt_url: z.string().url().max(2048).optional().nullable(),
  ai_extracted: z.any().optional(),
});
const createSchema = z.object({
  title: z.string().max(200).optional().nullable(),
  items: z.array(itemSchema).max(100).optional(),
});
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional() });
const reimburseSchema = z.object({ ref: z.string().max(120).optional() });
const policySchema = z.object({
  currency: z.string().max(8).optional(),
  mileage_rate: z.number().min(0).max(10_000).optional(),
  auto_approve_under: z.number().min(0).max(10_000_000).optional(),
  escalate_over: z.number().min(0).max(10_000_000).optional().nullable(),
  require_receipt_over: z.number().min(0).max(10_000_000).optional(),
  category_limits: z.record(z.string(), z.number().min(0)).optional().nullable(),
  is_active: z.boolean().optional(),
});
const scanSchema = z.object({
  image: z.string().min(16),
  media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
});

// ── policy ──────────────────────────────────────────────────────────────────
router.get('/policy', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.getPolicy(req.user!.org_id, (req.user as any).client_id ?? null) });
}));
router.put('/policy', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.savePolicy(actor(req), parse(policySchema, req.body)) });
}));

// ── mileage suggestion (from the GPS trail) ─────────────────────────────────
router.get('/mileage', asyncHandler<AuthRequest>(async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!from || !to) throw new AppError(400, 'from/to (ISO timestamps) required', 'VALIDATION');
  const forUser = req.query.user_id ? String(req.query.user_id) : undefined;
  res.json({ success: true, data: await expenses.mileageSuggestion(actor(req), from, to, forUser) });
}));

// ── receipt OCR ─────────────────────────────────────────────────────────────
router.post('/scan-receipt', asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(scanSchema, req.body);
  const fields = await scanReceipt(b.image, (b.media_type as ReceiptMediaType) || 'image/jpeg');
  res.json({ success: true, data: fields });
}));

// ── approver queue (declare before /claims/:id) ─────────────────────────────
router.get('/claims/pending', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.pendingForApprover(actor(req)) });
}));

// ── claims (rep) ────────────────────────────────────────────────────────────
router.get('/claims', asyncHandler<AuthRequest>(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json({ success: true, data: await expenses.listMyClaims(actor(req), status) });
}));
router.get('/claims/:id', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.getClaim(actor(req), req.params.id) });
}));
router.post('/claims', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.createClaim(actor(req), parse(createSchema, req.body)) });
}));
router.post('/claims/:id/submit', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.submitClaim(actor(req), req.params.id) });
}));
router.patch('/claims/:id/cancel', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.cancelClaim(actor(req), req.params.id) });
}));

// ── decisions ───────────────────────────────────────────────────────────────
router.patch('/claims/:id/decision', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(decisionSchema, req.body);
  res.json({ success: true, data: await expenses.decide(actor(req), req.params.id, b.decision, b.note) });
}));
router.post('/claims/:id/reimburse', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(reimburseSchema, req.body);
  res.json({ success: true, data: await expenses.reimburse(actor(req), req.params.id, b.ref) });
}));

export default router;

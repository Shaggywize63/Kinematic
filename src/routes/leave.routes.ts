/**
 * Leave management + attendance regularization + approval flows.
 * Mounted at /api/v1/leave (requireAuth applied at mount).
 *
 *   Employee:  GET types|holidays|balances|requests, POST requests,
 *              PATCH requests/:id/cancel, POST/GET regularizations
 *   Approver:  GET requests/pending, PATCH requests/:id/decision, GET calendar,
 *              GET regularizations/pending, PATCH regularizations/:id/decision
 *   Admin:     POST/PATCH/DELETE types, POST/DELETE holidays
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireSupervisorOrAbove } from '../middleware/auth';
import { AuthRequest } from '../types';
import { AppError } from '../utils';
import * as leave from '../services/leave.service';
import * as reg from '../services/attendanceRegularization.service';

const router = Router();

function actor(req: AuthRequest): leave.Actor {
  const u = req.user as any;
  return { id: u.id, org_id: u.org_id, role: u.role, client_id: u.client_id ?? null };
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || 'Invalid input', 'VALIDATION');
  return r.data;
}
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const applySchema = z.object({
  leave_type_id: z.string().uuid(),
  from_date: dateStr, to_date: dateStr,
  half_day_start: z.boolean().optional(), half_day_end: z.boolean().optional(),
  reason: z.string().max(1000).optional(), contact_number: z.string().max(30).optional(),
  attachment_url: z.string().url().max(2048).optional(),
}).refine((b) => b.from_date <= b.to_date, { message: 'from_date must be on/before to_date', path: ['from_date'] });
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional() });
const typeSchema = z.object({
  name: z.string().min(1).max(80), code: z.string().max(20).optional().nullable(),
  is_paid: z.boolean().optional(), annual_quota: z.number().min(0).max(365).optional(),
  allow_half_day: z.boolean().optional(), max_carry_forward: z.number().min(0).max(365).optional(),
  requires_attachment: z.boolean().optional(), color: z.string().max(20).optional().nullable(),
  is_active: z.boolean().optional(), position: z.number().int().optional(),
});
const holidaySchema = z.object({ holiday_date: dateStr, name: z.string().min(1).max(120), is_optional: z.boolean().optional() });
const regSchema = z.object({
  att_date: dateStr,
  type: z.enum(['missing_checkin', 'missing_checkout', 'wrong_time', 'on_duty', 'wfh']),
  requested_checkin_at: z.string().datetime().optional(),
  requested_checkout_at: z.string().datetime().optional(),
  reason: z.string().max(1000).optional(),
});

// ── leave types ───────────────────────────────────────────────────────────
router.get('/types', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.listTypes(req.user!.org_id, (req.user as any).client_id ?? null) });
}));
router.post('/types', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.upsertType(actor(req), null, parse(typeSchema, req.body)) });
}));
router.patch('/types/:id', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.upsertType(actor(req), req.params.id, parse(typeSchema.partial(), req.body)) });
}));
router.delete('/types/:id', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  await leave.removeType(req.user!.org_id, req.params.id); res.json({ success: true });
}));

// ── holidays ──────────────────────────────────────────────────────────────
router.get('/holidays', asyncHandler<AuthRequest>(async (req, res) => {
  const year = req.query.year ? Number(req.query.year) : undefined;
  res.json({ success: true, data: await leave.listHolidays(req.user!.org_id, year) });
}));
router.post('/holidays', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.addHoliday(actor(req), parse(holidaySchema, req.body)) });
}));
router.delete('/holidays/:id', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  await leave.removeHoliday(req.user!.org_id, req.params.id); res.json({ success: true });
}));

// ── balances + my requests ────────────────────────────────────────────────
router.get('/balances', asyncHandler<AuthRequest>(async (req, res) => {
  const year = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear();
  res.json({ success: true, data: await leave.balances(req.user!.org_id, req.user!.id, (req.user as any).client_id ?? null, year) });
}));
router.get('/requests', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.myRequests(req.user!.org_id, req.user!.id) });
}));
router.post('/requests', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.applyLeave(actor(req), parse(applySchema, req.body)) });
}));
router.patch('/requests/:id/cancel', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.cancelLeave(actor(req), req.params.id) });
}));

// ── approver ──────────────────────────────────────────────────────────────
router.get('/requests/pending', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await leave.pendingForApprover(actor(req)) });
}));
router.patch('/requests/:id/decision', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(decisionSchema, req.body);
  res.json({ success: true, data: await leave.decide(actor(req), req.params.id, b.decision, b.note) });
}));
router.get('/calendar', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new AppError(400, 'from/to (YYYY-MM-DD) required', 'VALIDATION');
  res.json({ success: true, data: await leave.teamCalendar(actor(req), from, to) });
}));

// ── attendance regularization ─────────────────────────────────────────────
router.post('/regularizations', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await reg.create(actor(req), parse(regSchema, req.body)) });
}));
router.get('/regularizations', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await reg.myRequests(req.user!.org_id, req.user!.id) });
}));
router.get('/regularizations/pending', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await reg.pendingForApprover(actor(req)) });
}));
router.patch('/regularizations/:id/decision', requireSupervisorOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(decisionSchema, req.body);
  res.json({ success: true, data: await reg.decide(actor(req), req.params.id, b.decision, b.note) });
}));

export default router;

/**
 * Field Expense / Travel Claims. Mounted at /api/v1/expenses
 * (requireAuth + requireModule('field_expenses') applied at mount).
 *
 *   Everyone:  GET  policy                    the policy that governs you
 *              POST receipts                  upload a receipt photo (+ optional OCR)
 *              POST scan-receipt              OCR only (older clients)
 *              GET  mileage                   GPS-derived distance suggestion
 *              POST claims/check              what would the policy say about these lines?
 *              GET  claims[?status]           my claims
 *              GET  claims/:id                a claim with lines, receipts and trail
 *              POST claims · PATCH claims/:id · POST claims/:id/submit · PATCH claims/:id/cancel
 *   Approver:  GET  claims/pending            waiting on me
 *              GET  claims/all                everything I may see, filtered + paged
 *              GET  claims/summary            totals for the dashboard
 *              GET  claims/export             the same filters as a CSV
 *              PATCH claims/:id/decision      approve / reject (line by line if needed)
 *              POST claims/bulk-decision      decide many at once
 *   Admin:     PUT  policy                    (legacy single-policy editor)
 *              GET/POST/PUT/DELETE policies   many named policies, presets, assignment
 *              GET  claims/awaiting-reimbursement · POST claims/:id/reimburse
 *
 * Rejecting — a claim or a single line — always needs a remark.
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAdminOrAbove } from '../middleware/auth';
import { AuthRequest } from '../types';
import { AppError, isDemo } from '../utils';
import { currentProjectKey, runWithProject } from '../lib/projects';
import { getClientScope } from '../lib/tenancy';
import * as expenses from '../services/expenses/expenses.service';
import * as policies from '../services/expenses/policy.service';
import * as reports from '../services/expenses/claimReports.service';
import { uploadReceipt } from '../services/expenses/receipts.service';
import { scanReceipt, ReceiptMediaType } from '../services/expenses/receiptScan.service';

const router = Router();

function actor(req: AuthRequest): expenses.Actor {
  const u = req.user as any;
  // org_role_data_scope ('own' for field execs) lets the service deny approval
  // to reps who share the sub_admin role on flat field-force tenants (ByteBack).
  // The client comes from the JWT first, then X-Client-Id, so a super-admin
  // viewing a client manages that client's policies and claims.
  return { id: u.id, org_id: u.org_id, role: u.role, client_id: getClientScope(req).id ?? u.client_id ?? null, data_scope: u.org_role_data_scope ?? null };
}
// Returns the zod-validated body. Typed `any` because the repo isn't compiled with
// strictNullChecks, which makes z.infer mark every field optional; the services
// declare the real input types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(schema: z.ZodTypeAny, body: unknown): any {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || 'Invalid input', 'VALIDATION');
  return r.data;
}

// Who may reach the approver endpoints. Wider than the generic supervisor guard,
// which omitted manager / org_admin / hr — people the claim alerts already go to.
// What each may actually do is decided in the service (admin, or the claim's approver).
const APPROVER_ROLES = new Set(['super_admin', 'admin', 'main_admin', 'org_admin', 'sub_admin', 'client', 'city_manager', 'supervisor', 'manager', 'hr', 'program_manager']);
function requireApprover(req: Request, _res: Response, next: NextFunction) {
  const u = (req as AuthRequest).user;
  if (isDemo(u) || APPROVER_ROLES.has(String(u?.role ?? '').toLowerCase())) return next();
  return next(new AppError(403, 'Only approvers can do this', 'FORBIDDEN'));
}

/** A claim that a "block" policy refuses: report every reason, not just the first. */
function policyBlocked(res: Response, e: unknown): boolean {
  if (e instanceof expenses.PolicyBlockedError) {
    res.status(422).json({ success: false, error: e.message, code: e.code, violations: e.violations });
    return true;
  }
  return false;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const uuid = z.string().uuid();
const category = z.enum(['mileage', 'travel', 'food', 'lodging', 'fuel', 'toll', 'misc']);
const num = (max: number) => z.number().min(0).max(max);

const itemSchema = z.object({
  id: uuid.optional(),
  category,
  item_date: dateStr.optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  amount: num(10_000_000).optional().nullable(),
  distance_km: num(100_000).optional().nullable(),
  from_location: z.string().max(200).optional().nullable(),
  to_location: z.string().max(200).optional().nullable(),
  merchant: z.string().max(200).optional().nullable(),
  // Only web links or our own storage objects — never javascript: or data: URIs.
  receipt_url: z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), 'Receipt must be a web link').optional().nullable(),
  ai_extracted: z.any().optional(),
});
const createSchema = z.object({
  title: z.string().max(200).optional().nullable(),
  items: z.array(itemSchema).max(100).optional(),
});
const checkSchema = z.object({ items: z.array(itemSchema).max(100).optional(), claim_id: uuid.optional() });
const lineDecision = z.object({ id: uuid, decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional().nullable() });
const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).optional().nullable(),
  items: z.array(lineDecision).max(100).optional(),
});
const bulkSchema = z.object({ ids: z.array(uuid).min(1).max(100), decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional().nullable() });
const reimburseSchema = z.object({ ref: z.string().max(120).optional() });
const legacyPolicySchema = z.object({
  currency: z.string().max(8).optional(),
  mileage_rate: num(10_000).optional(),
  auto_approve_under: num(10_000_000).optional(),
  escalate_over: num(10_000_000).optional().nullable(),
  require_receipt_over: num(10_000_000).optional(),
  category_limits: z.record(z.string(), z.number().min(0)).optional().nullable(),
  is_active: z.boolean().optional(),
});
const catRule = z.object({
  enabled: z.boolean().optional(),
  per_day_limit: num(10_000_000).nullable().optional(),
  per_claim_limit: num(10_000_000).nullable().optional(),
  per_month_limit: num(10_000_000).nullable().optional(),
  receipt_required_over: num(10_000_000).nullable().optional(),
}).partial();
const policySchema = z.object({
  name: z.string().trim().min(1, 'Give the policy a name').max(80),
  description: z.string().max(500).nullable().optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  currency: z.string().max(8).optional(),
  applies_to: z.object({
    everyone: z.boolean().optional(),
    roles: z.array(z.string().max(60)).max(50).optional(),
    org_role_ids: z.array(uuid).max(50).optional(),
    user_ids: z.array(uuid).max(500).optional(),
  }).optional(),
  effective_from: dateStr.nullable().optional(),
  effective_to: dateStr.nullable().optional(),
  rules: z.object({
    mileage_rate: num(10_000).optional(),
    receipt_required_over: num(10_000_000).optional(),
    max_claim_amount: num(100_000_000).nullable().optional(),
    submit_within_days: z.number().int().min(0).max(3650).nullable().optional(),
    auto_approve_under: num(10_000_000).optional(),
    escalate_over: num(10_000_000).nullable().optional(),
    enforcement: z.enum(['flag', 'block']).optional(),
    categories: z.record(z.string(), catRule).optional(),
  }).optional(),
});
const policyPatchSchema = policySchema.partial();
const scanSchema = z.object({ image: z.string().min(16), media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional() });
const idParam = (req: Request) => {
  const id = req.params.id;
  if (!uuid.safeParse(id).success) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};

// ── the policy that governs me ──────────────────────────────────────────────
router.get('/policy', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.getMyPolicy(actor(req)) });
}));
router.put('/policy', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.saveDefaultPolicy(actor(req), parse(legacyPolicySchema, req.body)) });
}));

// ── policies (admin) — static paths first, then /:id ────────────────────────
router.get('/policies', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await policies.attachPeopleNames(actor(req), await policies.listPolicies(actor(req))) });
}));
router.get('/policies/presets', requireAdminOrAbove, asyncHandler<AuthRequest>(async (_req, res) => {
  res.json({ success: true, data: policies.policyPresets() });
}));
router.get('/policies/roles', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await policies.policyRoles(actor(req)) });
}));
router.get('/policies/people', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await policies.policyPeople(actor(req), String(req.query.q ?? '')) });
}));
router.post('/policies', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.status(201).json({ success: true, data: await policies.createPolicy(actor(req), parse(policySchema, req.body)) });
}));
router.get('/policies/:id', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: (await policies.attachPeopleNames(actor(req), [await policies.getPolicyById(actor(req), idParam(req))]))[0] });
}));
router.put('/policies/:id', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await policies.updatePolicy(actor(req), idParam(req), parse(policyPatchSchema, req.body)) });
}));
router.post('/policies/:id/duplicate', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.status(201).json({ success: true, data: await policies.duplicatePolicy(actor(req), idParam(req)) });
}));
router.delete('/policies/:id', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await policies.deletePolicy(actor(req), idParam(req)) });
}));

// ── mileage suggestion (from the GPS trail) ─────────────────────────────────
router.get('/mileage', asyncHandler<AuthRequest>(async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!from || !to) throw new AppError(400, 'from/to (ISO timestamps) required', 'VALIDATION');
  const forUser = req.query.user_id ? String(req.query.user_id) : undefined;
  res.json({ success: true, data: await expenses.mileageSuggestion(actor(req), from, to, forUser) });
}));

// ── receipts ────────────────────────────────────────────────────────────────
const uploadAny = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).any();
/** multer finishes inside a stream callback where the per-request project
 *  (AsyncLocalStorage) is gone — without re-entering it the handler would fall
 *  back to the default project's database and storage. Same fix as finance. */
const withFile = (req: Request, res: Response, next: NextFunction) => {
  const project = currentProjectKey();
  uploadAny(req, res, (err: unknown) => runWithProject(project, () => {
    if (!err) return next();
    const e = err as { code?: string; message?: string };
    return next(new AppError(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400, e.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB' : (e.message || 'Upload failed'), 'UPLOAD'));
  }));
};
router.post('/receipts', withFile, asyncHandler<AuthRequest>(async (req, res) => {
  const file = (req.files as Express.Multer.File[] | undefined)?.[0];
  if (!file) throw new AppError(400, 'Attach the receipt as a file', 'NO_FILE');
  const scan = String(req.query.scan ?? '1') !== '0';
  res.status(201).json({ success: true, data: await uploadReceipt(actor(req), file, { scan }) });
}));
// OCR only — what older app builds call. Kept for compatibility.
router.post('/scan-receipt', asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(scanSchema, req.body);
  res.json({ success: true, data: await scanReceipt(b.image, (b.media_type as ReceiptMediaType) || 'image/jpeg') });
}));

// ── approver queue and reports (declared before /claims/:id) ────────────────
router.get('/claims/pending', requireApprover, asyncHandler<AuthRequest>(async (req, res) => {
  const city = req.query.city ? String(req.query.city) : undefined;
  res.json({ success: true, data: await expenses.pendingForApprover(actor(req), city) });
}));
router.get('/claims/awaiting-reimbursement', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  const city = req.query.city ? String(req.query.city) : undefined;
  res.json({ success: true, data: await expenses.awaitingReimbursement(actor(req), city) });
}));
const filtersOf = (req: Request): reports.ClaimFilters => {
  const q = req.query;
  const s = (k: string) => (q[k] ? String(q[k]) : undefined);
  return { status: s('status'), user_id: s('user_id'), from: s('from'), to: s('to'), category: s('category'), policy_id: s('policy_id'),
    q: s('q'), city: s('city'), page: Number(q.page) || undefined, limit: Number(q.limit) || undefined };
};
router.get('/claims/all', requireApprover, asyncHandler<AuthRequest>(async (req, res) => {
  const r = await reports.listAllClaims(actor(req), filtersOf(req));
  res.json({ success: true, data: r.rows, pagination: { total: r.total, page: r.page, limit: r.limit } });
}));
router.get('/claims/summary', requireApprover, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await reports.claimsSummary(actor(req), filtersOf(req)) });
}));
router.get('/claims/export', requireApprover, asyncHandler<AuthRequest>(async (req, res) => {
  const csv = await reports.claimsCsv(actor(req), filtersOf(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="expense-claims-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(csv);
}));
router.post('/claims/check', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.checkClaim(actor(req), parse(checkSchema, req.body)) });
}));
router.post('/claims/bulk-decision', requireApprover, asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(bulkSchema, req.body);
  res.json({ success: true, data: await expenses.bulkDecide(actor(req), b.ids, b.decision, b.note) });
}));

// ── claims (the claimant) ───────────────────────────────────────────────────
router.get('/claims', asyncHandler<AuthRequest>(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json({ success: true, data: await expenses.listMyClaims(actor(req), status) });
}));
router.get('/claims/:id', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.getClaim(actor(req), idParam(req)) });
}));
router.post('/claims', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.createClaim(actor(req), parse(createSchema, req.body)) });
}));
// Edit a claim's title/lines before it is approved (draft, submitted or rejected).
router.patch('/claims/:id', asyncHandler<AuthRequest>(async (req, res) => {
  try {
    res.json({ success: true, data: await expenses.updateClaim(actor(req), idParam(req), parse(createSchema, req.body)) });
  } catch (e) { if (!policyBlocked(res, e)) throw e; }
}));
router.post('/claims/:id/submit', asyncHandler<AuthRequest>(async (req, res) => {
  try {
    res.json({ success: true, data: await expenses.submitClaim(actor(req), idParam(req)) });
  } catch (e) { if (!policyBlocked(res, e)) throw e; }
}));
router.patch('/claims/:id/cancel', asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.cancelClaim(actor(req), idParam(req)) });
}));

// ── decisions ───────────────────────────────────────────────────────────────
router.patch('/claims/:id/decision', requireApprover, asyncHandler<AuthRequest>(async (req, res) => {
  res.json({ success: true, data: await expenses.decide(actor(req), idParam(req), parse(decisionSchema, req.body)) });
}));
router.post('/claims/:id/reimburse', requireAdminOrAbove, asyncHandler<AuthRequest>(async (req, res) => {
  const b = parse(reimburseSchema, req.body);
  res.json({ success: true, data: await expenses.reimburse(actor(req), idParam(req), b.ref) });
}));

export default router;

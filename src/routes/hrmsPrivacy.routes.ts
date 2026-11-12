/**
 * HRMS phase 5 (Privacy/DPDP + Compliance on the server) — mounted by hrms.routes.ts at /api/v1/hrms/privacy, so it sits behind
 * requireAuth + requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the caller's own org
 * with client_id NULL (X-Client-Id ignored), `{ success, data }` responses, no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables
 * are missing, and HRMS's own error handler.
 *
 *   GET    bootstrap                                 { compliance_tasks, consents, retention_rules, server_time }
 *   POST   compliance | PUT|DELETE compliance/:id    create (idempotent on a client `id`) / partial update (markFiled = set filed_on) / delete
 *                                                     the response row carries NO `status` (the dashboard derives it)
 *   POST   consents | PUT|DELETE consents/:id        create / partial update (withdraw = set withdrawn_at) / delete
 *   POST   retention | PUT|DELETE retention/:id       create / partial update / delete
 *
 * The access log is read through the EXISTING GET /hrms/access-log (phase 1) — it is deliberately not duplicated here.
 * Refusals are 400 (validation) or 404 (not found) with `{ success: false, error: <plain reason>, code }`.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import {
  complianceCreate, complianceUpdate, consentCreate, consentUpdate, retentionCreate, retentionUpdate,
} from '../services/hrms/privacy5/schemas';
import { privacyBootstrap } from '../services/hrms/privacy5/bootstrap.service';
import * as compliance from '../services/hrms/privacy5/compliance.service';
import * as consents from '../services/hrms/privacy5/consents.service';
import * as retention from '../services/hrms/privacy5/retention.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};
const send = (res: Response, created: boolean, data: unknown) => res.status(created ? 201 : 200).json(data);

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await privacyBootstrap(scopeOf(req))); }));

// ── compliance tasks ──────────────────────────────────────────────────────────
router.post('/compliance', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await compliance.createCompliance(scopeOf(req), parse(complianceCreate, body(req)));
  send(res, created, row);
}));
router.put('/compliance/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await compliance.updateCompliance(scopeOf(req), idParam(req), parse(complianceUpdate, body(req))));
}));
router.delete('/compliance/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await compliance.deleteCompliance(scopeOf(req), idParam(req)));
}));

// ── consent records ─────────────────────────────────────────────────────────
router.post('/consents', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await consents.createConsent(scopeOf(req), parse(consentCreate, body(req)));
  send(res, created, row);
}));
router.put('/consents/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await consents.updateConsent(scopeOf(req), idParam(req), parse(consentUpdate, body(req))));
}));
router.delete('/consents/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await consents.deleteConsent(scopeOf(req), idParam(req)));
}));

// ── retention rules ───────────────────────────────────────────────────────────
router.post('/retention', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await retention.createRetention(scopeOf(req), parse(retentionCreate, body(req)));
  send(res, created, row);
}));
router.put('/retention/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await retention.updateRetention(scopeOf(req), idParam(req), parse(retentionUpdate, body(req))));
}));
router.delete('/retention/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await retention.deleteRetention(scopeOf(req), idParam(req)));
}));

export default router;

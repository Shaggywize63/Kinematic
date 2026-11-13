/**
 * HRMS phase 7 (the Benefits module on the server) — mounted by hrms.routes.ts at /api/v1/hrms/benefits, so it sits
 * behind requireAuth + requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating),
 * the caller's own org with client_id NULL (X-Client-Id ignored), `{ success, data }` responses, no-store, 1 MB bodies,
 * 503 HRMS_NOT_READY while the tables are missing, and HRMS's own error handler.
 *
 *   GET    bootstrap                     { plans, enrolments, claims, window, reminders, sent, server_time }
 *   POST   plans | plans/:id             create a plan (idempotent on the id); the empty-state "Add the standard plans"
 *   PUT    plans/:id                     partial update
 *   DELETE plans/:id                     delete
 *   POST   enrolments                    submitEnrolment: upsert by employee (eligibility + dependant-rule validation)
 *   DELETE enrolments/:employeeId        clear a person's enrolment
 *   POST   claims                        registerClaim: assign the TPA ref, initial trail -> { claim }
 *   POST   claims/:id/move               moveClaim: the CLAIM_NEXT state machine, atomic -> { claim }
 *   PUT    window                        set opens/closes -> { window }
 *   POST   window/extend                 extendWindow { days, reason } -> { window }
 *   POST   reminders                     logReminders { employee_ids } -> { reminders, count }
 *   POST   send-to-payroll               sendToPayroll { month } -> { removed, added, total }
 *
 * Refusals are 409 (CLAIM_STATE illegal claim transition / RUN_LOCKED frozen-or-paid run), 400 VALIDATION (eligibility,
 * dependant rules, approved/rejected amounts, enum/date), 404 NOT_FOUND, 503 HRMS_NOT_READY, with the dashboard's words.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import {
  claimCreate, claimMove, enrolmentBody, planBody, planUpdate, remindersBody, sendToPayrollBody, windowBody, windowExtendBody,
} from '../services/hrms/benefits/schemas';
import { benefitsBootstrap } from '../services/hrms/benefits/bootstrap.service';
import * as plans from '../services/hrms/benefits/plans.service';
import * as enrolments from '../services/hrms/benefits/enrolments.service';
import * as claims from '../services/hrms/benefits/claims.service';
import * as config from '../services/hrms/benefits/config.service';
import { sendToPayroll } from '../services/hrms/benefits/payroll.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await benefitsBootstrap(scopeOf(req))); }));

// ── plans ─────────────────────────────────────────────────────────────────────
router.post('/plans', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await plans.createPlan(scopeOf(req), parse(planBody, body(req)));
  res.status(created ? 201 : 200).json(row);
}));
router.post('/plans/:id', asyncHandler(async (req: Request, res: Response) => {
  const data = parse(planBody, body(req));
  data.id = idParam(req);
  const { row, created } = await plans.createPlan(scopeOf(req), data);
  res.status(created ? 201 : 200).json(row);
}));
router.put('/plans/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await plans.updatePlan(scopeOf(req), idParam(req), parse(planUpdate, body(req))));
}));
router.delete('/plans/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await plans.deletePlan(scopeOf(req), idParam(req)));
}));

// ── enrolments ──────────────────────────────────────────────────────────────
router.post('/enrolments', asyncHandler(async (req: Request, res: Response) => {
  res.json(await enrolments.submitEnrolment(scopeOf(req), parse(enrolmentBody, body(req))));
}));
router.delete('/enrolments/:employeeId', asyncHandler(async (req: Request, res: Response) => {
  res.json(await enrolments.deleteEnrolment(scopeOf(req), idParam(req, 'employeeId')));
}));

// ── claims ────────────────────────────────────────────────────────────────────
router.post('/claims', asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ claim: await claims.registerClaim(scopeOf(req), parse(claimCreate, body(req))) });
}));
router.post('/claims/:id/move', asyncHandler(async (req: Request, res: Response) => {
  res.json(await claims.moveClaim(scopeOf(req), idParam(req), parse(claimMove, body(req))));
}));

// ── window + reminders ────────────────────────────────────────────────────────
router.put('/window', asyncHandler(async (req: Request, res: Response) => {
  res.json(await config.setWindow(scopeOf(req), parse(windowBody, body(req))));
}));
router.post('/window/extend', asyncHandler(async (req: Request, res: Response) => {
  res.json(await config.extendWindow(scopeOf(req), parse(windowExtendBody, body(req))));
}));
router.post('/reminders', asyncHandler(async (req: Request, res: Response) => {
  const { employee_ids } = parse(remindersBody, body(req));
  res.json(await config.logReminders(scopeOf(req), employee_ids ?? []));
}));

// ── send to payroll ────────────────────────────────────────────────────────────
router.post('/send-to-payroll', asyncHandler(async (req: Request, res: Response) => {
  const { month } = parse(sendToPayrollBody, body(req));
  res.json(await sendToPayroll(scopeOf(req), month));
}));

export default router;

/**
 * HRMS phase 4 (Lifecycle + Letters on the server) — mounted by hrms.routes.ts at /api/v1/hrms/lifecycle, so it sits behind requireAuth +
 * requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the caller's own org with client_id
 * NULL (X-Client-Id ignored), `{ success, data }` responses, no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables are missing, and
 * HRMS's own error handler.
 *
 *   GET    bootstrap                              { onboarding_cases, exit_cases, letter_templates, issued_letters, server_time }
 *   POST   onboarding | PUT|DELETE onboarding/:id   create (idempotent on a client `id`) / partial update / delete
 *   POST   exits | PUT|DELETE exits/:id             create / partial update / delete; moving stage to 'closed' is refused 409 EXIT_BLOCKED
 *                                                   while a clearance item is not done or the employee's F&F case is not paid
 *   POST   letter-templates | PUT|DELETE letter-templates/:id   create / update / delete
 *   POST   letters | PUT|DELETE letters/:id         issue / update (mainly `signed`) / delete
 *
 * This endpoint does NOT create employees (the dashboard creates the draft employee through the phase-1 endpoint, then the onboarding
 * case here) and does NOT change F&F maths/endpoints (it only reads hrms_fnf_cases to enforce the close blocker).
 * Refusals are 409 (state) or 400 (validation) with `{ success: false, error: <the dashboard's plain reason>, code }`.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import {
  exitCreate, exitUpdate, letterCreate, letterTemplateCreate, letterTemplateUpdate, letterUpdate, onboardingCreate, onboardingUpdate,
} from '../services/hrms/lifecycle/schemas';
import { lifecycleBootstrap } from '../services/hrms/lifecycle/bootstrap.service';
import * as onboarding from '../services/hrms/lifecycle/onboarding.service';
import * as exits from '../services/hrms/lifecycle/exits.service';
import * as templates from '../services/hrms/lifecycle/letterTemplates.service';
import * as letters from '../services/hrms/lifecycle/letters.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};
const send = (res: Response, created: boolean, data: unknown) => res.status(created ? 201 : 200).json(data);

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await lifecycleBootstrap(scopeOf(req))); }));

// ── onboarding cases ──────────────────────────────────────────────────────────
router.post('/onboarding', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await onboarding.createOnboarding(scopeOf(req), parse(onboardingCreate, body(req)));
  send(res, created, row);
}));
router.put('/onboarding/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await onboarding.updateOnboarding(scopeOf(req), idParam(req), parse(onboardingUpdate, body(req))));
}));
router.delete('/onboarding/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await onboarding.deleteOnboarding(scopeOf(req), idParam(req)));
}));

// ── exit cases ────────────────────────────────────────────────────────────────
router.post('/exits', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await exits.createExit(scopeOf(req), parse(exitCreate, body(req)));
  send(res, created, row);
}));
router.put('/exits/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await exits.updateExit(scopeOf(req), idParam(req), parse(exitUpdate, body(req))));
}));
router.delete('/exits/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await exits.deleteExit(scopeOf(req), idParam(req)));
}));

// ── letter templates ────────────────────────────────────────────────────────
router.post('/letter-templates', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await templates.createLetterTemplate(scopeOf(req), parse(letterTemplateCreate, body(req)));
  send(res, created, row);
}));
router.put('/letter-templates/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await templates.updateLetterTemplate(scopeOf(req), idParam(req), parse(letterTemplateUpdate, body(req))));
}));
router.delete('/letter-templates/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await templates.deleteLetterTemplate(scopeOf(req), idParam(req)));
}));

// ── issued letters ────────────────────────────────────────────────────────────
router.post('/letters', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await letters.createLetter(scopeOf(req), parse(letterCreate, body(req)));
  send(res, created, row);
}));
router.put('/letters/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await letters.updateLetter(scopeOf(req), idParam(req), parse(letterUpdate, body(req))));
}));
router.delete('/letters/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await letters.deleteLetter(scopeOf(req), idParam(req)));
}));

export default router;

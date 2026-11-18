/**
 * HRMS phase 9 (Timesheets on the server) — mounted by hrms.routes.ts at /api/v1/hrms/timesheets, so it sits behind
 * requireAuth + requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the
 * caller's own org with client_id NULL (X-Client-Id ignored), no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables
 * are missing, and HRMS's own error handler.
 *
 *   GET    bootstrap                                   { policy, tracked_ids, projects, sheets, today, server_time }
 *   POST   projects                                    create { id?, name, client?, kind, billable, budget_hours?, prior_hours?, rate? }
 *   PUT    projects/:id                                edit / archive { name?, client?, kind?, billable?, budget_hours?, prior_hours?, rate?, archived? }
 *   PUT    policy                                      the company limits { max_per_day?, weekly_cap?, standard_week? } -> settings
 *   PUT    tracked                                     who tracks time { employee_ids } -> settings
 *   PUT    sheets/:employeeId/:weekStart               save a draft / returned week's lines { lines: [{ projectId, hours[7] }] } -> sheet
 *   POST   sheets/:employeeId/:weekStart/submit        draft | returned -> submitted (the dashboard's submitCheck) -> sheet
 *   POST   sheets/:employeeId/:weekStart/decide        submitted -> approved | returned { decision, comment } -> sheet
 *
 * Refusals are 400 VALIDATION with the dashboard's words ("This week is locked.", "Enter some hours before submitting.",
 * "Mon: use steps of 0.25 hour.", the limit ranges, "Say what to fix when returning a week ..."), 404 NOT_FOUND (unknown
 * employee or project), 503 HRMS_NOT_READY.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import { linesSet, policySet, projectCreate, projectUpdate, sheetDecide, trackedSet } from '../services/hrms/timesheets/schemas';
import { timesheetsBootstrap } from '../services/hrms/timesheets/bootstrap.service';
import * as projects from '../services/hrms/timesheets/projects.service';
import * as config from '../services/hrms/timesheets/config.service';
import * as sheets from '../services/hrms/timesheets/sheets.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const weekParam = (req: Request) => {
  const w = String(req.params.weekStart ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w)) throw new AppError(400, 'Choose the Monday a week starts on.', 'VALIDATION');
  return w;
};
const body = (req: Request) => req.body ?? {};

router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await timesheetsBootstrap(scopeOf(req))); }));

// ── projects ─────────────────────────────────────────────────────────────────
router.post('/projects', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await projects.createProject(scopeOf(req), parse(projectCreate, body(req)));
  res.status(created ? 201 : 200).json(row);
}));
router.put('/projects/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await projects.updateProject(scopeOf(req), idParam(req), parse(projectUpdate, body(req))));
}));

// ── settings ─────────────────────────────────────────────────────────────────
router.put('/policy', asyncHandler(async (req: Request, res: Response) => {
  res.json(await config.setPolicy(scopeOf(req), parse(policySet, body(req))));
}));
router.put('/tracked', asyncHandler(async (req: Request, res: Response) => {
  res.json(await config.setTracked(scopeOf(req), parse(trackedSet, body(req)).employee_ids));
}));

// ── weeks ────────────────────────────────────────────────────────────────────
router.put('/sheets/:employeeId/:weekStart', asyncHandler(async (req: Request, res: Response) => {
  const { lines } = parse(linesSet, body(req));
  res.json(await sheets.saveLines(scopeOf(req), idParam(req, 'employeeId'), weekParam(req), lines));
}));
router.post('/sheets/:employeeId/:weekStart/submit', asyncHandler(async (req: Request, res: Response) => {
  res.json(await sheets.submit(scopeOf(req), idParam(req, 'employeeId'), weekParam(req)));
}));
router.post('/sheets/:employeeId/:weekStart/decide', asyncHandler(async (req: Request, res: Response) => {
  const { decision, comment } = parse(sheetDecide, body(req));
  res.json(await sheets.decide(scopeOf(req), idParam(req, 'employeeId'), weekParam(req), decision, comment));
}));

export default router;

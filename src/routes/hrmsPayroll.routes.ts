/**
 * HRMS phase 2 (payroll on the server) — mounted by hrms.routes.ts at /api/v1/hrms/payroll, so it sits behind requireAuth +
 * requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the caller's own org with client_id
 * NULL (X-Client-Id ignored), `{ success, data }` responses, no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables are missing,
 * and HRMS's own error handler (which never logs a request body).
 *
 *   GET    bootstrap?months=12                 structures, attendance, adjustments, loans, runs (with payslips), fnf_cases, settings
 *   POST   structures | PUT|DELETE structures/:id
 *   PUT    attendance/:employeeId/:month       { lop_days?, overtime_hours?, present_days?, paid_leave_days?, weekly_offs?, holidays?, locked? }
 *   POST   adjustments | PUT|DELETE adjustments/:id
 *   POST   loans | PUT|DELETE loans/:id
 *   POST   runs { entity_id, month, type? }    idempotent: the existing run comes back with 200
 *   GET    runs?entity_id=&month=&status=&type=   without payslips (payslips: [] and payslip_count)
 *   GET    runs/:id                            with payslips
 *   POST   runs/:id/compute | freeze | unfreeze { reason } | mark-paid     each answers with the full run
 *   GET    runs/:id/checks | ecr | bank-file   (?format=csv for the bank file)
 *   POST   fnf | PUT|DELETE fnf/:id | GET fnf/:id/compute | POST fnf/:id/approve | mark-paid
 *   PUT    settings/payroll                    { overtime_rule }
 *
 * Refusals are 409 (state) or 400 (validation) with `{ success: false, error: <the dashboard's plain reason>, code }`.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { perRouteLimit } from '../middleware/security';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import {
  adjustmentCreate, adjustmentUpdate, attendancePatch, fnfCreate, fnfUpdate, loanCreate, loanUpdate, monthsQuery, payrollSettingsBody, runCreate, runQuery,
  structureCreate, structureUpdate, unfreezeBody,
} from '../services/hrms/payroll/schemas';
import { monthParam } from '../services/hrms/payroll/common';
import { payrollBootstrap } from '../services/hrms/payroll/bootstrap.service';
import * as structures from '../services/hrms/payroll/structures.service';
import * as attendance from '../services/hrms/payroll/attendance.service';
import * as adjustments from '../services/hrms/payroll/adjustments.service';
import * as loans from '../services/hrms/payroll/loans.service';
import * as runs from '../services/hrms/payroll/runs.service';
import * as fnf from '../services/hrms/payroll/fnf.service';
import * as settings from '../services/hrms/payroll/settings.service';
import { bankFileName, buildRunBankFile, toCsv } from '../services/hrms/payroll/bankfile.service';

const router = Router();
const inTest = () => process.env.NODE_ENV === 'test';

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};
const send = (res: Response, created: boolean, data: unknown) => res.status(created ? 201 : 200).json(data);

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => {
  const months = parse(monthsQuery, req.query.months === undefined ? 12 : req.query.months);
  res.json(await payrollBootstrap(scopeOf(req), months));
}));

// ── salary structures ───────────────────────────────────────────────────────
router.post('/structures', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await structures.createStructure(scopeOf(req), parse(structureCreate, body(req)));
  send(res, created, row);
}));
router.put('/structures/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await structures.updateStructure(scopeOf(req), idParam(req), parse(structureUpdate, body(req))));
}));
router.delete('/structures/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await structures.deleteStructure(scopeOf(req), idParam(req)));
}));

// ── attendance inputs ───────────────────────────────────────────────────────
router.put('/attendance/:employeeId/:month', asyncHandler(async (req: Request, res: Response) => {
  const employeeId = idParam(req, 'employeeId');
  const month = monthParam(req.params.month);
  res.json(await attendance.setAttendance(scopeOf(req), employeeId, month, parse(attendancePatch, body(req))));
}));

// ── adjustments ─────────────────────────────────────────────────────────────
router.post('/adjustments', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await adjustments.createAdjustment(scopeOf(req), parse(adjustmentCreate, body(req)));
  send(res, created, row);
}));
router.put('/adjustments/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await adjustments.updateAdjustment(scopeOf(req), idParam(req), parse(adjustmentUpdate, body(req))));
}));
router.delete('/adjustments/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await adjustments.deleteAdjustment(scopeOf(req), idParam(req)));
}));

// ── loans and advances ──────────────────────────────────────────────────────
router.post('/loans', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await loans.createLoan(scopeOf(req), parse(loanCreate, body(req)));
  send(res, created, row);
}));
router.put('/loans/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await loans.updateLoan(scopeOf(req), idParam(req), parse(loanUpdate, body(req))));
}));
router.delete('/loans/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await loans.deleteLoan(scopeOf(req), idParam(req)));
}));

// ── pay runs ────────────────────────────────────────────────────────────────
router.get('/runs', asyncHandler(async (req: Request, res: Response) => {
  const filter = parse(runQuery, {
    entity_id: req.query.entity_id, month: req.query.month, status: req.query.status, type: req.query.type,
  });
  res.json(await runs.listRuns(scopeOf(req), filter));
}));
router.post('/runs', asyncHandler(async (req: Request, res: Response) => {
  const { run, created } = await runs.createRun(scopeOf(req), parse(runCreate, body(req)));
  send(res, created, run);
}));
router.get('/runs/:id', asyncHandler(async (req: Request, res: Response) => { res.json(await runs.getRun(scopeOf(req), idParam(req))); }));
router.post('/runs/:id/compute', asyncHandler(async (req: Request, res: Response) => { res.json(await runs.computeRun(scopeOf(req), idParam(req))); }));
router.post('/runs/:id/freeze', asyncHandler(async (req: Request, res: Response) => { res.json(await runs.freezeRun(scopeOf(req), idParam(req))); }));
router.post('/runs/:id/unfreeze', asyncHandler(async (req: Request, res: Response) => {
  res.json(await runs.unfreezeRun(scopeOf(req), idParam(req), parse(unfreezeBody, body(req)).reason));
}));
router.post('/runs/:id/mark-paid', asyncHandler(async (req: Request, res: Response) => { res.json(await runs.markRunPaid(scopeOf(req), idParam(req))); }));
router.get('/runs/:id/checks', asyncHandler(async (req: Request, res: Response) => { res.json(await runs.runChecks(scopeOf(req), idParam(req))); }));
router.get('/runs/:id/ecr', asyncHandler(async (req: Request, res: Response) => { res.json(await runs.runEcr(scopeOf(req), idParam(req))); }));

// The bank file holds full account numbers: throttled like a reveal, written to the access log on every call, never cached.
router.get('/runs/:id/bank-file', perRouteLimit({ windowMs: 60_000, max: 30, skip: inTest }), asyncHandler(async (req: Request, res: Response) => {
  const { file, entityName, month } = await buildRunBankFile(scopeOf(req), idParam(req));
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${bankFileName(entityName, month)}"`);
    res.status(200).send(toCsv(file.header, file.rows));
    return;
  }
  res.json(file);
}));

// ── full and final ──────────────────────────────────────────────────────────
router.post('/fnf', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await fnf.createFnf(scopeOf(req), parse(fnfCreate, body(req)));
  send(res, created, row);
}));
router.put('/fnf/:id', asyncHandler(async (req: Request, res: Response) => { res.json(await fnf.updateFnf(scopeOf(req), idParam(req), parse(fnfUpdate, body(req)))); }));
router.get('/fnf/:id/compute', asyncHandler(async (req: Request, res: Response) => { res.json(await fnf.computeFnfFor(scopeOf(req), idParam(req))); }));
router.post('/fnf/:id/approve', asyncHandler(async (req: Request, res: Response) => { res.json(await fnf.approveFnf(scopeOf(req), idParam(req))); }));
router.post('/fnf/:id/mark-paid', asyncHandler(async (req: Request, res: Response) => { res.json(await fnf.markFnfPaid(scopeOf(req), idParam(req))); }));
router.delete('/fnf/:id', asyncHandler(async (req: Request, res: Response) => { res.json(await fnf.deleteFnf(scopeOf(req), idParam(req))); }));

// ── settings ────────────────────────────────────────────────────────────────
const saveSettings = asyncHandler(async (req: Request, res: Response) => {
  res.json(await settings.setPayrollSettings(scopeOf(req), parse(payrollSettingsBody, body(req)).overtime_rule));
});
router.put('/settings/payroll', saveSettings);
router.put('/settings', saveSettings);

export default router;

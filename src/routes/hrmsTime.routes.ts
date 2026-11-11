/**
 * HRMS phase 3 (Time & Leave on the server) — mounted by hrms.routes.ts at /api/v1/hrms/time, so it sits behind requireAuth +
 * requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the caller's own org with client_id
 * NULL (X-Client-Id ignored), `{ success, data }` responses, no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables are missing,
 * and HRMS's own error handler.
 *
 *   GET    bootstrap                         { shifts, roster, leave_types, holiday_lists, leave_balances, server_time }
 *   POST   shifts | PUT|DELETE shifts/:id    (409 IN_USE while an employee's shift_id or a roster day references it)
 *   POST   leave-types | PUT|DELETE leave-types/:id   (409 IN_USE while a balance references it)
 *   POST   holiday-lists | PUT|DELETE holiday-lists/:id (409 IN_USE while a location uses it)
 *   PUT    balances/:employeeId/:leaveTypeId  upsert the five numbers (all >= 0)
 *   PUT    roster/:employeeId/:weekStart      upsert one week-row { days } (week_start a Monday; each cell a shift id or 'off')
 *
 * Refusals are 409 (state) or 400 (validation) with `{ success: false, error: <the dashboard's plain reason>, code }`.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import {
  balancePut, holidayListCreate, holidayListUpdate, leaveTypeCreate, leaveTypeUpdate, rosterPut, shiftCreate, shiftUpdate,
} from '../services/hrms/time/schemas';
import { timeBootstrap } from '../services/hrms/time/bootstrap.service';
import * as shifts from '../services/hrms/time/shifts.service';
import * as leaveTypes from '../services/hrms/time/leaveTypes.service';
import * as holidayLists from '../services/hrms/time/holidayLists.service';
import * as balances from '../services/hrms/time/balances.service';
import * as roster from '../services/hrms/time/roster.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};
const send = (res: Response, created: boolean, data: unknown) => res.status(created ? 201 : 200).json(data);

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await timeBootstrap(scopeOf(req))); }));

// ── shifts ──────────────────────────────────────────────────────────────────
router.post('/shifts', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await shifts.createShift(scopeOf(req), parse(shiftCreate, body(req)));
  send(res, created, row);
}));
router.put('/shifts/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await shifts.updateShift(scopeOf(req), idParam(req), parse(shiftUpdate, body(req))));
}));
router.delete('/shifts/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await shifts.deleteShift(scopeOf(req), idParam(req)));
}));

// ── leave types ───────────────────────────────────────────────────────────────
router.post('/leave-types', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await leaveTypes.createLeaveType(scopeOf(req), parse(leaveTypeCreate, body(req)));
  send(res, created, row);
}));
router.put('/leave-types/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await leaveTypes.updateLeaveType(scopeOf(req), idParam(req), parse(leaveTypeUpdate, body(req))));
}));
router.delete('/leave-types/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await leaveTypes.deleteLeaveType(scopeOf(req), idParam(req)));
}));

// ── holiday lists ─────────────────────────────────────────────────────────────
router.post('/holiday-lists', asyncHandler(async (req: Request, res: Response) => {
  const { row, created } = await holidayLists.createHolidayList(scopeOf(req), parse(holidayListCreate, body(req)));
  send(res, created, row);
}));
router.put('/holiday-lists/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await holidayLists.updateHolidayList(scopeOf(req), idParam(req), parse(holidayListUpdate, body(req))));
}));
router.delete('/holiday-lists/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await holidayLists.deleteHolidayList(scopeOf(req), idParam(req)));
}));

// ── leave balances ────────────────────────────────────────────────────────────
router.put('/balances/:employeeId/:leaveTypeId', asyncHandler(async (req: Request, res: Response) => {
  res.json(await balances.putBalance(scopeOf(req), idParam(req, 'employeeId'), idParam(req, 'leaveTypeId'), parse(balancePut, body(req))));
}));

// ── roster ────────────────────────────────────────────────────────────────────
router.put('/roster/:employeeId/:weekStart', asyncHandler(async (req: Request, res: Response) => {
  const { days } = parse(rosterPut, body(req));
  res.json(await roster.putRoster(scopeOf(req), idParam(req, 'employeeId'), req.params.weekStart, days));
}));

export default router;

/**
 * HRMS phase 8 (the Compensation module on the server) — mounted by hrms.routes.ts at /api/v1/hrms/compensation, so it
 * sits behind requireAuth + requireHrmsAccess and inherits the phase 1 rules: master admin only (never while
 * impersonating), the caller's own org with client_id NULL (X-Client-Id ignored), no-store, 1 MB bodies, 503
 * HRMS_NOT_READY while the tables are missing, and HRMS's own error handler. It is the third slice of the Rewards area,
 * after assets (phase 6) and benefits (phase 7).
 *
 *   GET    bootstrap                         { bands, perf, perf_notes, cycle, server_time }
 *   POST   bands                             create a grade band { grade, min, mid, max, market, published? }
 *   POST   bands/seed                        the empty-state "Add the standard pay bands" -> { bands, created }
 *   PUT    bands/:grade                      saveBand { min, mid, max, market }
 *   PUT    bands/:grade/published            setPublished { published }
 *   PUT    perf/:employeeId                  setPerf { band }
 *   PUT    perf/:employeeId/reply            setPerfReply { reply }
 *   PUT    cycle                             set { name?, effective_on?, budget_pct? } (cycle must be open) -> cycle
 *   PUT    cycle/guidelines                  setGuideline { perf, zone, min, max } (cycle must be open) -> cycle
 *   PUT    cycle/proposals/:employeeId       setProposal { pct (0..50 or null), reason? } (cycle must be open) -> cycle
 *   POST   cycle/submit                      draft|returned -> submitted (reproduces cycleBlockers) -> cycle
 *   POST   cycle/decide                      submitted -> approved|returned { decision, note?, over_budget? } -> cycle
 *   POST   cycle/reopen                      approved -> draft (only when no increment is applied yet) -> cycle
 *   POST   cycle/applied/:employeeId         recordApplied { from, to, letter_id } (atomic, cycle must be approved) -> cycle
 *
 * The CTC change and the increment letter are written by the caller through the already-server-backed core
 * (PUT /hrms/employees/:id) and lifecycle (letters) endpoints BEFORE cycle/applied is posted, exactly as the dashboard's
 * apply.ts orders it — this module only RECORDS the issued increment (the same split as benefits' send-to-payroll).
 * Refusals are 400 VALIDATION (band / guideline shapes, cycle locked, "Enter at least one proposed increment.", over
 * budget, 0..50 percent, "...already issued..."), 404 NOT_FOUND (no band for a grade, unknown employee), 503
 * HRMS_NOT_READY, with the dashboard's words.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import {
  appliedRecord, bandCreate, bandPublish, bandSave, cycleDecide, cycleUpdate, guidelineSet, perfReply, perfSet, proposalSet,
} from '../services/hrms/compensation/schemas';
import type { CompaZone, PerfBand } from '../services/hrms/compensation/engine';
import { compensationBootstrap } from '../services/hrms/compensation/bootstrap.service';
import * as bands from '../services/hrms/compensation/bands.service';
import * as perf from '../services/hrms/compensation/perf.service';
import * as cycle from '../services/hrms/compensation/cycle.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};
/** A band grade from the path: 1..40 non-blank characters (bands are keyed by grade, not a uuid). */
const gradeParam = (req: Request): string => {
  const g = String(req.params.grade ?? '').trim();
  if (!g || g.length > 40) throw new AppError(400, 'Invalid grade', 'VALIDATION');
  return g;
};

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await compensationBootstrap(scopeOf(req))); }));

// ── bands ─────────────────────────────────────────────────────────────────────
router.post('/bands', asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(await bands.createBand(scopeOf(req), parse(bandCreate, body(req))));
}));
router.post('/bands/seed', asyncHandler(async (req: Request, res: Response) => {
  res.json(await bands.seedStandard(scopeOf(req)));
}));
router.put('/bands/:grade', asyncHandler(async (req: Request, res: Response) => {
  res.json(await bands.saveBand(scopeOf(req), gradeParam(req), parse(bandSave, body(req))));
}));
router.put('/bands/:grade/published', asyncHandler(async (req: Request, res: Response) => {
  const { published } = parse(bandPublish, body(req));
  res.json(await bands.setPublished(scopeOf(req), gradeParam(req), published));
}));

// ── performance ─────────────────────────────────────────────────────────────────
router.put('/perf/:employeeId', asyncHandler(async (req: Request, res: Response) => {
  const { band } = parse(perfSet, body(req));
  res.json(await perf.setPerf(scopeOf(req), idParam(req, 'employeeId'), band));
}));
router.put('/perf/:employeeId/reply', asyncHandler(async (req: Request, res: Response) => {
  const { reply } = parse(perfReply, body(req));
  res.json(await perf.setPerfReply(scopeOf(req), idParam(req, 'employeeId'), reply));
}));

// ── merit cycle ─────────────────────────────────────────────────────────────────
router.put('/cycle', asyncHandler(async (req: Request, res: Response) => {
  res.json(await cycle.updateCycle(scopeOf(req), parse(cycleUpdate, body(req))));
}));
router.put('/cycle/guidelines', asyncHandler(async (req: Request, res: Response) => {
  const g = parse(guidelineSet, body(req));
  res.json(await cycle.setGuideline(scopeOf(req), { perf: g.perf as PerfBand, zone: g.zone as CompaZone, min: g.min, max: g.max }));
}));
router.put('/cycle/proposals/:employeeId', asyncHandler(async (req: Request, res: Response) => {
  const { pct, reason } = parse(proposalSet, body(req));
  res.json(await cycle.setProposal(scopeOf(req), idParam(req, 'employeeId'), pct, reason ?? undefined));
}));
router.post('/cycle/submit', asyncHandler(async (req: Request, res: Response) => { res.json(await cycle.submitCycle(scopeOf(req))); }));
router.post('/cycle/decide', asyncHandler(async (req: Request, res: Response) => {
  res.json(await cycle.decideCycle(scopeOf(req), parse(cycleDecide, body(req))));
}));
router.post('/cycle/reopen', asyncHandler(async (req: Request, res: Response) => { res.json(await cycle.reopenCycle(scopeOf(req))); }));
router.post('/cycle/applied/:employeeId', asyncHandler(async (req: Request, res: Response) => {
  res.json(await cycle.recordApplied(scopeOf(req), idParam(req, 'employeeId'), parse(appliedRecord, body(req))));
}));

export default router;

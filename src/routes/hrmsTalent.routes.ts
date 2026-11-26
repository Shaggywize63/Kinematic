/**
 * HRMS phase 12 (Talent on the server) — mounted by hrms.routes.ts at /api/v1/hrms/talent, so it sits behind requireAuth +
 * requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the caller's own org
 * with client_id NULL (X-Client-Id ignored), no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables are missing, and
 * HRMS's own error handler.
 *
 *   GET    bootstrap                              { skills, requirements, ratings, roles, placements, cycle, log, today, server_time }
 *   POST   ratings                                set/clear a skill rating { employee_id, skill_id, level, note?, assessor? }
 *   POST   roles/:id/successors                   add a successor { employee_id, readiness, actions?, reason } -> role
 *   POST   roles/:id/successors/remove            remove a successor { employee_id, reason } -> role
 *   POST   roles/:id/successors/readiness         change readiness { employee_id, readiness, reason } -> role
 *   POST   placements                             place on the 9-box { employee_id, performance, potential, rationale }
 *   POST   placements/remove                      clear a 9-box placement { employee_id }
 *   POST   review-opened                          log that the named talent-review view was opened { group? }
 *
 * On the first bootstrap the service seeds a populated demo (the 12-skill catalogue + a talent picture generated against
 * the org's real employees / designations). Refusals are 400 VALIDATION with the dashboard's words ("Pick a level from 0
 * to 4.", "Unknown skill.", "Give a short reason (at least 5 characters)...", "This person is already on the bench for this
 * role.", "This person is not on the bench.", "That is already the readiness shown.", "Write a rationale of at least 10
 * characters..."), 404 NOT_FOUND ("Unknown role."), 503 HRMS_NOT_READY.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import { addSuccessor as addSuccessorSchema, clearPlacement as clearPlacementSchema, placeEmployee as placeEmployeeSchema, reviewOpened as reviewOpenedSchema, setRating as setRatingSchema, setReadiness as setReadinessSchema, successorRef as successorRefSchema } from '../services/hrms/talent/schemas';
import * as talent from '../services/hrms/talent/talent.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};

router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await talent.talentBootstrap(scopeOf(req))); }));

// ── skills ─────────────────────────────────────────────────────────────────────
router.post('/ratings', asyncHandler(async (req: Request, res: Response) => {
  const { employee_id, skill_id, level, note, assessor } = parse(setRatingSchema, body(req));
  res.json(await talent.setRating(scopeOf(req), employee_id, skill_id, level, note ?? '', assessor));
}));

// ── succession ───────────────────────────────────────────────────────────────
router.post('/roles/:id/successors', asyncHandler(async (req: Request, res: Response) => {
  const { employee_id, readiness, actions, reason } = parse(addSuccessorSchema, body(req));
  res.json(await talent.addSuccessor(scopeOf(req), idParam(req), employee_id, readiness, actions ?? [], reason ?? ''));
}));
router.post('/roles/:id/successors/remove', asyncHandler(async (req: Request, res: Response) => {
  const { employee_id, reason } = parse(successorRefSchema, body(req));
  res.json(await talent.removeSuccessor(scopeOf(req), idParam(req), employee_id, reason ?? ''));
}));
router.post('/roles/:id/successors/readiness', asyncHandler(async (req: Request, res: Response) => {
  const { employee_id, readiness, reason } = parse(setReadinessSchema, body(req));
  res.json(await talent.setReadiness(scopeOf(req), idParam(req), employee_id, readiness, reason ?? ''));
}));

// ── 9-box ──────────────────────────────────────────────────────────────────────
router.post('/placements', asyncHandler(async (req: Request, res: Response) => {
  const { employee_id, performance, potential, rationale } = parse(placeEmployeeSchema, body(req));
  res.json(await talent.placeEmployee(scopeOf(req), employee_id, performance, potential, rationale ?? ''));
}));
router.post('/placements/remove', asyncHandler(async (req: Request, res: Response) => {
  const { employee_id } = parse(clearPlacementSchema, body(req));
  res.json(await talent.clearPlacement(scopeOf(req), employee_id));
}));

// ── review audit ───────────────────────────────────────────────────────────────
router.post('/review-opened', asyncHandler(async (req: Request, res: Response) => {
  res.json(await talent.logReviewOpened(scopeOf(req), parse(reviewOpenedSchema, body(req)).group));
}));

export default router;

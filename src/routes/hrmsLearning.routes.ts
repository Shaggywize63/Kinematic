/**
 * HRMS phase 10 (Learning on the server) — mounted by hrms.routes.ts at /api/v1/hrms/learning, so it sits behind
 * requireAuth + requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the
 * caller's own org with client_id NULL (X-Client-Id ignored), no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables
 * are missing, and HRMS's own error handler.
 *
 *   GET    bootstrap                          { courses, assignments, certificates, reminders, log, today, server_time }
 *   POST   library                            add the standard courses the org does not have yet -> { added, courses }
 *   PUT    courses/:id/rules                  who it is for { mandatory, audience, refresher_months } -> course
 *   POST   courses/:id/assign                 give it to people { employee_ids, due_on? } -> { created, skipped, assignments }
 *   POST   rules/apply                        create what the mandatory rules call for -> { created, assignments }
 *   POST   assignments/:id/lesson             finish the next lesson { steps_done? } -> assignment
 *   POST   assignments/:id/quiz               mark the answers { answers } -> { result, assignment, certificate }
 *   POST   assignments/:id/remind             log a reminder (nothing is sent) -> reminder
 *   POST   certificates/:number/refresher     assign a refresher for a lapsing certificate -> assignment
 *
 * Refusals are 400 VALIDATION with the dashboard's words ("Pick at least one person.", "Pick a due date that is today or
 * later.", "The refresher interval is between 0 and 60 months. ...", "Answer all 3 questions to submit.", "This course is
 * already completed.", "A refresher is already assigned."), 404 NOT_FOUND, 503 HRMS_NOT_READY.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import { assignSet, lessonDone, quizAnswers, rulesSet } from '../services/hrms/learning/schemas';
import * as learning from '../services/hrms/learning/learning.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const certParam = (req: Request) => {
  const n = String(req.params.number ?? '');
  if (!/^CERT-\d{4}-\d{4,}$/.test(n)) throw new AppError(400, 'Invalid certificate number', 'VALIDATION');
  return n;
};
const body = (req: Request) => req.body ?? {};

router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await learning.learningBootstrap(scopeOf(req))); }));

// ── catalogue ────────────────────────────────────────────────────────────────
router.post('/library', asyncHandler(async (req: Request, res: Response) => { res.json(await learning.loadLibrary(scopeOf(req))); }));
router.put('/courses/:id/rules', asyncHandler(async (req: Request, res: Response) => {
  res.json(await learning.updateRules(scopeOf(req), idParam(req), parse(rulesSet, body(req))));
}));

// ── assigning ────────────────────────────────────────────────────────────────
router.post('/courses/:id/assign', asyncHandler(async (req: Request, res: Response) => {
  const { employee_ids, due_on } = parse(assignSet, body(req));
  res.json(await learning.assignCourse(scopeOf(req), idParam(req), employee_ids, due_on));
}));
router.post('/rules/apply', asyncHandler(async (req: Request, res: Response) => { res.json(await learning.applyRules(scopeOf(req))); }));

// ── taking a course ──────────────────────────────────────────────────────────
router.post('/assignments/:id/lesson', asyncHandler(async (req: Request, res: Response) => {
  res.json(await learning.completeLesson(scopeOf(req), idParam(req), parse(lessonDone, body(req)).steps_done));
}));
router.post('/assignments/:id/quiz', asyncHandler(async (req: Request, res: Response) => {
  res.json(await learning.submitQuiz(scopeOf(req), idParam(req), parse(quizAnswers, body(req)).answers));
}));

// ── follow-up ────────────────────────────────────────────────────────────────
router.post('/assignments/:id/remind', asyncHandler(async (req: Request, res: Response) => { res.json(await learning.remind(scopeOf(req), idParam(req))); }));
router.post('/certificates/:number/refresher', asyncHandler(async (req: Request, res: Response) => {
  res.json(await learning.assignRefresher(scopeOf(req), certParam(req)));
}));

export default router;

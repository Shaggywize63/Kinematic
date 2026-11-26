/**
 * HRMS phase 11 (Engagement on the server) — mounted by hrms.routes.ts at /api/v1/hrms/engagement, so it sits behind
 * requireAuth + requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the
 * caller's own org with client_id NULL (X-Client-Id ignored), no-store, 1 MB bodies, 503 HRMS_NOT_READY while the tables
 * are missing, and HRMS's own error handler.
 *
 *   GET    bootstrap                     { values, surveys, responses, kudos, exit_interviews, log, today, server_time }
 *   POST   surveys                       send a pulse { title, questions[{text,type}] } -> survey
 *   POST   surveys/:id/close             close a pulse -> survey
 *   POST   surveys/:id/responses         add an anonymous, team-level response { team_id, answers } -> response
 *   POST   kudos                         post recognition { to_id, value_id, message } -> kudos
 *   POST   exit-interviews               record a completed exit interview { exit_id?, employee_id?, label?, reasons, would_return, text? } -> exit_interview
 *   POST   exit-interviews/opened        log that an individual exit record was opened { employee_id? } -> log entry
 *
 * Refusals are 400 VALIDATION with the dashboard's words ("Give the pulse a name.", "This pulse is closed.", "Answer at
 * least one question.", "Pick who you are thanking.", "Say what they did, in at least 10 characters.", "Pick at least one
 * reason.", "This interview is already complete."), 404 NOT_FOUND ("Unknown pulse."), 503 HRMS_NOT_READY.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import { completeExit, giveKudos as giveKudosSchema, openExit, sendPulse as sendPulseSchema, submitResponse as submitResponseSchema } from '../services/hrms/engagement/schemas';
import * as engagement from '../services/hrms/engagement/engagement.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};

router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await engagement.engagementBootstrap(scopeOf(req))); }));

// ── pulses ───────────────────────────────────────────────────────────────────
router.post('/surveys', asyncHandler(async (req: Request, res: Response) => {
  const { title, questions } = parse(sendPulseSchema, body(req));
  res.json(await engagement.sendPulse(scopeOf(req), title, questions));
}));
router.post('/surveys/:id/close', asyncHandler(async (req: Request, res: Response) => { res.json(await engagement.closeSurvey(scopeOf(req), idParam(req))); }));
router.post('/surveys/:id/responses', asyncHandler(async (req: Request, res: Response) => {
  const { team_id, answers } = parse(submitResponseSchema, body(req));
  res.json(await engagement.submitResponse(scopeOf(req), idParam(req), team_id, answers));
}));

// ── recognition ────────────────────────────────────────────────────────────────
router.post('/kudos', asyncHandler(async (req: Request, res: Response) => {
  const { to_id, value_id, message } = parse(giveKudosSchema, body(req));
  res.json(await engagement.giveKudos(scopeOf(req), to_id, value_id, message));
}));

// ── exit interviews ──────────────────────────────────────────────────────────
router.post('/exit-interviews', asyncHandler(async (req: Request, res: Response) => {
  res.json(await engagement.completeExitInterview(scopeOf(req), parse(completeExit, body(req))));
}));
router.post('/exit-interviews/opened', asyncHandler(async (req: Request, res: Response) => {
  res.json((await engagement.openExitRecord(scopeOf(req), parse(openExit, body(req)).employee_id)) ?? {});
}));

export default router;

/**
 * Public agent endpoints for the Kinematic Tally Connector bridge agent
 * (Windows utility running alongside Tally on the distributor's PC).
 *
 * Mounted at /api/v1/integrations/tally BEFORE the global requireAuth
 * middleware in app.ts, mirroring the WhatsApp + lead-source webhook
 * pattern. Authentication is per-integration via `?key=<agent_secret>`
 * (constant-time compared in the controller).
 */
import { Router } from 'express';
import { perRouteLimit } from '../middleware/security';
import { agentFetchJobs, agentReportResult } from '../controllers/distribution/integrations.controller';

const router = Router();

// 120 polls/min/IP. Default cadence is 30s = 2 polls/min, so this is
// 60× headroom — generous for retries after backoff, tight enough to
// stop a runaway agent from DDoS'ing the API.
const limit = perRouteLimit({ windowMs: 60_000, max: 120 });

router.get('/jobs/:id',          limit, agentFetchJobs);
router.post('/jobs/:id/result',  limit, agentReportResult);

export default router;

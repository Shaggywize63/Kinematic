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
import { agentPair, agentProfile, agentMasters, agentCommandResult } from '../controllers/distribution/tally-onboarding.controller';

const router = Router();

// 120 polls/min/IP. Default cadence is 30s = 2 polls/min, so this is
// 60× headroom — generous for retries after backoff, tight enough to
// stop a runaway agent from DDoS'ing the API.
const limit = perRouteLimit({ windowMs: 60_000, max: 120 });

// Pairing is unauthenticated by nature (the code IS the credential), so it gets a
// much tighter limit: 6 chars of a 31-letter alphabet, single use, 24h life.
const pairLimit = perRouteLimit({ windowMs: 60_000, max: 10 });
// Where the dashboard's "Download for Windows" button points. The build is produced by
// .github/workflows/tally-agent-build.yml; set TALLY_AGENT_DOWNLOAD_URL to wherever it is hosted.
router.get('/agent/download', limit, (_req, res) => {
  const target = process.env.TALLY_AGENT_DOWNLOAD_URL;
  if (!target || !/^https:\/\//.test(target)) { res.status(404).json({ ok: false, error: 'The connector download is not configured yet.' }); return; }
  res.redirect(302, target);
});
router.post('/pair',                   pairLimit, agentPair);
router.post('/jobs/:id/profile',        limit, agentProfile);
router.post('/jobs/:id/masters',        limit, agentMasters);
router.post('/jobs/:id/command-result', limit, agentCommandResult);
router.get('/jobs/:id',          limit, agentFetchJobs);
router.post('/jobs/:id/result',  limit, agentReportResult);

export default router;

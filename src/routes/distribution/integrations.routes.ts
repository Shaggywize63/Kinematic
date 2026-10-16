/**
 * Authenticated admin CRUD for distribution integrations. Mounted at
 * /api/v1/distribution/integrations AFTER requireAuth in app.ts.
 */
import { Router } from 'express';
import { requireAdminOrAbove } from '../../middleware/auth';
import {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  listIntegrationEvents,
  getEventXml,
} from '../../controllers/distribution/integrations.controller';
import {
  createPairingCode, getHealth, createMissingLedgers, requestMasterPull, listMasters, actOnMasters,
} from '../../controllers/distribution/tally-onboarding.controller';

const router = Router();

// Integration config + the Tally bridge-agent credentials are admin-only (same
// gate the other distribution admin routes use). The bridge agent itself does NOT
// come through here — it authenticates with its own agent key on the public
// /api/v1/integrations/tally/* routes (tally-agent-public.routes.ts).
router.use(requireAdminOrAbove);

router.get('/',                       listIntegrations);
router.post('/',                      createIntegration);
router.get('/:id',                    getIntegration);
router.patch('/:id',                  updateIntegration);
router.delete('/:id',                 deleteIntegration);
router.post('/:id/pairing-code',      createPairingCode);
router.get('/:id/health',             getHealth);
router.post('/:id/create-ledgers',    createMissingLedgers);
router.post('/:id/pull-masters',      requestMasterPull);
router.get('/:id/masters',            listMasters);
router.post('/:id/masters/act',       actOnMasters);
router.get('/:id/events',             listIntegrationEvents);
// Manual XML download (admin fallback when the bridge agent isn't running).
router.get('/events/:eventId/xml',    getEventXml);

export default router;

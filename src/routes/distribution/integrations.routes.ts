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
router.get('/:id/events',             listIntegrationEvents);
// Manual XML download (admin fallback when the bridge agent isn't running).
router.get('/events/:eventId/xml',    getEventXml);

export default router;

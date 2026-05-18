/**
 * Authenticated admin CRUD for distribution integrations. Mounted at
 * /api/v1/distribution/integrations AFTER requireAuth in app.ts.
 */
import { Router } from 'express';
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

router.get('/',                       listIntegrations);
router.post('/',                      createIntegration);
router.get('/:id',                    getIntegration);
router.patch('/:id',                  updateIntegration);
router.delete('/:id',                 deleteIntegration);
router.get('/:id/events',             listIntegrationEvents);
// Manual XML download (admin fallback when the bridge agent isn't running).
router.get('/events/:eventId/xml',    getEventXml);

export default router;

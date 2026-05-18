/**
 * Authenticated CRUD on lead-source integrations. Mounted at
 * /api/v1/integrations AFTER the global requireAuth middleware in app.ts.
 */
import { Router } from 'express';
import {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  listIntegrationEvents,
  testIntegration,
} from '../controllers/crm/integrations.controller';

const router = Router();

router.get('/',               listIntegrations);
router.post('/',              createIntegration);
router.get('/:id',            getIntegration);
router.patch('/:id',          updateIntegration);
router.delete('/:id',         deleteIntegration);
router.get('/:id/events',     listIntegrationEvents);
router.post('/:id/test',      testIntegration);

export default router;

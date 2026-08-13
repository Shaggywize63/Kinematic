import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/ai.controller';
import { requireAdminOrAbove } from '../../middleware/auth';

// Distribution AI layer — agents config, replenishment agent, conversational
// control tower. Org-scoped in each handler; changing an agent is an admin act.
const router = Router();
router.get('/agents', ctrl.getAgents);
router.post('/agents', requireAdminOrAbove, ctrl.saveAgent);
router.get('/replenishment', ctrl.replenishment);
router.post('/replenishment/approve', requireAdminOrAbove, ctrl.approveReplenishment);
router.get('/draft-orders', ctrl.listDraftOrders);
router.get('/draft-orders/:id/outlets', ctrl.listDraftOutlets);
router.post('/draft-orders/:id/dismiss', requireAdminOrAbove, ctrl.dismissDraftOrder);
router.post('/draft-orders/:id/place', requireAdminOrAbove, ctrl.placeDraftOrderHandler);
router.get('/coverage', ctrl.coverage);
router.get('/anomalies', ctrl.anomalies);
router.post('/ask', ctrl.ask);
export default router;

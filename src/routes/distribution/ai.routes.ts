import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/ai.controller';
import { requireAdminOrAbove } from '../../middleware/auth';

// Distribution AI layer — agents config, replenishment agent, conversational
// control tower. Org-scoped in each handler; changing an agent is an admin act.
const router = Router();
router.get('/agents', ctrl.getAgents);
router.post('/agents', requireAdminOrAbove, ctrl.saveAgent);
router.get('/replenishment', ctrl.replenishment);
router.post('/ask', ctrl.ask);
export default router;

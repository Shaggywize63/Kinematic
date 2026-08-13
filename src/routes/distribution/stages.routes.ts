import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/stages.controller';
import { requireAdminOrAbove } from '../../middleware/auth';

// Configurable route-to-market stages (Network Setup). Read for anyone with the
// distribution module; rewrite is an admin action.
const router = Router();
router.get('/', ctrl.getStages);
router.post('/', requireAdminOrAbove, ctrl.saveStages);
export default router;

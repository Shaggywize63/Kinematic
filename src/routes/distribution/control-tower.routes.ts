import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/control-tower.controller';

// Redesigned distribution overview — read-only, org-scoped in the handler.
const router = Router();
router.get('/', ctrl.controlTower);
export default router;

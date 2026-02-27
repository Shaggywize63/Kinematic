import { Router } from 'express';
import * as ctrl from '../controllers/sos.controller';
import { requireAuth, requireSupervisorOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/trigger',            ctrl.trigger);
router.get('/',                    requireSupervisorOrAbove, ctrl.getAlerts);
router.patch('/:id/acknowledge',   requireSupervisorOrAbove, ctrl.acknowledge);
router.patch('/:id/resolve',       requireSupervisorOrAbove, ctrl.resolve);

export default router;

import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/returns.controller';
import { requireSupervisorOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.post('/', idempotency, ctrl.create);                     // FE creates
router.post('/:id/approve', requireSupervisorOrAbove, idempotency, ctrl.approve);
router.post('/:id/reject',  requireSupervisorOrAbove, idempotency, ctrl.reject);
export default router;

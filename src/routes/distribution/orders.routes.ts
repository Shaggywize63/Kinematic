import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/orders.controller';
import { requireSupervisorOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
// Admin-side / dashboard order management
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/:id/approve', requireSupervisorOrAbove, idempotency, ctrl.approve);
router.post('/:id/cancel', idempotency, ctrl.cancel);
export default router;

import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/dispatches.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.post('/', requireAdminOrAbove, idempotency, ctrl.create);
router.post('/:id/eway-bill', requireAdminOrAbove, idempotency, ctrl.attachEwayBill);
router.post('/:id/mark-out',  requireAdminOrAbove, idempotency, ctrl.markOut);
export default router;

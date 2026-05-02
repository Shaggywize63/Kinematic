import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/payments.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.post('/', idempotency, ctrl.create);   // FE can record payments
router.post('/:id/status', requireAdminOrAbove, idempotency, ctrl.updateStatus);
export default router;

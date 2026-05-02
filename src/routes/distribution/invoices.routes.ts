import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/invoices.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireAdminOrAbove, idempotency, ctrl.issue);
router.post('/:id/cancel', requireAdminOrAbove, idempotency, ctrl.cancel);
export default router;

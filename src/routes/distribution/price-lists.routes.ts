import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/price-lists.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireAdminOrAbove, idempotency, ctrl.create);
router.post('/:id/items:bulk', requireAdminOrAbove, idempotency, ctrl.bulkAddItems);
router.post('/:id/activate', requireAdminOrAbove, idempotency, ctrl.activate);
export default router;

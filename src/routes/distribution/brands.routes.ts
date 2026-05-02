import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/brands.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireAdminOrAbove, idempotency, ctrl.create);
router.patch('/:id', requireAdminOrAbove, idempotency, ctrl.update);
router.delete('/:id', requireAdminOrAbove, idempotency, ctrl.remove);
export default router;

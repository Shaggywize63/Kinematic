import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/schemes.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireAdminOrAbove, idempotency, ctrl.create);
router.post('/:id/deactivate', requireAdminOrAbove, idempotency, ctrl.deactivate);
router.post('/preview', ctrl.preview);
export default router;

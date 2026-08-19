import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/damage.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();

// Distributor damaged / expiry register. Logging is open to any authed user;
// confirming (which writes off on-hand) and rejecting are admin-only.
router.get('/', ctrl.list);
router.post('/', idempotency, ctrl.create);
router.post('/:id/confirm', requireAdminOrAbove, ctrl.confirm);
router.post('/:id/reject', requireAdminOrAbove, ctrl.reject);

export default router;

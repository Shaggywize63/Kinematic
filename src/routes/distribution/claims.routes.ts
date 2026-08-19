import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/claims.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();

// NOTE: /summary must precede /:id so it isn't captured as an id.
router.get('/summary', ctrl.summary);
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', idempotency, ctrl.create);
router.post('/:id/status', requireAdminOrAbove, ctrl.updateStatus);
router.post('/:id/settle', requireAdminOrAbove, idempotency, ctrl.settle);

export default router;

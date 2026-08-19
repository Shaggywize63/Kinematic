import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/van.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();

// Van load-in / load-out (dashboard admin surface). Reps use /salesman/van-load.
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', idempotency, ctrl.create);
router.post('/:id/reconcile', idempotency, ctrl.reconcile);
router.post('/:id/close', requireAdminOrAbove, ctrl.close);

export default router;

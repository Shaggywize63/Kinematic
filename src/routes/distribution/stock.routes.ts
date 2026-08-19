import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/stock.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();

// Distributor on-hand stock + movement ledger.
router.get('/', ctrl.list);
router.get('/movements', ctrl.movements);
router.post('/adjust', requireAdminOrAbove, idempotency, ctrl.adjust);

export default router;

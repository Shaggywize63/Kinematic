import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/secondary-sales.controller';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.post('/', idempotency, ctrl.create);
export default router;

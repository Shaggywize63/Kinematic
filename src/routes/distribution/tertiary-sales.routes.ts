import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/tertiary-sales.controller';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.get('/', ctrl.list);
router.post('/', idempotency, ctrl.create);
export default router;

import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/deliveries.controller';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.post('/', idempotency, ctrl.create);
export default router;

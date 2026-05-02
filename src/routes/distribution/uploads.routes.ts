import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/uploads.controller';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
router.post('/sign', idempotency, ctrl.sign);
export default router;

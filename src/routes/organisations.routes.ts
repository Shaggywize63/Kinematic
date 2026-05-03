import { Router } from 'express';
import * as ctrl from '../controllers/organisations.controller';
import { idempotency } from '../middleware/idempotency';

const router = Router();
router.get('/me', ctrl.me);
router.patch('/me', idempotency, ctrl.update);
export default router;

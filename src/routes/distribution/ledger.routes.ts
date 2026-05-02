import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/ledger.controller';

const router = Router();
router.get('/', ctrl.list);
router.get('/ageing', ctrl.ageing);
export default router;

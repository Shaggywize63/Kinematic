import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/gstin.controller';

const router = Router();
router.get('/states', ctrl.states);
router.post('/verify', ctrl.verify);
export default router;

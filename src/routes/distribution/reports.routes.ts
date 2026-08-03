import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/reports.controller';

// PMC DELTA distribution reports. Read-only; org-scoped in each handler.
const router = Router();
router.get('/godown', ctrl.godownReport);
router.get('/targets', ctrl.targetReport);
router.get('/dsr', ctrl.dsrReport);
export default router;

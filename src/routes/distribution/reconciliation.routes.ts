import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/reconciliation.controller';

const router = Router();

// Read-only primary↔secondary reconciliation for a period.
router.get('/', ctrl.reconcile);

export default router;

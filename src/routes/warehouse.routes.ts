import { Router } from 'express';
import * as ctrl from '../controllers/warehouse.controller';
import { requireAuth, requireSupervisorOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth, requireSupervisorOrAbove);

router.get('/summary', ctrl.getWarehouseSummary);
router.get('/inventory', ctrl.getWarehouseInventory);

export default router;


import { Router } from 'express';
import * as ctrl from '../controllers/stock.controller';
import { requireAuth, requireAdminOrAbove, requireSupervisorOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/my',           ctrl.getMyAllocation);
router.post('/allocate',    requireAdminOrAbove, ctrl.allocate);
router.patch('/items/:id',  ctrl.reviewItem);
router.get('/team',         requireSupervisorOrAbove, ctrl.getTeamAllocations);

export default router;

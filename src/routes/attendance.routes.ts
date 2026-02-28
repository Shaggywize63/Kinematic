import { Router } from 'express';
import * as ctrl from '../controllers/attendance.controller';
import { requireAuth, requireSupervisorOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/checkin',      ctrl.checkin);
router.post('/checkout',     ctrl.checkout);
router.post('/break/start',  ctrl.startBreak);
router.post('/break/end',    ctrl.endBreak);
router.get('/today',         ctrl.getToday);
router.get('/history',       ctrl.getHistory);
router.get('/team',          requireSupervisorOrAbove, ctrl.getTeamToday);

export default router;

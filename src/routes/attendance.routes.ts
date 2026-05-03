import { Router } from 'express';
import * as ctrl from '../controllers/attendance.controller';
import { requireAuth, requireSupervisorOrAbove } from '../middleware/auth';
import { cacheGet } from '../utils/cache';

const router = Router();

router.use(requireAuth);

router.post('/checkin',      ctrl.checkin);
router.post('/checkout',     ctrl.checkout);
router.post('/break/start',  ctrl.startBreak);
router.post('/break/end',    ctrl.endBreak);
// 15s private cache on /today lets the dashboard SWR layer + mobile clients
// 304 instead of pulling the full JSON on every poll.
router.get('/today',         cacheGet(15), ctrl.getToday);
router.get('/history',       cacheGet(60), ctrl.getHistory);
router.get('/team',          requireSupervisorOrAbove, cacheGet(20), ctrl.getTeamToday);
router.post('/override',      requireSupervisorOrAbove, ctrl.overrideAttendance);
router.patch('/:id/override', requireSupervisorOrAbove, ctrl.updateAttendanceOverride);
export default router;


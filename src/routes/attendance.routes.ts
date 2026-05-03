import { Router } from 'express';
import * as ctrl from '../controllers/attendance.controller';
import { requireAuth, requireSupervisorOrAbove } from '../middleware/auth';
import { cacheGet } from '../utils/cache';
import { idempotency } from '../middleware/idempotency';

const router = Router();

router.use(requireAuth);

// Mutating endpoints accept Idempotency-Key so the mobile clients can safely
// retry an offline-queued check-in without ending up with phantom records.
// The (user_id, date) UNIQUE constraint already provides a backstop, but the
// explicit replay returns the original response body byte-for-byte.
router.post('/checkin',      idempotency, ctrl.checkin);
router.post('/checkout',     idempotency, ctrl.checkout);
router.post('/break/start',  idempotency, ctrl.startBreak);
router.post('/break/end',    idempotency, ctrl.endBreak);
// 15s private cache on /today lets the dashboard SWR layer + mobile clients
// 304 instead of pulling the full JSON on every poll.
router.get('/today',         cacheGet(15), ctrl.getToday);
router.get('/history',       cacheGet(60), ctrl.getHistory);
router.get('/team',          requireSupervisorOrAbove, cacheGet(20), ctrl.getTeamToday);
router.post('/override',      requireSupervisorOrAbove, ctrl.overrideAttendance);
router.patch('/:id/override', requireSupervisorOrAbove, ctrl.updateAttendanceOverride);
export default router;


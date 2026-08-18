import { Router } from 'express';
import * as ctrl from '../controllers/attendance.controller';
import * as faceCtrl from '../controllers/attendance/faceAttendance.controller';
import { requireAuth, requireSupervisorOrAbove, requireModule } from '../middleware/auth';
import { cacheGet } from '../utils/cache';
import { idempotency } from '../middleware/idempotency';

const router = Router();

router.use(requireAuth);

// ── Face-recognition attendance (per-client toggle: module 'face_attendance').
// OFF by default; a master admin enables it per client from the Clients page.
// The device enrols a reference face, then matches on-device at check-in and
// sends {face_score, face_verified, face_model_id} on the normal /checkin body.
router.post('/face/enroll',       requireModule('face_attendance'), faceCtrl.enrollFace);
router.get('/face/enrollment',    requireModule('face_attendance'), faceCtrl.getFaceEnrollment);
router.get('/face/status',        requireModule('face_attendance'), faceCtrl.getFaceStatus);
router.delete('/face/enrollment', requireModule('face_attendance'), faceCtrl.clearFaceEnrollment);
router.get('/face/team-status',   requireSupervisorOrAbove, requireModule('face_attendance'), faceCtrl.getTeamFaceStatus);

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


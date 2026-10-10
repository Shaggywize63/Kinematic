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
// Per-client attendance rules (shift times, late grace, weekly off, offline
// check-in) — read-only for any authenticated user. The admin write lives at
// PATCH /org-settings/attendance-rules. Registered before the parameterised
// `/:id/override` route (a different method, but keep fixed paths first).
router.get('/rules',         ctrl.getAttendanceRules);
// Per-user present/late/half-day/on-leave/absent counts for a date range.
// Open to any authenticated user: managers get their team (same scope as /team),
// a rep only ever gets themself.
router.get('/summary',       ctrl.getAttendanceSummary);
// Distance travelled on a day (check-in → forms → check-out legs, GPS trail with a straight-line
// fallback). Any authenticated user for themself; someone else's needs manager/admin team scope.
router.get('/travel',        ctrl.getTravel);
// Daily travel report (shift, mode of transport, km, visits, halts, route) — built from the same
// travel service. A rep gets only themself; a manager their team (same scope as /team). Static paths,
// registered before the parameterised `/:id/override` route.
router.get('/daily-report',      ctrl.getDailyReport);
router.get('/daily-report/team', requireSupervisorOrAbove, ctrl.getDailyReportTeam);
// The caller's own mode of transport for a day (opt-in per client: rule track_transport_mode).
router.patch('/transport-mode',  ctrl.setTransportMode);
router.post('/override',      requireSupervisorOrAbove, ctrl.overrideAttendance);
router.patch('/:id/override', requireSupervisorOrAbove, ctrl.updateAttendanceOverride);
export default router;


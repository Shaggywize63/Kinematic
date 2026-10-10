import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getLocationPingInterval,
  setLocationPingInterval,
  getCrmReminderThresholds,
  setCrmReminderThresholds,
  getUiFlags,
  setUserLimit,
  getScmDispatchConsumeMode,
  setScmDispatchConsumeMode,
  getAttendanceRules,
  setAttendanceRules,
} from '../controllers/org-settings.controller';

const router = Router();

// Admins only — both surfaces affect every user's experience (FE
// battery + CRM rep noise levels), so we keep them behind the same
// RBAC gate as user management.
const ADMIN_ROLES = ['admin', 'super_admin', 'main_admin', 'sub_admin', 'hr', 'client'] as const;

router.get('/location-ping-interval',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  getLocationPingInterval,
);
router.patch('/location-ping-interval',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  setLocationPingInterval,
);

router.get('/crm-reminder-thresholds',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  getCrmReminderThresholds,
);
router.patch('/crm-reminder-thresholds',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  setCrmReminderThresholds,
);

// Supply-Chain dispatch/invoice consume mode (off | advisory | enforce).
// Same admin gate as the other org-wide toggles — 'enforce' mutates stock.
router.get('/scm-dispatch-consume-mode',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  getScmDispatchConsumeMode,
);
router.patch('/scm-dispatch-consume-mode',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  setScmDispatchConsumeMode,
);

// Attendance rules (shift times, late grace, weekly off, offline check-in) for
// the caller's CLIENT — stored in clients.settings.attendance_rules. Same admin
// gate as the other org-wide toggles; apps read the resolved rules (read-only)
// from GET /attendance/rules instead.
router.get('/attendance-rules',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  getAttendanceRules,
);
router.patch('/attendance-rules',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  setAttendanceRules,
);

// UI flags are readable by any authenticated user (drives layout rendering).
router.get('/ui-flags', requireAuth, getUiFlags);
// Admins can set the active-user cap for their org.
router.patch('/user-limit', requireAuth, requireRole(...ADMIN_ROLES), setUserLimit);

export default router;

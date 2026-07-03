import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getLocationPingInterval,
  setLocationPingInterval,
  getCrmReminderThresholds,
  setCrmReminderThresholds,
  getUiFlags,
  setUserLimit,
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

// UI flags are readable by any authenticated user (drives layout rendering).
router.get('/ui-flags', requireAuth, getUiFlags);
// Admins can set the active-user cap for their org.
router.patch('/user-limit', requireAuth, requireRole(...ADMIN_ROLES), setUserLimit);

export default router;

import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getLocationPingInterval,
  setLocationPingInterval,
  getCrmReminderThresholds,
  setCrmReminderThresholds,
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

export default router;

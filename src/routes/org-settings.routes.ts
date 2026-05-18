import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getLocationPingInterval,
  setLocationPingInterval,
} from '../controllers/org-settings.controller';

const router = Router();

// Admins only — cadence affects every FE's battery + cellular usage,
// so this stays behind the same RBAC gate as user management.
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

export default router;

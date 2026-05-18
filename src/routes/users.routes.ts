import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';
import { getUserLocationTrail } from '../controllers/location-trail.controller';

const router = Router();

router.get('/',      requireAuth, requireRole('supervisor','city_manager','sub_admin', 'admin','super_admin', 'hr', 'main_admin', 'client'), misc.getUsers);
router.get('/:id',   requireAuth, requireRole('supervisor','city_manager','sub_admin', 'admin','super_admin', 'main_admin', 'client'), misc.getUserById);
router.post('/',     requireAuth, requireRole('sub_admin', 'admin','city_manager','super_admin','hr', 'main_admin', 'client'), misc.createUser);
router.patch('/status', requireAuth, misc.updateUserStatus);
router.patch('/:id', requireAuth, requireRole('sub_admin', 'admin','city_manager','super_admin', 'main_admin', 'client'), misc.updateUser);

// FE location trail — day's HEARTBEAT pings for the breadcrumb polyline on
// the live-tracking dashboard. Supervisor-and-above only.
router.get('/:id/location-trail',
  requireAuth,
  requireRole('supervisor', 'city_manager', 'sub_admin', 'admin', 'super_admin', 'main_admin', 'client'),
  getUserLocationTrail,
);

export default router;

import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';
import { getUserLocationTrail } from '../controllers/location-trail.controller';
import { updateLocationStatus } from '../controllers/location-status.controller';

const router = Router();

router.get('/',      requireAuth, requireRole('supervisor','city_manager','sub_admin', 'admin','super_admin', 'hr', 'main_admin', 'client'), misc.getUsers);
router.get('/:id',   requireAuth, requireRole('supervisor','city_manager','sub_admin', 'admin','super_admin', 'main_admin', 'client'), misc.getUserById);
router.post('/',     requireAuth, requireRole('sub_admin', 'admin','city_manager','super_admin','hr', 'main_admin', 'client'), misc.createUser);
router.patch('/status', requireAuth, misc.updateUserStatus);
// Device location permission / services state — the "no fix, here's why" report
// so the dashboard can tell "location off" from "app closed". Any authed rep.
router.patch('/location-status', requireAuth, updateLocationStatus);
router.patch('/:id', requireAuth, requireRole('sub_admin', 'admin','city_manager','super_admin', 'main_admin', 'client'), misc.updateUser);

// Multiple roles per user (additive). The PRIMARY role is still set via
// PATCH /:id (org_role_id); these manage the ADDITIONAL roles layered on top,
// whose permissions are UNIONed into the user's effective access. Read is open
// to the same tier as getUserById; writes match the updateUser tier.
router.get('/:id/roles',
  requireAuth,
  requireRole('supervisor', 'city_manager', 'sub_admin', 'admin', 'super_admin', 'main_admin', 'client'),
  misc.listUserRoles,
);
router.put('/:id/roles',
  requireAuth,
  requireRole('sub_admin', 'admin', 'city_manager', 'super_admin', 'main_admin', 'client'),
  misc.setUserRoles,
);
router.post('/:id/roles',
  requireAuth,
  requireRole('sub_admin', 'admin', 'city_manager', 'super_admin', 'main_admin', 'client'),
  misc.addUserRole,
);
router.delete('/:id/roles/:roleId',
  requireAuth,
  requireRole('sub_admin', 'admin', 'city_manager', 'super_admin', 'main_admin', 'client'),
  misc.removeUserRole,
);

// FE location trail — day's HEARTBEAT pings for the breadcrumb polyline on
// the live-tracking dashboard. Supervisor-and-above only.
router.get('/:id/location-trail',
  requireAuth,
  requireRole('supervisor', 'city_manager', 'sub_admin', 'admin', 'super_admin', 'main_admin', 'client'),
  getUserLocationTrail,
);

export default router;

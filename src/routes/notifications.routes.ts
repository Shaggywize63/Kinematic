import { Router } from 'express';
import * as ctrl from '../controllers/notifications.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Per-user clear actions — register before /:id so they aren't shadowed by
// the admin deleteHistory route below.
router.delete('/clear',      ctrl.clearMyNotifications);
router.delete('/item/:id',   ctrl.deleteMyNotification);

// Admin-specific notification management (History, Send, saved groups).
// Saved groups routes are registered BEFORE the `/:id` deleteHistory
// route so /groups/:id is not shadowed by the catch-all admin
// deleteHistory pattern (Express matches in declaration order).
const ADMIN_ROLES = ['admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'] as const;
router.get('/groups',          requireRole(...ADMIN_ROLES), ctrl.listGroups);
router.post('/groups',         requireRole(...ADMIN_ROLES), ctrl.createGroup);
router.patch('/groups/:id',    requireRole(...ADMIN_ROLES), ctrl.updateGroup);
router.delete('/groups/:id',   requireRole(...ADMIN_ROLES), ctrl.deleteGroup);

router.delete('/history/clear', requireRole(...ADMIN_ROLES), ctrl.clearHistory);
router.delete('/:id',       requireRole(...ADMIN_ROLES), ctrl.deleteHistory);
router.get('/history',       requireRole(...ADMIN_ROLES), ctrl.getHistory);
router.post('/send',         requireRole(...ADMIN_ROLES), ctrl.sendNotification);

// Generic user notification interactions
router.get('/',              ctrl.getNotifications);
router.patch('/read',        ctrl.markAllRead);
router.patch('/fcm-token',   ctrl.updateFcmToken);
router.patch('/:id/read',    ctrl.markRead);

export default router;

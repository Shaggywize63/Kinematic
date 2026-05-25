import { Router } from 'express';
import * as ctrl from '../controllers/notifications.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Per-user clear actions — register before /:id so they aren't shadowed by
// the admin deleteHistory route below.
router.delete('/clear',      ctrl.clearMyNotifications);
router.delete('/item/:id',   ctrl.deleteMyNotification);

// Admin-specific notification management (History & Send)
router.delete('/history/clear', requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'), ctrl.clearHistory);
router.delete('/:id',       requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'), ctrl.deleteHistory);
router.get('/history',       requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'), ctrl.getHistory);
router.post('/send',         requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'), ctrl.sendNotification);

// Generic user notification interactions
router.get('/',              ctrl.getNotifications);
router.patch('/read',        ctrl.markAllRead);
router.patch('/fcm-token',   ctrl.updateFcmToken);
router.patch('/:id/read',    ctrl.markRead);

export default router;

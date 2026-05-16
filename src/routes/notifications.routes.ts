import { Router } from 'express';
import * as ctrl from '../controllers/notifications.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Admin-specific notification management (History & Send)
router.delete('/:id',       requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'), ctrl.deleteHistory);
router.get('/history',       requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'), ctrl.getHistory);
router.post('/send',         requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'supervisor', 'city_manager', 'client'), ctrl.sendNotification);

// Device token registration — all authenticated users (iOS + Android).
// Upserts into device_tokens table by (user_id, platform); falls back
// to users.fcm_token column if the table hasn't been migrated yet.
router.post('/device-token', ctrl.registerDeviceToken);

// Generic user notification interactions
router.get('/',              ctrl.getNotifications);
router.patch('/read',        ctrl.markAllRead);
router.patch('/fcm-token',   ctrl.updateFcmToken);
router.patch('/:id/read',    ctrl.markRead);

export default router;

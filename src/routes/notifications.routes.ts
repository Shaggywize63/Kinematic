import { Router } from 'express';
import * as ctrl from '../controllers/notifications.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Admin-specific notification management (History & Send)
router.delete('/:id',       requireRole('admin', 'supervisor', 'city_manager'), ctrl.deleteHistory);
router.get('/history',       requireRole('admin', 'supervisor', 'city_manager'), ctrl.getHistory);
router.post('/send',         requireRole('admin', 'supervisor', 'city_manager'), ctrl.sendNotification);

// Generic user notification interactions
router.get('/',              ctrl.getNotifications);
router.patch('/read',        ctrl.markAllRead);
router.patch('/fcm-token',   ctrl.updateFcmToken);
router.patch('/:id/read',    ctrl.markRead);

export default router;

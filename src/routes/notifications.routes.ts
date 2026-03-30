import { Router } from 'express';
import * as ctrl from '../controllers/notifications.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/',              ctrl.getNotifications);
router.get('/history',       requireRole('admin', 'supervisor', 'city_manager'), ctrl.getHistory);
router.post('/send',         requireRole('admin', 'supervisor', 'city_manager'), ctrl.sendNotification);
router.patch('/read-all',    ctrl.markAllRead);
router.patch('/fcm-token',   ctrl.updateFcmToken);
router.patch('/:id/read',    ctrl.markRead);

export default router;

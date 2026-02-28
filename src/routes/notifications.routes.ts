import { Router } from 'express';
import * as ctrl from '../controllers/notifications.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/',              ctrl.getNotifications);
router.patch('/read-all',    ctrl.markAllRead);
router.patch('/fcm-token',   ctrl.updateFcmToken);
router.patch('/:id/read',    ctrl.markRead);

export default router;

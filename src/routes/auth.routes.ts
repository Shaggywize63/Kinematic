import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/project-for-email', ctrl.projectForEmail);
router.post('/login',   ctrl.login);
router.post('/refresh', ctrl.refresh);
router.post('/logout',  requireAuth, ctrl.logout);
router.get('/me',       requireAuth, ctrl.me);
router.patch('/me',     requireAuth, ctrl.updateMe);

export default router;

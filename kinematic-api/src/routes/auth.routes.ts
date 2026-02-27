import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/login',   ctrl.login);
router.post('/refresh', ctrl.refresh);
router.post('/logout',  requireAuth, ctrl.logout);
router.get('/me',       requireAuth, ctrl.me);

export default router;

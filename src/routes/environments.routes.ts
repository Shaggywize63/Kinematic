import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as envCtrl from '../controllers/environments.controller';

const router = Router();

// Super-admin only: staging -> production config promotion.
router.get('/',        requireAuth, requireRole('super_admin'), envCtrl.listEnvironments);
router.post('/promote', requireAuth, requireRole('super_admin'), envCtrl.promoteEnvironment);

export default router;

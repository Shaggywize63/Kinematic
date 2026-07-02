import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as envCtrl from '../controllers/environments.controller';

const router = Router();

// Super-admin only: staging -> production config promotion.
router.get('/',        requireAuth, requireRole('super_admin'), envCtrl.listEnvironments);
router.get('/diff',    requireAuth, requireRole('super_admin'), envCtrl.diffEnvironment);
router.post('/promote', requireAuth, requireRole('super_admin'), envCtrl.promoteEnvironment);
router.post('/promote-selective', requireAuth, requireRole('super_admin'), envCtrl.promoteSelective);

export default router;

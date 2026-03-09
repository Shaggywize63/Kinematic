import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';

const router = Router();

router.get('/',  requireAuth, misc.getZones);
router.post('/', requireAuth, requireRole('admin','super_admin'), misc.createZone);

export default router;

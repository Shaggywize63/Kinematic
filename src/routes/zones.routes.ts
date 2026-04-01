import { Router } from 'express';
import { requireAuth, requireRole, requireModule } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';

const router = Router();

router.get('/',  requireAuth, requireModule('zones'), misc.getZones);
router.post('/', requireAuth, requireModule('zones'), misc.createZone);

export default router;

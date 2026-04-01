import { Router } from 'express';
import { requireAuth, requireRole, requireModule } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';

const router = Router();

router.get('/',  requireAuth, requireModule('zones'), misc.getZones);
router.post('/', requireAuth, requireModule('zones'), misc.createZone);
router.patch('/:id', requireAuth, requireModule('zones'), misc.updateZone);
router.delete('/:id', requireAuth, requireModule('zones'), misc.deleteZone);

export default router;

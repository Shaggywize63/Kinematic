import { Router } from 'express';
import * as ctrl from '../controllers/grievance.controller';
import { requireAuth, requireAdminOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.post('/',              ctrl.submit);
router.get('/mine',           ctrl.getMine);
router.get('/admin',          requireAdminOrAbove, ctrl.getAll);
router.patch('/admin/:id',    requireAdminOrAbove, ctrl.updateStatus);

export default router;

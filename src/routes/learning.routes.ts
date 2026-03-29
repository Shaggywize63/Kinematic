import { Router } from 'express';
import * as ctrl from '../controllers/learning.controller';
import { requireAuth, requireAdminOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/',                   ctrl.getMaterials);
router.post('/',                  requireAdminOrAbove, ctrl.createMaterial);
router.post('/:id/progress',      ctrl.updateProgress);
router.delete('/:id',            requireAdminOrAbove, ctrl.deleteMaterial);


export default router;

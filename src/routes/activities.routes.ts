import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { activitiesCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       activitiesCtrl.list);
router.get('/:id',    activitiesCtrl.getOne);
router.post('/',      requireRole('admin', 'super_admin'), activitiesCtrl.create);
router.patch('/:id',  requireRole('admin', 'super_admin'), activitiesCtrl.update);
router.delete('/:id', requireRole('admin', 'super_admin'), activitiesCtrl.remove);
export default router;

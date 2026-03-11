import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { storesCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       storesCtrl.list);
router.get('/:id',    storesCtrl.getOne);
router.post('/',      requireRole('admin', 'supervisor'), storesCtrl.create);
router.patch('/:id',  requireRole('admin', 'supervisor'), storesCtrl.update);
router.delete('/:id', requireRole('admin', 'super_admin'), storesCtrl.remove);
export default router;

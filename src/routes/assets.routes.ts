import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { assetsCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       assetsCtrl.list);
router.get('/:id',    assetsCtrl.getOne);
router.post('/',      requireRole('admin', 'super_admin'), assetsCtrl.create);
router.patch('/:id',  requireRole('admin', 'super_admin'), assetsCtrl.update);
router.delete('/:id', requireRole('admin', 'super_admin'), assetsCtrl.remove);
export default router;

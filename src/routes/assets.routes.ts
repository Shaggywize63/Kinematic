import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/auth';
import { assetsCtrl } from '../controllers/management.controller';

const router4 = Router();
router4.use(requireAuth);
router4.get('/',      assetsCtrl.list);
router4.get('/:id',   assetsCtrl.getOne);
router4.post('/',     requireRole('admin','supervisor'), assetsCtrl.create);
router4.patch('/:id', requireRole('admin','supervisor'), assetsCtrl.update);
router4.delete('/:id',requireRole('admin'), assetsCtrl.remove);
export default router4;

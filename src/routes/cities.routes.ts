import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/auth';
import { citiesCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',      citiesCtrl.list);
router.get('/:id',   citiesCtrl.getOne);
router.post('/',     requireRole('admin','supervisor'), citiesCtrl.create);
router.patch('/:id', requireRole('admin','supervisor'), citiesCtrl.update);
router.delete('/:id',requireRole('admin'), citiesCtrl.remove);
export default router;

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/auth';
import { storesCtrl } from '../controllers/management.controller';

const router2 = Router();
router2.use(requireAuth);
router2.get('/',      storesCtrl.list);
router2.get('/:id',   storesCtrl.getOne);
router2.post('/',     requireRole('admin','supervisor'), storesCtrl.create);
router2.patch('/:id', requireRole('admin','supervisor'), storesCtrl.update);
router2.delete('/:id',requireRole('admin'), storesCtrl.remove);
export default router2;



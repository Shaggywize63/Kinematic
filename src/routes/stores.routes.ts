import { Router } from 'express';
import { requireAuth, requireRole, requireModule } from '../middleware/auth';
import { storesCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       requireModule('stores'), storesCtrl.list);
router.get('/:id',    requireModule('stores'), storesCtrl.getOne);
router.post('/',      requireModule('stores'), storesCtrl.create);
router.patch('/:id',  requireModule('stores'), storesCtrl.update);
router.delete('/:id', requireModule('stores'), storesCtrl.remove);
export default router;

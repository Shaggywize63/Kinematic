import { Router } from 'express';
import { requireAuth, requireRole, requireModule } from '../middleware/auth';
import { assetsCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       requireModule('assets'), assetsCtrl.list);
router.get('/:id',    requireModule('assets'), assetsCtrl.getOne);
router.post('/',      requireModule('assets'), assetsCtrl.create);
router.patch('/:id',  requireModule('assets'), assetsCtrl.update);
router.delete('/:id', requireModule('assets'), assetsCtrl.remove);
export default router;

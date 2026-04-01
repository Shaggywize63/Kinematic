import { Router } from 'express';
import { requireAuth, requireRole, requireModule } from '../middleware/auth';
import { activitiesCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       requireModule('activities'), activitiesCtrl.list);
router.get('/:id',    requireModule('activities'), activitiesCtrl.getOne);
router.post('/',      requireModule('activities'), activitiesCtrl.create);
router.patch('/:id',  requireModule('activities'), activitiesCtrl.update);
router.delete('/:id', requireModule('activities'), activitiesCtrl.remove);
export default router;

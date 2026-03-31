import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';

const router = Router();

router.get('/',      requireAuth, requireRole('supervisor','city_manager','sub_admin', 'admin','super_admin', 'hr'), misc.getUsers);
router.get('/:id',   requireAuth, requireRole('supervisor','city_manager','sub_admin', 'admin','super_admin'), misc.getUserById);
router.post('/',     requireAuth, requireRole('sub_admin', 'admin','city_manager','super_admin','hr'), misc.createUser);
router.patch('/:id', requireAuth, requireRole('sub_admin', 'admin','city_manager','super_admin'), misc.updateUser);

export default router;

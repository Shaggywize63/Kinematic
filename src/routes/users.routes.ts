import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';

const router = Router();

router.get('/',      requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), misc.getUsers);
router.get('/:id',   requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), misc.getUserById);
router.post('/',     requireAuth, requireRole('admin','city_manager','super_admin','hr'), misc.createUser);
router.patch('/:id', requireAuth, requireRole('admin','city_manager','super_admin'), misc.updateUser);

export default router;

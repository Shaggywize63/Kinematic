import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as clientCtrl from '../controllers/client.controller';

const router = Router();

// Only Admins or Super Admins can manage clients
router.get('/',      requireAuth, requireRole('admin', 'super_admin'), clientCtrl.getClients);
router.post('/',     requireAuth, requireRole('admin', 'super_admin'), clientCtrl.createClient);
router.patch('/:id', requireAuth, requireRole('admin', 'super_admin'), clientCtrl.updateClient);
router.delete('/:id',requireAuth, requireRole('admin', 'super_admin'), clientCtrl.deleteClient);

export default router;

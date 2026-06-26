import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as clientCtrl from '../controllers/client.controller';

const router = Router();

// Only Admins or Super Admins can manage clients
router.get('/',                 requireAuth, requireRole('admin', 'super_admin'), clientCtrl.getClients);
router.post('/',                requireAuth, requireRole('admin', 'super_admin'), clientCtrl.createClient);
router.patch('/:id',            requireAuth, requireRole('admin', 'super_admin'), clientCtrl.updateClient);
router.delete('/:id',           requireAuth, requireRole('admin', 'super_admin'), clientCtrl.deleteClient);
// Super-admin only: "Login as client" — authenticate with the client's stored
// account credentials and return a real session for that account.
router.post('/:id/login-as',    requireAuth, requireRole('super_admin'), clientCtrl.loginAsClientCredentials);
// (legacy) org-scoped impersonation token — kept for backward compatibility.
router.post('/:id/impersonate', requireAuth, requireRole('super_admin'), clientCtrl.impersonateClient);
router.get('/:id/modules',      requireAuth, requireRole('admin', 'super_admin'), clientCtrl.getClientModules);
router.post('/:id/packages',    requireAuth, requireRole('admin', 'super_admin'), clientCtrl.grantClientPackages);

export default router;

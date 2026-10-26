import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as clientCtrl from '../controllers/client.controller';

const router = Router();

// Only Admins or Super Admins can manage clients
router.get('/',                 requireAuth, requireRole('admin', 'super_admin'), clientCtrl.getClients);
router.post('/',                requireAuth, requireRole('admin', 'super_admin'), clientCtrl.createClient);
// Dedicated-project provisioning (supabase.com) was retired with the move to AWS; these two answer "not available".
router.get('/provision/preflight', requireAuth, requireRole('super_admin'), clientCtrl.provisionPreflight);
router.post('/provision',          requireAuth, requireRole('super_admin'), clientCtrl.provisionClientHandler);
router.patch('/:id',            requireAuth, requireRole('admin', 'super_admin'), clientCtrl.updateClient);
router.delete('/:id',           requireAuth, requireRole('admin', 'super_admin'), clientCtrl.deleteClient);
// Super-admin only: "Login as client" — authenticate with the client's stored
// account credentials and return a real session for that account.
router.post('/:id/login-as',    requireAuth, requireRole('super_admin'), clientCtrl.loginAsClientCredentials);
// (legacy) org-scoped impersonation token — kept for backward compatibility.
router.post('/:id/impersonate', requireAuth, requireRole('super_admin'), clientCtrl.impersonateClient);
router.get('/:id/modules',      requireAuth, requireRole('admin', 'super_admin'), clientCtrl.getClientModules);
router.post('/:id/packages',    requireAuth, requireRole('admin', 'super_admin'), clientCtrl.grantClientPackages);
// Which notifications from the catalogue this client receives (none by default).
router.get('/:id/notifications', requireAuth, requireRole('admin', 'super_admin'), clientCtrl.getClientNotifications);
router.put('/:id/notifications', requireAuth, requireRole('admin', 'super_admin'), clientCtrl.setClientNotifications);
// Account & billing: seat usage, next unpaid invoice, and the two transactional emailers.
router.get('/:id/account', requireAuth, requireRole('admin', 'super_admin'), clientCtrl.getClientAccount);
router.post('/:id/send-welcome', requireAuth, requireRole('admin', 'super_admin'), clientCtrl.sendClientWelcomeEmail);
router.post('/:id/send-payment-reminder', requireAuth, requireRole('admin', 'super_admin'), clientCtrl.sendClientPaymentReminderEmail);

export default router;

import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as misc from '../controllers/misc.controller';

const router = Router();

// VISIT LOGS
router.get('/visits', requireAuth, misc.getVisitLogs);
router.post('/visits', requireAuth, misc.createVisitLog);

// GRIEVANCES
router.post('/grievances', requireAuth, misc.submitGrievance);
router.get('/grievances', requireAuth, misc.getMyGrievances);
router.get('/grievances/all', requireAuth, requireRole('admin', 'super_admin', 'hr'), misc.getAllGrievances);
router.patch('/grievances/:id', requireAuth, requireRole('admin', 'super_admin', 'hr'), misc.updateGrievance);

// SOS
router.post('/sos', requireAuth, misc.createSOS);
router.patch('/sos/:id/resolve', requireAuth, requireRole('admin', 'super_admin', 'supervisor'), misc.resolveSOS);

// ANALYTICS & FEED
router.get('/dashboard-summary', requireAuth, requireRole('admin', 'super_admin', 'supervisor', 'hr'), misc.getDashboardSummary);
router.get('/activity-feed', requireAuth, requireRole('admin', 'super_admin', 'supervisor', 'hr'), misc.getActivityFeed);

// USERS & ZONES (Admin)
router.get('/users', requireAuth, requireRole('admin', 'super_admin', 'supervisor', 'hr'), misc.getUsers);

router.get('/users/:id', requireAuth, misc.getUserById);
router.post('/users', requireAuth, requireRole('admin', 'super_admin', 'hr'), misc.createUser);
router.patch('/users/:id', requireAuth, requireRole('admin', 'super_admin', 'hr'), misc.updateUser);
router.post('/users/:id/reset-password', requireAuth, requireRole('admin', 'super_admin', 'hr'), misc.resetUserPassword);
router.get('/zones', requireAuth, misc.getZones);
router.post('/zones', requireAuth, requireRole('admin', 'super_admin'), misc.createZone);
router.get('/clients', requireAuth, misc.getClients);

// LEARNING
router.get('/learning', requireAuth, misc.getMaterials);
router.post('/learning/:id/progress', requireAuth, misc.updateProgress);
router.post('/learning', requireAuth, requireRole('admin', 'super_admin'), misc.createMaterial);

// GET /api/v1/misc/quote/daily -> Get the daily motivation quote
router.get('/quote/daily', requireAuth, misc.getDailyQuote);

// POST /api/v1/misc/quote -> Upsert a motivation quote (admin/hr only)
router.post('/quote', requireAuth, requireRole('admin', 'super_admin', 'hr'), misc.upsertQuote);

export default router;

import { Router } from 'express';
import { requireAuth, requireSupervisorOrAbove, requireRole } from '../middleware/auth';
import {
  getRoutePlans,
  getRoutePlanSummary,
  getMyRoutePlan,
  createRoutePlan,
  updateRoutePlan,
  deleteRoutePlan,
  updateOutletVisit,
  bulkImportRoutePlans,
  getImports,
  getOutletFrequency,
} from '../controllers/route-plan.controller';

const router = Router();
router.use(requireAuth);

// ── Admin / Supervisor ──────────────────────────────────────
router.get('/',                  requireSupervisorOrAbove, getRoutePlans);
router.get('/summary',           requireSupervisorOrAbove, getRoutePlanSummary);
router.get('/imports',           requireSupervisorOrAbove, getImports);
router.get('/outlet-frequency',  requireSupervisorOrAbove, getOutletFrequency);
router.post('/',                 requireSupervisorOrAbove, createRoutePlan);
router.post('/bulk-import',      requireRole('admin', 'super_admin', 'main_admin', 'sub_admin'), bulkImportRoutePlans);
router.patch('/:id',             requireSupervisorOrAbove, updateRoutePlan);
router.delete('/:id',            requireRole('admin', 'super_admin', 'main_admin'), deleteRoutePlan);

// ── FE ─────────────────────────────────────────────────────
router.get('/me',                getMyRoutePlan);
router.patch('/outlets/:outletId', updateOutletVisit);

export default router;

import { Router } from 'express';
import { requireAuth, requireSupervisorOrAbove, requireRole } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import {
  getRoutePlans,
  getRoutePlanSummary,
  getEsgSummary,
  getMyRoutePlan,
  createRoutePlan,
  updateRoutePlan,
  deleteRoutePlan,
  updateOutletVisit,
  bulkImportRoutePlans,
  getImports,
  getOutletFrequency,
  optimizeRoutePlan,
  optimizeAndApplyMyPlan,
} from '../controllers/route-plan.controller';

const router = Router();
router.use(requireAuth);

// ── Admin / Supervisor ──────────────────────────────
router.get('/',                  requireSupervisorOrAbove, getRoutePlans);
router.get('/summary',           requireSupervisorOrAbove, getRoutePlanSummary);
router.get('/esg-summary',       requireSupervisorOrAbove, getEsgSummary);
router.get('/imports',           requireSupervisorOrAbove, getImports);
router.get('/outlet-frequency',  requireSupervisorOrAbove, getOutletFrequency);
router.post('/',                 requireSupervisorOrAbove, createRoutePlan);
router.post('/optimize',         requireSupervisorOrAbove, optimizeRoutePlan);
router.post('/bulk-import',      requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'client'), bulkImportRoutePlans);
router.patch('/:id',             requireSupervisorOrAbove, updateRoutePlan);
router.delete('/:id',            requireRole('admin', 'super_admin', 'main_admin', 'client'), deleteRoutePlan);

// ── FE ──────────────────────────────────────────
router.get('/me',                getMyRoutePlan);
router.get('/my-plan',           getMyRoutePlan); // Mobile compatibility
router.post('/optimize/me',      optimizeRoutePlan);
router.post('/optimize/apply',   requireModule('route_optimization'), optimizeAndApplyMyPlan);
router.patch('/outlets/:outletId', updateOutletVisit);

export default router;

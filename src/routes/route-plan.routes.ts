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
  suggestMyRoute,
  autoPlanForUser,
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
// Supervisor auto-plan: optimize a target FE's stored plan from their location.
router.post('/auto-plan',        requireSupervisorOrAbove, requireModule('route_optimization'), autoPlanForUser);
router.post('/bulk-import',      requireRole('admin', 'super_admin', 'main_admin', 'sub_admin', 'client'), bulkImportRoutePlans);
router.patch('/:id',             requireSupervisorOrAbove, updateRoutePlan);
router.delete('/:id',            requireRole('admin', 'super_admin', 'main_admin', 'client'), deleteRoutePlan);

// ── FE ──────────────────────────────────────────
router.get('/me',                getMyRoutePlan);
router.get('/my-plan',           getMyRoutePlan); // Mobile compatibility
router.post('/optimize/me',      optimizeRoutePlan);
// Smart, compute-only suggestion for the caller's day (start-from-live-location,
// priority-weighted, nearby leads). One-tap accept then calls /optimize/apply.
router.get('/suggest/me',        requireModule('route_optimization'), suggestMyRoute);
router.post('/optimize/apply',   requireModule('route_optimization'), optimizeAndApplyMyPlan);
router.patch('/outlets/:outletId', updateOutletVisit);

export default router;

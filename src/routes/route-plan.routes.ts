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
  autoGenerateRoutePlan,
  getRouteDeviations,
  upsertOutletFrequency,
  listAutoPlanMethods,
  getAutoPlanPolicy,
  setAutoPlanPolicy,
  previewTeamAutoPlan,
  runTeamAutoPlan,
} from '../controllers/route-plan.controller';

const router = Router();
router.use(requireAuth);

// ── Admin / Supervisor ──────────────────────────────
router.get('/',                  requireSupervisorOrAbove, getRoutePlans);
router.get('/summary',           requireSupervisorOrAbove, getRoutePlanSummary);
router.get('/esg-summary',       requireSupervisorOrAbove, getEsgSummary);
router.get('/imports',           requireSupervisorOrAbove, getImports);
router.get('/outlet-frequency',  requireSupervisorOrAbove, getOutletFrequency);
// Set an outlet's visit cadence + priority (feeds the optimizer's priority
// weighting). Gated on route_optimization since that's the feature it drives.
router.post('/outlet-frequency', requireSupervisorOrAbove, requireModule('route_optimization'), upsertOutletFrequency);
// Off-route visits (checked in outside the planned outlet's geofence) — powers
// the web Route Deviations view. Gated on the route_deviation module.
router.get('/deviations',        requireSupervisorOrAbove, requireModule('route_deviation'), getRouteDeviations);
router.post('/',                 requireSupervisorOrAbove, createRoutePlan);
router.post('/optimize',         requireSupervisorOrAbove, optimizeRoutePlan);
// Supervisor auto-plan: optimize a target FE's stored plan from their location.
router.post('/auto-plan',        requireSupervisorOrAbove, requireModule('route_optimization'), autoPlanForUser);
// Supervisor auto-GENERATE: design a brand-new plan for an FE from outlet
// cadence + priority (Outlet Priorities), then assign it. dry_run previews.
router.post('/auto-generate',    requireSupervisorOrAbove, requireModule('route_optimization'), autoGenerateRoutePlan);

// ── Automated Route Plans (team-wide auto-assignment) ──────────────────────
// Manager picks a method (policy), previews the per-FE assignment, then runs it
// to auto-assign plans across every FE. All gated on route_optimization.
router.get('/autoplan/methods',  requireSupervisorOrAbove, listAutoPlanMethods);
router.get('/autoplan/policy',   requireSupervisorOrAbove, getAutoPlanPolicy);
router.put('/autoplan/policy',   requireSupervisorOrAbove, requireModule('route_optimization'), setAutoPlanPolicy);
router.post('/autoplan/preview', requireSupervisorOrAbove, requireModule('route_optimization'), previewTeamAutoPlan);
router.post('/autoplan/run',     requireSupervisorOrAbove, requireModule('route_optimization'), runTeamAutoPlan);
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

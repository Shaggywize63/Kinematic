/**
 * Field-Force Management analytics — /api/v1/analytics/ffm/*
 *
 * Mounted as a sub-router of analytics.routes.ts, so it inherits its requireAuth
 * + enforceCityScope. These are the 16 datasets the dashboard's FFM Analytics
 * section fetches (kinematic-dashboard/src/lib/ffmAnalyticsConfig.ts).
 */
import { Router } from 'express';
import { requireModule } from '../middleware/rbac';
import * as ffm from '../controllers/analytics/ffm-analytics.controller';

const router = Router();

// Gate on the analytics entitlement — same module the sibling /analytics/*
// routes use (the FFM section only shows for tenants that carry it).
const gate = requireModule('analytics');

router.get('/beat-adherence',        gate, ffm.beatAdherence);
router.get('/outlet-coverage',       gate, ffm.outletCoverage);
router.get('/frequency-compliance',  gate, ffm.frequencyCompliance);
router.get('/productive-calls',      gate, ffm.productiveCalls);
router.get('/order-strike-rate',     gate, ffm.orderStrikeRate);
router.get('/aov',                   gate, ffm.aov);
router.get('/new-outlets',           gate, ffm.newOutlets);
router.get('/visit-duration',        gate, ffm.visitDuration);
router.get('/idle-heatmap',          gate, ffm.idleHeatmap);
router.get('/distance-travelled',    gate, ffm.distanceTravelled);
router.get('/off-route',             gate, ffm.offRoute);
router.get('/attendance-punctuality', gate, ffm.attendancePunctuality);
router.get('/stuck-fes',             gate, ffm.stuckFes);
router.get('/security-violations',   gate, ffm.securityViolations);
router.get('/form-completion',       gate, ffm.formCompletion);
router.get('/top-performers',        gate, ffm.topPerformers);

export default router;

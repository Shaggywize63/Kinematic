/**
 * Field-Force Management analytics — /api/v1/analytics/ffm/*
 *
 * Mounted as a sub-router of analytics.routes.ts, so it inherits its requireAuth
 * + enforceCityScope. These are the 16 datasets the dashboard's FFM Analytics
 * section fetches (kinematic-dashboard/src/lib/ffmAnalyticsConfig.ts), plus the
 * twelve added datasets and the report endpoints implemented in
 * ffm-analytics-plus.controller.ts.
 */
import { Router } from 'express';
import { requireModule, requireAnyModule } from '../middleware/rbac';
import * as ffm from '../controllers/analytics/ffm-analytics.controller';
import * as plus from '../controllers/analytics/ffm-analytics-plus.controller';

const router = Router();

// Gate on the analytics entitlement — same module the sibling /analytics/*
// routes use (the FFM section only shows for tenants that carry it).
const gate = requireModule('analytics');
// Phase-B beat-productivity metrics (TLSD + unique/productive outlets) are a
// separately-toggleable module, off by default until enabled at onboarding.
const productivityGate = requireModule('beat_productivity');
// The report pages live under the Field Force Reports hub (module `ffm_reports`), so a client entitled to that hub
// must be able to load them even without the wider `analytics` SKU. The two reports that also feed attendance-module
// pages (Attendance Summary extras, Hours & Idle) accept `attendance` too. Entitlement + legacy permissions only,
// exactly like requireModule; nobody gains a module they were not given.
const reportGate = requireAnyModule(['analytics', 'ffm_reports']);
const reportGateWithAttendance = requireAnyModule(['analytics', 'ffm_reports', 'attendance']);

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

// More widget datasets (same `analytics` gate): trends, distributions, per-rep comparisons.
router.get('/beat-adherence-trend',  gate, plus.beatAdherenceTrend);
router.get('/outlet-recency',        gate, plus.outletRecencyWidget);
router.get('/visit-frequency',       gate, plus.visitFrequencyWidget);
router.get('/productive-trend',      gate, plus.productiveTrend);
router.get('/rep-basket',            gate, plus.repBasket);
router.get('/calls-per-day',         gate, plus.callsPerDay);
router.get('/dwell-time',            gate, plus.dwellTime);
router.get('/visit-hours',           gate, plus.visitHoursWidget);
router.get('/travel-efficiency',     gate, plus.travelEfficiency);
router.get('/geo-exceptions',        gate, plus.geoExceptions);
router.get('/attendance-hours',      gate, plus.attendanceHours);
router.get('/outlet-churn',          gate, plus.outletChurnWidget);

// Report endpoints for the dashboard's FFM Reports pages (?from=&to= YYYY-MM-DD, at most 62 days).
router.get('/reports/rep-activity',        reportGate, plus.repActivityReport);
router.get('/reports/beat-compliance',     reportGate, plus.beatComplianceReport);
router.get('/reports/time-and-travel',     reportGateWithAttendance, plus.timeAndTravelReport);
router.get('/reports/outlet-visit-gaps',   reportGate, plus.outletVisitGapsReport);
router.get('/reports/geo-exceptions',      reportGate, plus.geoExceptionsReport);
router.get('/reports/supervisor-teams',    reportGate, plus.supervisorTeamsReport);
router.get('/reports/attendance-extras',   reportGateWithAttendance, plus.attendanceExtrasReport);
router.get('/reports/visit-coverage',      reportGate, plus.visitCoverageReport);

// Beat productivity (module: beat_productivity)
router.get('/tlsd',                  productivityGate, ffm.tlsd);
router.get('/unique-outlets',        productivityGate, ffm.uniqueOutlets);

export default router;

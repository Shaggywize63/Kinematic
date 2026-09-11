import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireModule, requireAnyModule } from '../middleware/rbac';
import {
  getSummary, getActivityFeed, getHourly,
  getContactHeatmap, getWeeklyContacts,
  getLiveLocations, getAttendanceToday,
  getOutletCoverage, getCityPerformance,
  getTffTrends, getDashboardInit, getMobileHome,
  getMobileBroadcasts, getMobileLearning
} from '../controllers/analytics.controller';

import ffmAnalyticsRoutes from './ffm-analytics.routes';

const router = Router();
router.use(requireAuth);

const checkAnalytics = requireModule('analytics');

// Field-Force Management analytics widgets → /api/v1/analytics/ffm/*
router.use('/ffm', ffmAnalyticsRoutes);

// Short-lived per-user response cache. Most analytics aggregates only
// change every few minutes; serving the same user the same answer for
// 15-60s eliminates the bulk of dashboard repeat-fetch traffic.
const cache = (seconds: number) => (_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', `private, max-age=${seconds}`);
  res.set('Vary', 'Authorization');
  next();
};

router.get('/mobile-home',      cache(15), getMobileHome);

router.get('/dashboard-init',   cache(30), checkAnalytics, getDashboardInit);
router.get('/summary',          cache(60), checkAnalytics, getSummary);
router.get('/tff-trends',       cache(60), checkAnalytics, getTffTrends);
router.get('/activity-feed',    cache(15), checkAnalytics, getActivityFeed);
router.get('/hourly',           cache(60), checkAnalytics, getHourly);
router.get('/contact-heatmap',  cache(60), checkAnalytics, getContactHeatmap);
router.get('/weekly-contacts',  cache(60), checkAnalytics, getWeeklyContacts);
// Live locations back the Live Trailing page (`live_tracking` module) as well
// as the Analytics dashboards (`analytics`). The nav gates Live Trailing on
// `live_tracking`, so a client entitled to Live Trailing but not the broader
// Analytics SKU must still load this feed — gate on EITHER module, else the
// page 403s with "Failed to load live locations: Unauthorized".
router.get('/live-locations',   cache(15), requireAnyModule(['live_tracking', 'analytics']), getLiveLocations);
router.get('/attendance-today', cache(15), checkAnalytics, getAttendanceToday);
router.get('/outlet-coverage',  cache(60), checkAnalytics, getOutletCoverage);
router.get('/city-performance', cache(60), checkAnalytics, getCityPerformance);

// Mobile Compatibility (iOS prefixes these with /analytics)
router.get('/broadcasts',        getMobileBroadcasts);
router.post('/broadcasts/:id/answer', getMobileBroadcasts); // Re-use or proxy
router.get('/learning',          getMobileLearning);

export default router;

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import {
  getSummary, getActivityFeed, getHourly,
  getContactHeatmap, getWeeklyContacts,
  getLiveLocations, getAttendanceToday,
  getOutletCoverage, getCityPerformance,
  getTffTrends, getDashboardInit, getMobileHome,
  getMobileBroadcasts, getMobileLearning
} from '../controllers/analytics.controller';

const router = Router();
router.use(requireAuth);

const checkAnalytics = requireModule('analytics');

router.get('/mobile-home',      getMobileHome);

router.get('/dashboard-init',   checkAnalytics, getDashboardInit);
router.get('/summary',          checkAnalytics, getSummary);
router.get('/tff-trends',       checkAnalytics, getTffTrends);
router.get('/activity-feed',    checkAnalytics, getActivityFeed);
router.get('/hourly',           checkAnalytics, getHourly);
router.get('/contact-heatmap',  checkAnalytics, getContactHeatmap);
router.get('/weekly-contacts',  checkAnalytics, getWeeklyContacts);   // ?from=&to= supported
router.get('/live-locations',   checkAnalytics, getLiveLocations);
router.get('/attendance-today', checkAnalytics, getAttendanceToday);
router.get('/outlet-coverage',  checkAnalytics, getOutletCoverage);   // ?from=&to=
router.get('/city-performance', checkAnalytics, getCityPerformance);  // ?from=&to=

// Mobile Compatibility (iOS prefixes these with /analytics)
router.get('/broadcasts',        getMobileBroadcasts);
router.post('/broadcasts/:id/answer', getMobileBroadcasts); // Re-use or proxy
router.get('/learning',          getMobileLearning);

export default router;

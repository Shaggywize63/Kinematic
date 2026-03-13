import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  getSummary, getActivityFeed, getHourly,
  getContactHeatmap, getWeeklyContacts,
  getLiveLocations, getAttendanceToday,
  getOutletCoverage, getCityPerformance,
} from '../controllers/analytics.controller';

const router = Router();
router.use(requireAuth);

router.get('/summary',          getSummary);
router.get('/activity-feed',    getActivityFeed);
router.get('/hourly',           getHourly);
router.get('/contact-heatmap',  getContactHeatmap);
router.get('/weekly-contacts',  getWeeklyContacts);   // ?from=&to= supported
router.get('/live-locations',   getLiveLocations);
router.get('/attendance-today', getAttendanceToday);
router.get('/outlet-coverage',  getOutletCoverage);   // ?from=&to=
router.get('/city-performance', getCityPerformance);  // ?from=&to=

export default router;

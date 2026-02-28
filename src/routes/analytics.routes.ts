import { Router } from 'express';
import * as ctrl from '../controllers/analytics.controller';
import { requireAuth, requireSupervisorOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth, requireSupervisorOrAbove);
router.get('/summary',        ctrl.getSummary);
router.get('/activity-feed',  ctrl.getActivityFeed);
router.get('/hourly',         ctrl.getHourly);

export default router;

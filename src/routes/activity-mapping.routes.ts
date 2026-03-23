import { Router } from 'express';
import * as ctrl from '../controllers/activity-mapping.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/activity/:activityId', ctrl.getFEsByActivity);
router.get('/user/:userId',         ctrl.getActivitiesByUser);
router.post('/',                     ctrl.mapActivityUser);

export default router;

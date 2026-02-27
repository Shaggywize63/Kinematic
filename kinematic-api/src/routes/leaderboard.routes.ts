import { Router } from 'express';
import * as ctrl from '../controllers/leaderboard.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/',    ctrl.getLeaderboard);
router.get('/me',  ctrl.getMyScore);

export default router;

import { Router } from 'express';
import * as ctrl from '../controllers/visitlog.controller';
import { requireAuth, requireSupervisorOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.post('/',              ctrl.logVisit);
router.get('/mine',           ctrl.getMyVisits);
router.get('/received',       ctrl.getReceivedVisits);
router.patch('/:id/feedback', ctrl.updateFEFeedback);
router.get('/team',           requireSupervisorOrAbove, ctrl.getTeamVisits);

export default router;

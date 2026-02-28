import { Router } from 'express';
import * as ctrl from '../controllers/broadcast.controller';
import { requireAuth, requireAdminOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/',              ctrl.getQuestions);
router.post('/',             requireAdminOrAbove, ctrl.createQuestion);
router.post('/:id/answer',   ctrl.submitAnswer);
router.get('/:id/results',   requireAdminOrAbove, ctrl.getResults);

export default router;

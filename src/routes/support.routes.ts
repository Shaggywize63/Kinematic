import { Router } from 'express';
import * as ctrl from '../controllers/support.controller';
import { requireAuth } from '../middleware/auth';

/** Dashboard: Help & Support (customers) and the support inbox (platform operators). Mounted at /api/v1/support. */
const router = Router();
router.use(requireAuth);
router.get('/tickets', ctrl.list);
router.post('/tickets', ctrl.create);
router.get('/tickets/:id', ctrl.detail);
router.post('/tickets/:id/comments', ctrl.comment);
router.post('/tickets/:id/feedback', ctrl.feedback);
router.patch('/tickets/:id', ctrl.update);

export default router;

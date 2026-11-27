import { Router } from 'express';
import * as ctrl from '../controllers/support.controller';
import { requireAuth } from '../middleware/auth';
import { uploadMultiple } from '../middleware/upload';

/** Dashboard: Help & Support (customers) and the support inbox (platform operators). Mounted at /api/v1/support. */
const router = Router();
router.use(requireAuth);
router.get('/tickets', ctrl.list);
router.post('/tickets', ctrl.create);
// Before /tickets/:id so the literal path is never read as a ticket id. Field name: `photos`.
router.post('/tickets/attachments', uploadMultiple, ctrl.uploadTicketAttachments);
router.get('/tickets/:id', ctrl.detail);
router.post('/tickets/:id/comments', ctrl.comment);
router.post('/tickets/:id/feedback', ctrl.feedback);
router.patch('/tickets/:id', ctrl.update);

export default router;

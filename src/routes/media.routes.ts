import { Router } from 'express';
import { signMedia, signMediaBatch } from '../controllers/media.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// GET /api/v1/media/sign — issue a short-lived signed URL for a private object.
router.get('/sign', requireAuth, signMedia);
// POST /api/v1/media/sign-batch — sign many objects at once (report exports).
router.post('/sign-batch', requireAuth, signMediaBatch);

export default router;

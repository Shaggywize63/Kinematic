import { Router } from 'express';
import { signMedia } from '../controllers/media.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// GET /api/v1/media/sign — issue a short-lived signed URL for a private object.
router.get('/sign', requireAuth, signMedia);

export default router;

import { Router } from 'express';
import { uploadFile } from '../controllers/upload.controller';
import { requireAuth } from '../middleware/auth';
import { uploadSingle } from '../middleware/upload';

const router = Router();
router.post('/:type', requireAuth, uploadSingle, uploadFile);

export default router;

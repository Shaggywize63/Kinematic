import { Router, Request, Response, NextFunction } from 'express';
import { uploadFile } from '../controllers/upload.controller';
import { requireAuth } from '../middleware/auth';
import { uploadSingle, uploadMaterial } from '../middleware/upload';

const router = Router();

// Use material middleware for 'material' type, image middleware for everything else
router.post('/:type', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  const middleware = req.params.type === 'material' ? uploadMaterial : uploadSingle;
  middleware(req, res, next);
}, uploadFile);

export default router;

// ── src/routes/skus.routes.ts ────────────────────────────────────────────────
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/auth';
import { skusCtrl } from '../controllers/management.controller';

const router3 = Router();
router3.use(requireAuth);
router3.get('/',      skusCtrl.list);
router3.get('/:id',   skusCtrl.getOne);
router3.post('/',     requireRole('admin','supervisor'), skusCtrl.create);
router3.patch('/:id', requireRole('admin','supervisor'), skusCtrl.update);
router3.delete('/:id',requireRole('admin'), skusCtrl.remove);
export default router2;

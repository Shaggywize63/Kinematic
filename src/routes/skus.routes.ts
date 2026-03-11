// ── src/routes/skus.routes.ts ────────────────────────────────────────────────
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { skusCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       skusCtrl.list);
router.get('/:id',    skusCtrl.getOne);
router.post('/',      requireRole('admin', 'super_admin'), skusCtrl.create);
router.patch('/:id',  requireRole('admin', 'super_admin'), skusCtrl.update);
router.delete('/:id', requireRole('admin', 'super_admin'), skusCtrl.remove);
export default router;

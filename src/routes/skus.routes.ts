// ── src/routes/skus.routes.ts ────────────────────────────────────────────────
import { Router } from 'express';
import { requireAuth, requireRole, requireModule } from '../middleware/auth';
import { skusCtrl } from '../controllers/management.controller';

const router = Router();
router.use(requireAuth);
router.get('/',       requireModule('skus'), skusCtrl.list);
router.get('/:id',    requireModule('skus'), skusCtrl.getOne);
router.post('/',      requireModule('skus'), skusCtrl.create);
router.patch('/:id',  requireModule('skus'), skusCtrl.update);
router.delete('/:id', requireModule('skus'), skusCtrl.remove);
export default router;

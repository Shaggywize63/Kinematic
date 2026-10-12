/**
 * Employee-wise monthly ₹ collection targets. Mounted at /api/v1/distribution/collection-targets after
 * requireAuth + requireModule('reports'). The whole surface is a management view, so every route is
 * admin-and-above (which includes city managers / supervisors).
 */
import { Router } from 'express';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';
import { list, upsert, remove } from '../../controllers/distribution/collectionTargets.controller';

const router = Router();

router.use(requireAdminOrAbove);
router.get('/',       list);
router.post('/',      idempotency, upsert);
router.delete('/:id', remove);

export default router;

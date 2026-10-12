/**
 * Daily closing stock. Mounted at /api/v1/distribution/closing-stock after requireAuth +
 * requireModule('distribution_stock'). Saving and approving are admin-and-above; reading is any
 * distribution-stock user.
 */
import { Router } from 'express';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';
import { worksheet, save, approve, report } from '../../controllers/distribution/closingStock.controller';

const router = Router();

router.get('/',            worksheet);
router.get('/report',      report);
router.post('/',           requireAdminOrAbove, idempotency, save);
router.post('/:id/approve', requireAdminOrAbove, idempotency, approve);

export default router;

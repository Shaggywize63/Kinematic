import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/promotions.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();

// Trade promotions (budgeted trade-spend programs)
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.get('/:id/summary', ctrl.summary);
router.post('/', requireAdminOrAbove, idempotency, ctrl.create);
router.patch('/:id', requireAdminOrAbove, ctrl.update);
router.post('/:id/status', requireAdminOrAbove, ctrl.setStatus);

// Claims filed by distributors against a promotion
router.get('/:id/claims', ctrl.listClaims);
router.post('/:id/claims', idempotency, ctrl.createClaim);
router.post('/claims/:claimId/approve', requireAdminOrAbove, ctrl.approveClaim);
router.post('/claims/:claimId/reject', requireAdminOrAbove, ctrl.rejectClaim);
router.post('/claims/:claimId/settle', requireAdminOrAbove, ctrl.settleClaim);

export default router;

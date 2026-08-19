import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/orders.controller';
import { requireSupervisorOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

const router = Router();
// Admin-side / dashboard order management
router.get('/', ctrl.list);
// Order entry (dashboard cart): browsable priced catalogue + server-side pricing
// preview reusing the exact salesman pipeline. Catalogue/preview are registered
// BEFORE '/:id' so 'catalogue' isn't captured as an order id.
router.get('/catalogue', ctrl.catalogue);
router.post('/preview', ctrl.preview);
router.post('/', idempotency, ctrl.create);
router.get('/:id', ctrl.get);
router.post('/:id/approve', requireSupervisorOrAbove, idempotency, ctrl.approve);
router.post('/:id/cancel', idempotency, ctrl.cancel);
export default router;

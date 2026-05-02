import { Router } from 'express';
import * as salesman from '../../controllers/distribution/salesman.controller';
import * as orders from '../../controllers/distribution/orders.controller';
import * as uploads from '../../controllers/distribution/uploads.controller';
import { idempotency } from '../../middleware/idempotency';

const router = Router();

router.get('/route/today', salesman.routeToday);
router.post('/visits/:visitId/checkin', salesman.visitCheckin);
router.get('/outlets/:id/cart-suggest', salesman.cartSuggest);

router.post('/orders/preview', orders.preview);
router.post('/orders', idempotency, orders.create);
router.get('/orders', salesman.myOrders);
router.get('/orders/:id', orders.get);
router.post('/orders/:id/cancel', idempotency, orders.cancel);

router.post('/uploads/sign', idempotency, uploads.sign);

export default router;

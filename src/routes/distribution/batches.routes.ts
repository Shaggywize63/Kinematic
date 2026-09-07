import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/batches.controller';
import { requireAdminOrAbove } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';

// Batch/lot on-hand, expiry reporting, and FEFO/FIFO consumption.
// Mounted at /api/v1/distribution/batches under requireModule('distribution_batches').
export const batchesRouter = Router();
batchesRouter.get('/', ctrl.list);
batchesRouter.get('/expiry-report', ctrl.expiry);
batchesRouter.get('/alerts', ctrl.alerts);
batchesRouter.post('/consume', requireAdminOrAbove, idempotency, ctrl.consume);

// Goods receiving (GRN) — creates a costed, dated batch layer.
// Mounted at /api/v1/distribution/receiving under requireModule('distribution_receiving').
export const receivingRouter = Router();
receivingRouter.post('/', requireAdminOrAbove, idempotency, ctrl.receive);

export default batchesRouter;

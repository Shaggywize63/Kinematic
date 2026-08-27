import { Router } from 'express';
import {
  adminListOutlets,
  adminMintToken,
  adminDeactivate,
  adminMintAll,
} from '../../controllers/distribution/capture.controller';

// Authed admin surface for consumer-capture tokens. Mounted with requireAuth +
// requireModule('distribution_consumer'); the dashboard uses these to build a
// printable per-outlet QR pack and enable/disable outlet capture links.
const router = Router();

router.get('/outlets', adminListOutlets);
router.post('/outlets/:outletId/token', adminMintToken);
router.post('/outlets/:outletId/deactivate', adminDeactivate);
router.post('/mint-all', adminMintAll);

export default router;

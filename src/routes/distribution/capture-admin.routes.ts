import { Router } from 'express';
import {
  adminListOutlets,
  adminMintToken,
  adminDeactivate,
  adminMintAll,
  adminGetConfig,
  adminSaveConfig,
} from '../../controllers/distribution/capture.controller';

// Authed admin surface for consumer-capture tokens. Mounted with requireAuth +
// requireModule('distribution_consumer'); the dashboard uses these to build a
// printable per-outlet QR pack and enable/disable outlet capture links.
const router = Router();

router.get('/outlets', adminListOutlets);
router.post('/outlets/:outletId/token', adminMintToken);
router.post('/outlets/:outletId/deactivate', adminDeactivate);
router.post('/mint-all', adminMintAll);
// Configurable capture form (the fields shown on the public QR page).
router.get('/config', adminGetConfig);
router.put('/config', adminSaveConfig);

export default router;

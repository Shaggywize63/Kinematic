import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { listBroadcastEntitlement, setBroadcastEntitlement } from '../controllers/broadcastEntitlement.controller';

// Platform-level entitlement management for the WhatsApp Campaigns add-on.
// Mounted under /api/v1/admin/broadcast-entitlement behind requireAuth; super-admin only.
const router = Router();

router.get('/', requireRole('super_admin'), listBroadcastEntitlement);
router.put('/:orgId', requireRole('super_admin'), setBroadcastEntitlement);

export default router;

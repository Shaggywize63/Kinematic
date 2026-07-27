import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { listEmailCampaignEntitlement, setEmailCampaignEntitlement } from '../controllers/emailCampaignEntitlement.controller';

// Platform-level entitlement management for the Email Campaigns add-on.
// Mounted under /api/v1/admin/email-campaign-entitlement behind requireAuth; super-admin only.
const router = Router();

router.get('/', requireRole('super_admin'), listEmailCampaignEntitlement);
router.put('/:orgId', requireRole('super_admin'), setEmailCampaignEntitlement);

export default router;

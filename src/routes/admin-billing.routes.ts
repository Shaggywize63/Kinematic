/**
 * admin-billing.routes.ts  —  mounted at /api/v1/admin/billing
 *
 * Admin Billing section: planogram vision API cost per client over a period.
 * Org-scoped (uses the caller's org); gated to admin-tier roles. Read-only.
 */
import { Router, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils';
import { BillingService } from '../services/billing.service';

const router = Router();
router.use(requireAuth);

// GET /api/v1/admin/billing?from=ISO&to=ISO
// Defaults to the last 30 days when from/to are omitted.
router.get(
  '/',
  requireRole('admin', 'super_admin', 'main_admin', 'client'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const now = new Date();
    const defFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const parse = (v: unknown, fallback: Date): string => {
      const d = typeof v === 'string' ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d.toISOString() : fallback.toISOString();
    };
    const from = parse(req.query.from, defFrom);
    const to = parse(req.query.to, now);
    const data = await BillingService.visionUsage(req.user.org_id, from, to);
    res.json({ success: true, data });
  }),
);

export default router;

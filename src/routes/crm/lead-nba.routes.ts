/**
 * Lead next-best-action endpoint.
 *
 * Mirrors the deal NBA route shape (/crm/ai/next-best-action/:dealId) but
 * for leads — exposed at /crm/ai/next-best-action/lead/:leadId so the
 * existing deal path is untouched.
 *
 * Mounted in app.ts BEFORE the main CRM router so this more-specific path
 * takes precedence. The /:dealId handler inside the main CRM router never
 * sees these requests.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { compute as computeLeadNba } from '../../services/crm/ai/leadNextBestAction.service';
import type { AuthRequest } from '../../types';
import { requireModule } from '../../middleware/rbac';

const router: Router = Router();
router.use(requireModule('crm'));

function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);
}

router.post(
  '/:leadId',
  wrap(async (req, res) => {
    const auth = req as AuthRequest;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = auth.user! as any;
    // Pin to the caller's client so a client-A user can't pull NBA for a
    // client-B lead. Null (org-level admin) keeps the org-wide behaviour.
    const out = await computeLeadNba(user.org_id, user.client_id ?? null, req.params.leadId, true);
    if (!out) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    return res.json({ success: true, data: out });
  }),
);

export default router;

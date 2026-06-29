/**
 * Append-only Updates timeline routes on a lead.
 *   POST /:leadId/updates  — add an update entry
 *   GET  /:leadId/updates  — list (newest first)
 *
 * Mounted in app.ts at /api/v1/crm/leads BEFORE the main CRM router. The
 * more-specific /:leadId/updates patterns are caught here; all other
 * /leads/* paths fall through to the main router untouched (Express only
 * stops at this mount if a route handler responds).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  listUpdates,
  createUpdate,
  updateUpdate,
  deleteUpdate,
} from '../../services/crm/leadUpdates.service';
import { persistMentions, parseMentionIds } from '../../services/crm/messaging.service';
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

const createSchema = z.object({ body: z.string().min(1).max(2000) });

router.post(
  '/:leadId/updates',
  wrap(async (req, res) => {
    const auth = req as AuthRequest;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = auth.user! as any;
    const parsed = createSchema.parse(req.body);
    const update = await createUpdate(
      user.org_id,
      user.client_id ?? null,
      req.params.leadId,
      user.id,
      parsed.body,
    );
    // Parse @[uid] tokens, scope-check them, persist + fan out notifications.
    // Errors bubble up as 403 if the caller mentioned someone outside their
    // city ∩ hierarchy subtree — saves us writing the mention quietly and
    // showing the user a phantom send.
    const mentionIds = parseMentionIds(parsed.body);
    if (mentionIds.length > 0) {
      await persistMentions(auth, 'lead_update', update.id, mentionIds);
    }
    return res.status(201).json({ success: true, data: update });
  }),
);

router.get(
  '/:leadId/updates',
  wrap(async (req, res) => {
    const auth = req as AuthRequest;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = auth.user! as any;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const updates = await listUpdates(user.org_id, req.params.leadId, limit);
    return res.json({ success: true, data: updates });
  }),
);

// Edit the body of an existing update. Author-only — enforced in the service.
router.patch(
  '/:leadId/updates/:updateId',
  wrap(async (req, res) => {
    const auth = req as AuthRequest;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = auth.user! as any;
    const parsed = createSchema.parse(req.body);
    const update = await updateUpdate(
      user.org_id,
      user.id,
      req.params.leadId,
      req.params.updateId,
      parsed.body,
    );
    return res.json({ success: true, data: update });
  }),
);

// Delete an update. Author or admin — enforced in the service.
router.delete(
  '/:leadId/updates/:updateId',
  wrap(async (req, res) => {
    const auth = req as AuthRequest;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = auth.user! as any;
    await deleteUpdate(
      user.org_id,
      user.id,
      user.role,
      req.params.leadId,
      req.params.updateId,
    );
    return res.json({ success: true, data: { deleted: true } });
  }),
);

export default router;

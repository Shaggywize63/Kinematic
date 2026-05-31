/**
 * Email alert CRUD + manual dispatch.
 * Mounted at /api/v1/crm/email-alerts.
 */
import { Router, Request, Response, NextFunction } from 'express';
import {
  createAlert, listAlerts, getAlert, cancelAlert, dispatchAlert,
} from '../../services/crm/emailAlerts.service';
import type { AuthRequest } from '../../types';

const router: Router = Router();
const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get('/', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  const rows = await listAlerts(u.org_id, Number(req.query.limit) || 100);
  res.json({ success: true, data: rows });
}));

router.get('/:id', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  const row = await getAlert(u.org_id, req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'Alert not found' });
  res.json({ success: true, data: row });
}));

router.post('/', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  const b = (req.body || {}) as any;
  const row = await createAlert({
    org_id: u.org_id, client_id: u.client_id ?? null, created_by: u.id,
    name: b.name || 'Untitled alert',
    template_id: b.template_id ?? null,
    from_email: b.from_email,
    from_name: b.from_name ?? null,
    to_emails: Array.isArray(b.to_emails) ? b.to_emails : [],
    cc_emails: Array.isArray(b.cc_emails) ? b.cc_emails : null,
    bcc_emails: Array.isArray(b.bcc_emails) ? b.bcc_emails : null,
    subject_override: b.subject_override ?? null,
    body_override: b.body_override ?? null,
    variables: b.variables ?? null,
    scheduled_at: b.scheduled_at ?? null,
  });
  res.status(201).json({ success: true, data: row });
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  await cancelAlert(u.org_id, req.params.id);
  res.json({ success: true });
}));

// Manual "send now" — bypasses the scheduler cron when a rep wants to
// fire a scheduled alert ahead of its time.
router.post('/:id/send-now', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  const row = await getAlert(u.org_id, req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'Alert not found' });
  void dispatchAlert((row as any).id);
  res.json({ success: true });
}));

export default router;

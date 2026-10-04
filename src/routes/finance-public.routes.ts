/**
 * Public (no login) invoice/quote links — mounted at /api/v1/finance/public BEFORE the
 * global requireAuth gate. The unguessable share token in the path is the credential.
 *
 * The customer's browser sends no auth and no project header, so the share link carries
 * `?p=<project>`; we run the request inside that project (production would otherwise
 * fall back to the Tata default project). Only known project keys are accepted.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { perRouteLimit } from '../middleware/security';
import { asyncHandler } from '../utils/asyncHandler';
import { isKnownProject, runWithProject } from '../lib/projects';
import { publicDocument, publicPdf } from '../services/finance/documents.service';

const router = Router();
router.use(perRouteLimit({ windowMs: 60_000, max: 60 }));

router.use((req: Request, _res: Response, next: NextFunction) => {
  const p = String(req.query.p ?? '').trim().toLowerCase();
  if (p && isKnownProject(p)) return runWithProject(p, () => next());
  return next();
});

router.get('/:token', asyncHandler(async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ success: true, data: await publicDocument(req.params.token) });
}));

router.get('/:token/pdf', asyncHandler(async (req: Request, res: Response) => {
  const { number, pdf } = await publicPdf(req.params.token);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${number.replace(/[^\w.-]/g, '_')}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
}));

export default router;

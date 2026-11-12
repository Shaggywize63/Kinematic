/**
 * HRMS phase 6 (the Asset register on the server) — mounted by hrms.routes.ts at /api/v1/hrms/assets, so it sits behind
 * requireAuth + requireHrmsAccess and inherits the phase 1 rules: master admin only (never while impersonating), the
 * caller's own org with client_id NULL (X-Client-Id ignored), `{ success, data }` responses, no-store, 1 MB bodies,
 * 503 HRMS_NOT_READY while the tables are missing, and HRMS's own error handler.
 *
 *   GET    bootstrap                     { assets, events, server_time } (all of the org's assets and every event)
 *   POST   assets                        addAsset: server assigns the tag (nextTag by type) unless a free one is sent;
 *                                        creates the asset (in_stock) + its 'purchased' event; idempotent on a client `id`.
 *                                        Returns { asset, event } (the asset + its purchased event).
 *   POST   assets/:id/issue              { person_id, condition, ack, note? }
 *   POST   assets/:id/return             { condition, next (in_stock|in_repair|retired), note? }
 *   POST   assets/:id/transfer           { to_id, condition, ack, note? }
 *   POST   assets/:id/repair-out         { note? }
 *   POST   assets/:id/repair-back        { condition, note? }
 *   POST   assets/:id/lost               { note? }
 *   POST   assets/:id/retire             { note? }
 *
 * Each command is atomic and returns { asset, event } (the updated asset + the appended event). Refusals are 409
 * ASSET_STATE (illegal transition), 400 VALIDATION (serial/tag clash, bad input, acknowledgement/person), 404 NOT_FOUND,
 * 503 HRMS_NOT_READY, with `{ success: false, error: <the dashboard's plain reason>, code }`.
 *
 * There is no metadata edit or delete: the dashboard's rewards store has no editAsset/deleteAsset, and the event history
 * is append-only, so no PUT/DELETE is exposed here.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import { parse } from '../services/hrms/schemas';
import {
  assetCreate, issueBody, lostBody, repairBackBody, repairOutBody, retireBody, returnBody, transferBody,
} from '../services/hrms/assets/schemas';
import { assetsBootstrap } from '../services/hrms/assets/bootstrap.service';
import * as assets from '../services/hrms/assets/assets.service';

const router = Router();

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => { res.json(await assetsBootstrap(scopeOf(req))); }));

// ── create (addAsset) ─────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { data, created } = await assets.createAsset(scopeOf(req), parse(assetCreate, body(req)));
  res.status(created ? 201 : 200).json(data);
}));

// ── the seven commands (each returns { asset, event }) ──────────────────────────
router.post('/:id/issue', asyncHandler(async (req: Request, res: Response) => {
  res.json(await assets.issueAsset(scopeOf(req), idParam(req), parse(issueBody, body(req))));
}));
router.post('/:id/return', asyncHandler(async (req: Request, res: Response) => {
  res.json(await assets.returnAsset(scopeOf(req), idParam(req), parse(returnBody, body(req))));
}));
router.post('/:id/transfer', asyncHandler(async (req: Request, res: Response) => {
  res.json(await assets.transferAsset(scopeOf(req), idParam(req), parse(transferBody, body(req))));
}));
router.post('/:id/repair-out', asyncHandler(async (req: Request, res: Response) => {
  res.json(await assets.sendToRepair(scopeOf(req), idParam(req), parse(repairOutBody, body(req))));
}));
router.post('/:id/repair-back', asyncHandler(async (req: Request, res: Response) => {
  res.json(await assets.backFromRepair(scopeOf(req), idParam(req), parse(repairBackBody, body(req))));
}));
router.post('/:id/lost', asyncHandler(async (req: Request, res: Response) => {
  res.json(await assets.markLost(scopeOf(req), idParam(req), parse(lostBody, body(req))));
}));
router.post('/:id/retire', asyncHandler(async (req: Request, res: Response) => {
  res.json(await assets.retireAsset(scopeOf(req), idParam(req), parse(retireBody, body(req))));
}));

export default router;

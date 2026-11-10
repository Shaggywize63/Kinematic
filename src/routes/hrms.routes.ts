/**
 * HRMS phase 1 (organisation + people) — mounted at /api/v1/hrms behind requireAuth + requireHrmsAccess.
 * Master admin only, never while impersonating. Always the caller's own org, client_id NULL (X-Client-Id is ignored).
 *
 *   GET    bootstrap                      everything for the org in one call (employees with documents + history, masked)
 *   POST   entities | locations | departments | designations        create (idempotent on a client `id`)
 *   PUT    <plural>/:id                                             partial update
 *   DELETE <plural>/:id                                             409 with a reason while something still uses the row
 *   POST   employees                      create; the server assigns the code (prefix + counter) unless a free one is sent
 *   PUT    employees/:id                  partial update; writes one change-log row per labelled field that changed
 *   DELETE employees/:id                  drafts (status onboarding) only; soft delete
 *   POST   employees/import               { rows (max 500), dry_run? } per-row errors, per-row atomic
 *   POST   employees/:id/documents        PUT|DELETE employees/:id/documents/:docId
 *   POST   employees/:id/reveal           { field: pan|bank|aadhaar, reason } -> full value, written to the access log
 *   GET    access-log?employee_id=        newest first, at most 200
 *   PUT    settings/employee_code_prefix  { value }
 *
 * PAN and bank details are encrypted at rest (lib/hrmsCrypto) and masked in every response; they are write-only.
 * If the HRMS tables are not there yet (migration_hrms_core.sql not applied) every call answers 503 HRMS_NOT_READY.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { logger } from '../lib/logger';
import { perRouteLimit } from '../middleware/security';
import { requireHrmsAccess } from '../middleware/hrmsAccess';
import { scopeOf, UUID_RE } from '../services/hrms/scope';
import {
  CODE_PREFIX_KEY, codePrefixBody, departmentCreate, departmentUpdate, designationCreate, designationUpdate, documentCreate, documentUpdate,
  employeeCreate, employeeUpdate, entityCreate, entityUpdate, importBody, issueText, locationCreate, locationUpdate, parse, revealBody,
} from '../services/hrms/schemas';
import { bootstrap } from '../services/hrms/bootstrap.service';
import { createMaster, deleteMaster, MasterKind, updateMaster } from '../services/hrms/masters.service';
import * as employees from '../services/hrms/employees.service';
import * as documents from '../services/hrms/documents.service';
import * as privacy from '../services/hrms/privacy.service';
import * as settings from '../services/hrms/settings.service';
import { importEmployees } from '../services/hrms/import.service';

const router = Router();

router.use(requireHrmsAccess);

// Personal data: never cache, never accept a large body (1 MB; the global parser allows 2 MB), and throttle like other admin routes.
const MAX_BODY_BYTES = 1_000_000;
const inTest = () => process.env.NODE_ENV === 'test';
router.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return next(new AppError(413, 'The request is larger than 1 MB', 'PAYLOAD_TOO_LARGE'));
  return next();
});
router.use(perRouteLimit({ windowMs: 60_000, max: 300, skip: inTest }));

router.use((_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => (body && typeof body === 'object' && 'success' in (body as object) ? json(body) : json({ success: true, data: body }));
  next();
});

const idParam = (req: Request, name = 'id') => {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const body = (req: Request) => req.body ?? {};

// ── bootstrap ───────────────────────────────────────────────────────────────
router.get('/bootstrap', asyncHandler(async (req: Request, res: Response) => res.json(await bootstrap(scopeOf(req)))));

// ── organisation structure ──────────────────────────────────────────────────
const MASTER_ROUTES: Array<{ path: string; kind: MasterKind; create: Parameters<typeof parse>[0]; update: Parameters<typeof parse>[0] }> = [
  { path: 'entities', kind: 'entities', create: entityCreate, update: entityUpdate },
  { path: 'locations', kind: 'locations', create: locationCreate, update: locationUpdate },
  { path: 'departments', kind: 'departments', create: departmentCreate, update: departmentUpdate },
  { path: 'designations', kind: 'designations', create: designationCreate, update: designationUpdate },
];
for (const m of MASTER_ROUTES) {
  router.post(`/${m.path}`, asyncHandler(async (req: Request, res: Response) => {
    const { row, created } = await createMaster(scopeOf(req), m.kind, parse(m.create, body(req)));
    res.status(created ? 201 : 200).json(row);
  }));
  router.put(`/${m.path}/:id`, asyncHandler(async (req: Request, res: Response) => {
    res.json(await updateMaster(scopeOf(req), m.kind, idParam(req), parse(m.update, body(req))));
  }));
  router.delete(`/${m.path}/:id`, asyncHandler(async (req: Request, res: Response) => {
    res.json(await deleteMaster(scopeOf(req), m.kind, idParam(req)));
  }));
}

// ── employees ───────────────────────────────────────────────────────────────
router.post('/employees/import', asyncHandler(async (req: Request, res: Response) => {
  const { rows, dry_run } = parse(importBody, body(req));
  const result = await importEmployees(scopeOf(req), rows, dry_run === true);
  res.status(!result.dry_run && result.created > 0 ? 201 : 200).json(result);
}));
router.post('/employees', asyncHandler(async (req: Request, res: Response) => {
  const { employee, created } = await employees.createEmployee(scopeOf(req), parse(employeeCreate, body(req)));
  res.status(created ? 201 : 200).json(employee);
}));
router.put('/employees/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await employees.updateEmployee(scopeOf(req), idParam(req), parse(employeeUpdate, body(req))));
}));
router.delete('/employees/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(await employees.deleteEmployee(scopeOf(req), idParam(req)));
}));

// documents (metadata only; file upload is a later phase)
router.post('/employees/:id/documents', asyncHandler(async (req: Request, res: Response) => {
  const { document, created } = await documents.addDocument(scopeOf(req), idParam(req), parse(documentCreate, body(req)));
  res.status(created ? 201 : 200).json(document);
}));
router.put('/employees/:id/documents/:docId', asyncHandler(async (req: Request, res: Response) => {
  res.json(await documents.updateDocument(scopeOf(req), idParam(req), idParam(req, 'docId'), parse(documentUpdate, body(req))));
}));
router.delete('/employees/:id/documents/:docId', asyncHandler(async (req: Request, res: Response) => {
  res.json(await documents.deleteDocument(scopeOf(req), idParam(req), idParam(req, 'docId')));
}));

// reveal a sensitive value (needs a reason; written to the access log) + read the log
router.post('/employees/:id/reveal', perRouteLimit({ windowMs: 60_000, max: 30, skip: inTest }), asyncHandler(async (req: Request, res: Response) => {
  const { field, reason } = parse(revealBody, body(req));
  res.json(await privacy.revealField(scopeOf(req), idParam(req), field, reason));
}));
router.get('/access-log', asyncHandler(async (req: Request, res: Response) => {
  const employeeId = req.query.employee_id === undefined ? undefined : String(req.query.employee_id);
  if (employeeId !== undefined && !UUID_RE.test(employeeId)) throw new AppError(400, 'employee_id: Invalid id', 'VALIDATION');
  const limit = parseInt(String(req.query.limit ?? '200'), 10);
  res.json(await privacy.listAccessLog(scopeOf(req), employeeId, Number.isFinite(limit) ? limit : 200));
}));

// ── settings ────────────────────────────────────────────────────────────────
router.put('/settings/:key', asyncHandler(async (req: Request, res: Response) => {
  if (req.params.key !== CODE_PREFIX_KEY) throw new AppError(404, 'Unknown setting', 'NOT_FOUND');
  res.json(await settings.setCodePrefix(scopeOf(req), parse(codePrefixBody, body(req)).value));
}));

// ── errors ──────────────────────────────────────────────────────────────────
// HRMS answers its own errors. The app-wide handler logs the request BODY (which here can hold a PAN or a bank account
// number) and turns every 5xx into a bare "Internal server error", which would also hide the 503 HRMS_NOT_READY the
// dashboard shows a "storage is not set up" state for. This one logs the route and status only, never the body.
const EXPOSED_5XX = new Set(['HRMS_NOT_READY', 'HRMS_KEY_MISSING', 'HRMS_KEY_INVALID', 'DECRYPT_FAILED']);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
    if (status < 500 || EXPOSED_5XX.has(code)) message = err.message; else code = 'INTERNAL_ERROR';
  } else if (err instanceof ZodError) {
    status = 400; code = 'VALIDATION'; message = issueText(err.issues);
  } else if ((err as { type?: string })?.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'The request is larger than 1 MB';
  }
  const line = `[hrms] ${req.method} ${req.baseUrl}${req.path} -> ${status} ${code}`;
  if (status >= 500 && code !== 'HRMS_NOT_READY') logger.error(`${line}: ${(err as { message?: string })?.message ?? 'unknown'}`);
  else logger.warn(line);
  res.status(status).json({ success: false, error: message, code, ...((req as { id?: string }).id ? { request_id: (req as { id?: string }).id } : {}) });
});

export default router;

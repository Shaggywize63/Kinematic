/**
 * Finance (invoicing) — mounted at /api/v1/finance behind requireAuth + requireFinanceAccess.
 * Master admin only today; shareable with a client by granting the `finance` module.
 *
 *   settings                  GET, PUT
 *   customers | items         list / create / get / update / delete
 *   invoices | quotes         list / create / get / update / delete, send, pdf, share-link, clone
 *                             invoices: mark-sent, void   quotes: mark-sent, accept, decline, convert
 *   payments                  list / create / get / update / delete, apply
 *   import/invoices/preview|commit   bring in previously issued invoices from a CSV/XLSX export
 *   reports/dashboard         overview (receivables ageing, sales vs receipts)
 *   reports/:name             tabular reports; ?format=csv exports the same filters
 *
 * Public, no-login invoice links live in finance-public.routes.ts.
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils';
import { currentProjectKey, runWithProject } from '../lib/projects';
import { requireFinanceAccess, isMasterCaller } from '../middleware/financeAccess';
import type { AuthRequest } from '../types';
import { scopeOf } from '../services/finance/scope';
import * as masters from '../services/finance/masters.service';
import * as docs from '../services/finance/documents.service';
import * as payments from '../services/finance/payments.service';
import * as reports from '../services/finance/reports.service';
import * as importer from '../services/finance/import.service';

const router = Router();
router.use(requireFinanceAccess);

router.use((_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => (body && typeof body === 'object' && 'success' in (body as object) ? json(body) : json({ success: true, data: body }));
  next();
});

// Returns the zod-validated body. Typed `any` because the repo isn't compiled with strictNullChecks,
// which makes z.infer mark every field optional; the services declare the real input types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(schema: z.ZodTypeAny, body: unknown): any {
  const r = schema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new AppError(400, `${i?.path.length ? `${i.path.join('.')}: ` : ''}${i?.message ?? 'Invalid input'}`, 'VALIDATION');
  }
  return r.data;
}
const idParam = (req: Request) => {
  const id = req.params.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError(400, 'Invalid id', 'VALIDATION');
  return id;
};
const paged = (res: Response, r: { rows: unknown[]; total: number; page: number; limit: number }) =>
  res.json({ success: true, data: r.rows, pagination: { total: r.total, page: r.page, limit: r.limit } });

// ── schemas ─────────────────────────────────────────────────────────────────
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const str = (max: number) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const money = z.coerce.number().finite().min(0).max(1e9);
const stateCode = z.preprocess(blank, z.string().regex(/^\d{2}$/, 'Use the 2-digit GST state code').nullable().optional());
const gstin = z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
  z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN').nullable().optional());
const pan = z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
  z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').nullable().optional());
const email = z.preprocess(blank, z.string().trim().email('Invalid email address').max(200).nullable().optional());
const address = z.object({
  attention: str(120), line1: str(200), line2: str(200), city: str(100), state: str(100), pincode: str(12), country: str(80), phone: str(30),
}).partial();

const settingsSchema = z.object({
  business_name: str(200), email, phone: str(30), website: str(200),
  address_line1: str(200), address_line2: str(200), city: str(100), state: str(100), state_code: stateCode, pincode: str(12), country: str(80),
  gstin, pan,
  // Either an https link, or a PNG/JPEG uploaded in Finance Settings (stored inline as a data URL so the
  // invoice never depends on an external host). 400 KB of base64 is ample for a downsized logo.
  logo_url: z.preprocess(blank, z.string().max(400_000).refine(
    (v) => (/^https:\/\//i.test(v) && v.length <= 1000) || /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(v),
    'Logo must be an https link or an uploaded PNG/JPEG',
  ).nullable().optional()),
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12),
  invoice_prefix: z.string().trim().max(20), quote_prefix: z.string().trim().max(20), payment_prefix: z.string().trim().max(20),
  invoice_next_number: z.coerce.number().int().min(1).max(1e9), quote_next_number: z.coerce.number().int().min(1).max(1e9),
  payment_next_number: z.coerce.number().int().min(1).max(1e9), number_padding: z.coerce.number().int().min(1).max(10),
  default_payment_terms_days: z.coerce.number().int().min(0).max(365),
  default_notes: str(2000), default_terms: str(4000),
  bank_details: z.object({ account_name: str(120), bank_name: str(120), account_number: str(40), ifsc: str(20), branch: str(120), upi_id: str(80) }).partial(),
  template: z.object({
    accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/), show_logo: z.boolean(), show_bank_details: z.boolean(),
    signature_name: str(80), footer_text: str(200),
  }).partial(),
  email_subject_template: str(200), email_body_template: str(3000),
}).partial();

const customerBase = z.object({
  customer_type: z.enum(['business', 'individual']),
  salutation: str(20), first_name: str(80), last_name: str(80), company_name: str(160),
  display_name: z.string().trim().min(1, 'Display name is required').max(200),
  email, work_phone: str(30), mobile: str(30), language: str(40), currency: str(3),
  gst_treatment: z.preprocess(blank, z.enum(['registered_regular', 'registered_composition', 'unregistered', 'consumer', 'overseas', 'sez']).nullable().optional()),
  gstin, place_of_supply: stateCode, pan, tax_preference: z.enum(['taxable', 'exempt']),
  payment_terms_days: z.coerce.number().int().min(0).max(365),
  billing_address: address, shipping_address: address,
  contact_persons: z.array(z.object({ salutation: str(20), first_name: str(80), last_name: str(80), email, work_phone: str(30), mobile: str(30), designation: str(80) })).max(20),
  remarks: str(2000), portal_enabled: z.boolean(), is_active: z.boolean(),
});
const customerCreate = customerBase.partial().required({ display_name: true });
const customerUpdate = customerBase.partial();

const itemBase = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  item_type: z.enum(['goods', 'service']), unit: str(30), hsn_sac: str(20),
  tax_preference: z.enum(['taxable', 'exempt']),
  gst_rate: z.coerce.number().min(0).max(100), selling_price: money, description: str(1000), is_active: z.boolean(),
});
const itemCreate = itemBase.partial().required({ name: true });
const itemUpdate = itemBase.partial();

const line = z.object({
  item_id: z.preprocess(blank, z.string().uuid().nullable().optional()),
  name: z.string().trim().min(1, 'Item name is required').max(200),
  description: str(1000), hsn_sac: str(20), unit: str(30),
  quantity: z.coerce.number().gt(0, 'Quantity must be greater than 0').max(1e9),
  rate: money, discount_pct: z.coerce.number().min(0).max(100).optional(), gst_rate: z.coerce.number().min(0).max(100).optional(),
});
const documentSchema = z.object({
  customer_id: z.string().uuid('Select a customer'),
  reference_number: str(80), subject: str(200),
  issue_date: dateStr.optional(), due_date: z.preprocess(blank, dateStr.nullable().optional()), expiry_date: z.preprocess(blank, dateStr.nullable().optional()),
  payment_terms_days: z.coerce.number().int().min(0).max(365).optional(),
  place_of_supply: stateCode, bill_to: address.optional(), ship_to: address.optional(),
  items: z.array(line).min(1, 'Add at least one item').max(200),
  adjustment: z.coerce.number().min(-1e7).max(1e7).optional(), adjustment_label: str(60),
  notes: str(2000), terms: str(4000),
});
const sendSchema = z.object({
  to: email, cc: z.array(z.string().email()).max(5).optional(), subject: str(200), message: str(5000), attach_pdf: z.boolean().optional(),
});
const allocations = z.array(z.object({ document_id: z.string().uuid(), amount: z.coerce.number().gt(0).max(1e9) })).max(100);
const paymentSchema = z.object({
  customer_id: z.string().uuid('Select a customer'), payment_date: dateStr.optional(), amount: z.coerce.number().gt(0, 'Amount must be greater than 0').max(1e10),
  mode: z.enum(['cash', 'bank_transfer', 'upi', 'cheque', 'card', 'other']).optional(), reference: str(120), notes: str(1000),
  allocations: allocations.optional(), auto_apply: z.boolean().optional(),
});
const paymentPatch = z.object({ payment_date: dateStr, mode: z.enum(['cash', 'bank_transfer', 'upi', 'cheque', 'card', 'other']), reference: str(120), notes: str(1000) }).partial();

// ── meta / settings ─────────────────────────────────────────────────────────
router.get('/meta', asyncHandler(async (req: Request, res: Response) => {
  const provider = (process.env.EMAIL_PROVIDER || 'stub').toLowerCase();
  res.json({ is_master: isMasterCaller(req as AuthRequest), email_provider: provider, email_live: provider !== 'stub' });
}));
router.get('/settings', asyncHandler(async (req: Request, res: Response) => res.json(await masters.getSettings(scopeOf(req)))));
router.put('/settings', asyncHandler(async (req: Request, res: Response) => {
  res.json(await masters.updateSettings(scopeOf(req), parse(settingsSchema, req.body)));
}));

// ── customers ───────────────────────────────────────────────────────────────
router.get('/customers', asyncHandler(async (req: Request, res: Response) => paged(res, await masters.listCustomers(scopeOf(req), req.query))));
router.post('/customers', asyncHandler(async (req: Request, res: Response) => res.status(201).json(await masters.createCustomer(scopeOf(req), parse(customerCreate, req.body)))));
router.get('/customers/:id', asyncHandler(async (req: Request, res: Response) => res.json(await masters.getCustomer(scopeOf(req), idParam(req)))));
router.put('/customers/:id', asyncHandler(async (req: Request, res: Response) => res.json(await masters.updateCustomer(scopeOf(req), idParam(req), parse(customerUpdate, req.body)))));
router.delete('/customers/:id', asyncHandler(async (req: Request, res: Response) => res.json(await masters.deleteCustomer(scopeOf(req), idParam(req)))));
router.get('/customers/:id/open-invoices', asyncHandler(async (req: Request, res: Response) => res.json(await payments.openInvoicesForCustomer(scopeOf(req), idParam(req)))));

// ── items ───────────────────────────────────────────────────────────────────
router.get('/items', asyncHandler(async (req: Request, res: Response) => paged(res, await masters.listItems(scopeOf(req), req.query))));
router.post('/items', asyncHandler(async (req: Request, res: Response) => res.status(201).json(await masters.createItem(scopeOf(req), parse(itemCreate, req.body)))));
router.get('/items/:id', asyncHandler(async (req: Request, res: Response) => res.json(await masters.getItem(scopeOf(req), idParam(req)))));
router.put('/items/:id', asyncHandler(async (req: Request, res: Response) => res.json(await masters.updateItem(scopeOf(req), idParam(req), parse(itemUpdate, req.body)))));
router.delete('/items/:id', asyncHandler(async (req: Request, res: Response) => res.json(await masters.deleteItem(scopeOf(req), idParam(req)))));

// ── invoices + quotes ───────────────────────────────────────────────────────
function mountDocuments(path: 'invoices' | 'quotes', type: docs.DocType) {
  const base = `/${path}`;
  router.get(base, asyncHandler(async (req: Request, res: Response) => paged(res, await docs.listDocuments(scopeOf(req), type, req.query))));
  router.post(base, asyncHandler(async (req: Request, res: Response) => res.status(201).json(await docs.createDocument(scopeOf(req), type, parse(documentSchema, req.body)))));
  router.get(`${base}/:id`, asyncHandler(async (req: Request, res: Response) => res.json(await docs.getDocument(scopeOf(req), idParam(req), type))));
  router.put(`${base}/:id`, asyncHandler(async (req: Request, res: Response) => res.json(await docs.updateDocument(scopeOf(req), type, idParam(req), parse(documentSchema, req.body)))));
  router.delete(`${base}/:id`, asyncHandler(async (req: Request, res: Response) => res.json(await docs.deleteDocument(scopeOf(req), type, idParam(req)))));
  router.post(`${base}/:id/send`, asyncHandler(async (req: Request, res: Response) => res.json(await docs.sendDocument(scopeOf(req), type, idParam(req), parse(sendSchema, req.body ?? {})))));
  router.post(`${base}/:id/mark-sent`, asyncHandler(async (req: Request, res: Response) => res.json(await docs.markSent(scopeOf(req), type, idParam(req)))));
  router.post(`${base}/:id/clone`, asyncHandler(async (req: Request, res: Response) => res.status(201).json(await docs.cloneDocument(scopeOf(req), type, idParam(req)))));
  router.get(`${base}/:id/share-link`, asyncHandler(async (req: Request, res: Response) => res.json(await docs.shareLink(scopeOf(req), type, idParam(req)))));
  router.get(`${base}/:id/pdf`, asyncHandler(async (req: Request, res: Response) => {
    const { number, pdf } = await docs.documentPdf(scopeOf(req), type, idParam(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${number.replace(/[^\w.-]/g, '_')}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }));
}
mountDocuments('invoices', 'invoice');
mountDocuments('quotes', 'quote');
router.post('/invoices/:id/void', asyncHandler(async (req: Request, res: Response) => res.json(await docs.voidInvoice(scopeOf(req), idParam(req)))));
router.post('/quotes/:id/accept', asyncHandler(async (req: Request, res: Response) => res.json(await docs.setQuoteStatus(scopeOf(req), idParam(req), 'accepted'))));
router.post('/quotes/:id/decline', asyncHandler(async (req: Request, res: Response) => res.json(await docs.setQuoteStatus(scopeOf(req), idParam(req), 'declined'))));
router.post('/quotes/:id/convert', asyncHandler(async (req: Request, res: Response) => res.status(201).json(await docs.convertQuoteToInvoice(scopeOf(req), idParam(req)))));

// ── payments received ───────────────────────────────────────────────────────
router.get('/payments', asyncHandler(async (req: Request, res: Response) => paged(res, await payments.listPayments(scopeOf(req), req.query))));
router.post('/payments', asyncHandler(async (req: Request, res: Response) => res.status(201).json(await payments.recordPayment(scopeOf(req), parse(paymentSchema, req.body)))));
router.get('/payments/:id', asyncHandler(async (req: Request, res: Response) => res.json(await payments.getPayment(scopeOf(req), idParam(req)))));
router.put('/payments/:id', asyncHandler(async (req: Request, res: Response) => res.json(await payments.updatePayment(scopeOf(req), idParam(req), parse(paymentPatch, req.body)))));
router.delete('/payments/:id', asyncHandler(async (req: Request, res: Response) => res.json(await payments.deletePayment(scopeOf(req), idParam(req)))));
router.post('/payments/:id/apply', asyncHandler(async (req: Request, res: Response) => {
  res.json(await payments.applyPayment(scopeOf(req), idParam(req), parse(z.object({ allocations }), req.body).allocations));
}));

// ── import previous invoices (CSV / XLSX) ───────────────────────────────────
const uploadFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');
/** multer errors (too large, wrong field) become clean 400s instead of 500s.
 *  multer finishes inside a stream event callback, where the per-request project
 *  (AsyncLocalStorage) is no longer bound — without re-entering it, the handler
 *  falls back to the default (Tata) project and queries a database that has no
 *  finance tables ("relation public.finance_settings does not exist"). */
const withFile = (req: Request, res: Response, next: NextFunction) => {
  const project = currentProjectKey();
  uploadFile(req, res, (err: unknown) => runWithProject(project, () => {
    if (!err) return next();
    const e = err as { code?: string; message?: string };
    return next(new AppError(400, e.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB. Split it and import in parts.' : (e.message || 'Upload failed'), 'UPLOAD'));
  }));
};
const importOptions = z.object({ create_customers: z.boolean(), allow_total_mismatch: z.boolean(), advance_numbering: z.boolean() }).partial();
function importInput(req: Request) {
  if (!req.file) throw new AppError(400, 'Choose a .csv or .xlsx file to import', 'NO_FILE');
  let raw: unknown = {};
  try { raw = req.body?.options ? JSON.parse(String(req.body.options)) : {}; } catch { throw new AppError(400, 'Invalid import options', 'VALIDATION'); }
  const opts = { ...importer.DEFAULT_OPTIONS, ...parse(importOptions, raw) } as importer.ImportOptions;
  return { name: req.file.originalname, buffer: req.file.buffer, opts };
}
router.post('/import/invoices/preview', withFile, asyncHandler(async (req: Request, res: Response) => {
  const f = importInput(req);
  res.json(await importer.previewInvoiceImport(scopeOf(req), f.name, f.buffer, f.opts));
}));
router.post('/import/invoices/commit', withFile, asyncHandler(async (req: Request, res: Response) => {
  const f = importInput(req);
  res.status(201).json(await importer.commitInvoiceImport(scopeOf(req), f.name, f.buffer, f.opts));
}));

// ── reports ─────────────────────────────────────────────────────────────────
router.get('/reports/dashboard', asyncHandler(async (req: Request, res: Response) => res.json(await reports.dashboard(scopeOf(req), req.query))));
router.get('/reports/:name', asyncHandler(async (req: Request, res: Response) => {
  const fn = reports.REPORTS[req.params.name];
  if (!fn) throw new AppError(404, 'Unknown report', 'NOT_FOUND');
  const report = await fn(scopeOf(req), req.query);
  if (String(req.query.format).toLowerCase() === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.csv"`);
    return res.send(reports.reportToCsv(report));
  }
  return res.json(report);
}));

export default router;

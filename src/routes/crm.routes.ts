/**
 * CRM module — single routes file with sub-routers per resource.
 * Mounted at /api/v1/crm in src/app.ts.
 *
 * Controllers are inlined (thin) to keep a single file as the routing
 * source-of-truth. All real logic lives in services/crm/*.
 */
import express, { Request, Response, NextFunction, Router } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { AppError } from '../utils';
import { supabaseAdmin } from '../lib/supabase';

import { demoCrmMiddleware } from '../utils/demoCrm';
import * as v from '../validators/crm.validators';
import * as crud from '../services/crm/crud.service';
import * as leadsSvc from '../services/crm/leads.service';
import * as dealsSvc from '../services/crm/deals.service';
import * as importSvc from '../services/crm/import.service';
import * as analyticsSvc from '../services/crm/analytics.service';
import * as emailsSvc from '../services/crm/emails.service';
import * as whatsappSvc from '../services/crm/whatsapp.service';
import * as productsSvc from '../services/crm/products.service';
import * as nbaSvc from '../services/crm/ai/nextBestAction.service';
import * as winSvc from '../services/crm/ai/winProbability.service';
import * as autoRespSvc from '../services/crm/ai/autoResponse.service';
import * as summarizeSvc from '../services/crm/ai/summarize.service';
import * as kiniTools from '../services/crm/ai/kiniTools.service';
import { chatWithTools } from '../services/crm/ai/aiClient';
import { stampOwnerNames, stampOwnerName } from '../services/crm/owners.helper';

const router: Router = express.Router();

// ----- PUBLIC ROUTES (registered before requireAuth) -----
// Email tracking + WhatsApp webhook accept signed/tokened requests; the
// shared secret in the URL path or body IS the auth.
router.get('/emails/track/open/:token', async (req, res) => {
  await emailsSvc.recordOpen(req.params.token).catch(() => {});
  res.set('Content-Type', 'image/gif');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});
router.get('/emails/track/click/:token', async (req, res) => {
  await emailsSvc.recordClick(req.params.token).catch(() => {});
  res.redirect(302, String(req.query.u ?? '/'));
});

// Meta WhatsApp Business webhook verification (challenge handshake).
router.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.CRM_WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge ?? ''));
  }
  res.sendStatus(403);
});
router.post('/webhooks/whatsapp', express.json({ limit: '2mb' }), async (req, res) => {
  const sigHeader = req.headers['x-hub-signature-256'];
  if (process.env.CRM_WHATSAPP_APP_SECRET && typeof sigHeader === 'string') {
    const crypto = await import('crypto');
    const raw = JSON.stringify(req.body);
    const expected = 'sha256=' + crypto
      .createHmac('sha256', process.env.CRM_WHATSAPP_APP_SECRET)
      .update(raw).digest('hex');
    if (expected !== sigHeader) return res.sendStatus(401);
  }
  const orgId = (req.body?.org_id as string | undefined)
    ?? (req.headers['x-org-id'] as string | undefined);
  if (!orgId) {
    return res.status(202).json({ ignored: 'no org context resolvable for stub provider' });
  }
  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        for (const m of value.messages ?? []) {
          await whatsappSvc.recordInbound({
            org_id: orgId,
            from_phone: m.from,
            to_phone: value.metadata?.display_phone_number,
            body_text: m.text?.body,
            media_url: m.image?.id ?? m.document?.id ?? m.video?.id,
            media_type: m.type,
            provider_message_id: m.id,
            in_reply_to: m.context?.id,
          });
        }
        for (const s of value.statuses ?? []) {
          await whatsappSvc.recordStatusUpdate({
            org_id: orgId,
            provider_message_id: s.id,
            status: s.status as 'delivered' | 'read' | 'failed',
            error: s.errors?.[0]?.title,
          });
        }
      }
    }
  } catch {
    // Best-effort; never fail the webhook so Meta doesn't retry.
  }
  res.sendStatus(200);
});

// ----- AUTHENTICATED ROUTES BELOW -----
router.use(requireAuth, requireModule('crm'));

// Wrap every res.json payload in {success, data} so the dashboard's
// Wrapped<T> typings match runtime. Pass-through if the body already has
// a `success` field (error handler emits {success:false,...}).
router.use((_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (body && typeof body === 'object' && 'success' in (body as Record<string, unknown>)) {
      return originalJson(body);
    }
    return originalJson({ success: true, data: body });
  };
  next();
});

// Demo bypass: when org_id=demo-org-999, short-circuit GETs to canned fixtures
// and writes to no-op success. Mounted AFTER the success-envelope wrapper so
// fixture payloads come out the same shape the frontend expects.
router.use(demoCrmMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- helpers --------------------------------------------------
const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

function orgId(req: Request): string {
  const r = req as Request & { user?: { org_id?: string }; auth?: { org_id?: string } };
  const id = r.user?.org_id ?? r.auth?.org_id ?? (req.headers['x-org-id'] as string | undefined);
  if (!id) throw new AppError(400, 'No org context on request', 'NO_ORG');
  return String(id);
}
function userId(req: Request): string | undefined {
  const r = req as Request & { user?: { id?: string; user_id?: string }; auth?: { user_id?: string } };
  return r.user?.id ?? r.user?.user_id ?? r.auth?.user_id;
}
// Multi-tenant: client_id scopes CRM data within an org.
// - Client-level users (JWT has client_id) are pinned to that client; the header is ignored.
// - Org-level admins (no JWT client_id) may pass X-Client-Id (a UUID) so the dashboard's
//   global client picker can scope their CRM view/configuration to a specific client.
// - When no client is in scope, behaviour falls back to org-level (NULL client_id).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function clientId(req: Request): string | null {
  const r = req as Request & { user?: { client_id?: string | null } };
  if (r.user?.client_id) return r.user.client_id;
  const headerVal = (req.headers['x-client-id'] as string | undefined)?.trim();
  if (headerVal && UUID_RE.test(headerVal)) return headerVal;
  return null;
}
function dateRange(req: Request): { from?: string; to?: string } {
  const from = req.query.from ? String(req.query.from) : undefined;
  const to = req.query.to ? String(req.query.to) : undefined;
  return { from, to };
}
function parse<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  try { return schema.parse(payload); }
  catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new AppError(400, `Validation failed: ${issues}`, 'VALIDATION');
    }
    throw e;
  }
}

// ---------- LEADS ----------------------------------------------------
const leads = express.Router();
leads.get('/', wrap(async (req, res) => res.json(await stampOwnerNames(await leadsSvc.listLeads(orgId(req), req.query, clientId(req))))));
leads.post('/', wrap(async (req, res) => {
  const parsed = parse(v.leadCreateSchema, req.body);
  // Stamp client_id from request scope (JWT or X-Client-Id header) unless the body explicitly set it.
  const payload = { ...parsed, client_id: parsed.client_id ?? clientId(req) };
  res.status(201).json(await stampOwnerName(await leadsSvc.createLead({ org_id: orgId(req), user_id: userId(req), payload })));
}));
leads.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await leadsSvc.getLead(orgId(req), req.params.id)))));
leads.patch('/:id', wrap(async (req, res) =>
  res.json(await stampOwnerName(await leadsSvc.updateLead(orgId(req), req.params.id, parse(v.leadUpdateSchema, req.body), userId(req))))));
leads.delete('/:id', wrap(async (req, res) => { await leadsSvc.deleteLead(orgId(req), req.params.id); res.status(204).end(); }));
leads.post('/:id/score', wrap(async (req, res) => res.json(await leadsSvc.rescoreLead(orgId(req), req.params.id))));
leads.post('/:id/convert', wrap(async (req, res) =>
  res.json(await leadsSvc.convertLead(orgId(req), req.params.id, parse(v.leadConvertSchema, req.body), userId(req)))));
leads.get('/:id/score-history', wrap(async (req, res) => res.json(await leadsSvc.listScoreHistory(orgId(req), req.params.id))));
leads.get('/:id/activities', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { lead_id: req.params.id, ...req.query }, { defaultSort: { column: 'completed_at', ascending: false } })
)));
leads.get('/:id/deals', wrap(async (req, res) => res.json(
  await crud.list('crm_deals', orgId(req), { lead_id: req.params.id, ...req.query })
)));
leads.post('/bulk-assign', wrap(async (req, res) => {
  const body = parse(z.object({ lead_ids: z.array(z.string().uuid()), owner_id: z.string().uuid() }), req.body);
  res.json(await leadsSvc.bulkAssign(orgId(req), body.lead_ids, body.owner_id, userId(req)));
}));
router.use('/leads', leads);

// ---------- CONTACTS -------------------------------------------------
const contacts = express.Router();
const contactOpts = { searchColumns: ['first_name','last_name','email','phone'] };
contacts.get('/', wrap(async (req, res) => res.json(
  await stampOwnerNames(await crud.clientScopedList('crm_contacts', orgId(req), clientId(req), req.query, contactOpts))
)));
contacts.post('/', wrap(async (req, res) => {
  const parsed = parse(v.contactSchema, req.body);
  const payload: Record<string, unknown> = { ...parsed, client_id: clientId(req) };
  res.status(201).json(await stampOwnerName(await crud.create('crm_contacts', orgId(req), payload, userId(req))));
}));
contacts.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await crud.get('crm_contacts', orgId(req), req.params.id)))));
contacts.patch('/:id', wrap(async (req, res) =>
  res.json(await stampOwnerName(await crud.update('crm_contacts', orgId(req), req.params.id, parse(v.contactSchema.partial(), req.body), userId(req))))));
contacts.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_contacts', orgId(req), req.params.id); res.status(204).end(); }));
contacts.get('/:id/activities', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { contact_id: req.params.id, ...req.query }, { defaultSort: { column: 'completed_at', ascending: false } })
)));
contacts.get('/:id/deals', wrap(async (req, res) => res.json(
  await crud.list('crm_deals', orgId(req), { primary_contact_id: req.params.id, ...req.query })
)));
contacts.get('/:id/notes', wrap(async (req, res) => res.json(
  await crud.list('crm_notes', orgId(req), { entity_type: 'contact', entity_id: req.params.id, ...req.query }, { softDelete: false })
)));
contacts.get('/:id/emails', wrap(async (req, res) => res.json(await emailsSvc.listLogs(orgId(req), { contact_id: req.params.id }))));
router.use('/contacts', contacts);

// ---------- ACCOUNTS -------------------------------------------------
const accounts = express.Router();
accounts.get('/', wrap(async (req, res) => res.json(
  await stampOwnerNames(await crud.clientScopedList('crm_accounts', orgId(req), clientId(req), req.query, { searchColumns: ['name','domain','industry'] }))
)));
accounts.post('/', wrap(async (req, res) => {
  const parsed = parse(v.accountSchema, req.body);
  const payload: Record<string, unknown> = { ...parsed, client_id: clientId(req) };
  res.status(201).json(await stampOwnerName(await crud.create('crm_accounts', orgId(req), payload, userId(req))));
}));
accounts.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await crud.get('crm_accounts', orgId(req), req.params.id)))));
accounts.patch('/:id', wrap(async (req, res) =>
  res.json(await stampOwnerName(await crud.update('crm_accounts', orgId(req), req.params.id, parse(v.accountSchema.partial(), req.body), userId(req))))));
accounts.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_accounts', orgId(req), req.params.id); res.status(204).end(); }));
accounts.get('/:id/contacts', wrap(async (req, res) => res.json(
  await crud.list('crm_contacts', orgId(req), { account_id: req.params.id, ...req.query })
)));
accounts.get('/:id/deals', wrap(async (req, res) => res.json(
  await crud.list('crm_deals', orgId(req), { account_id: req.params.id, ...req.query })
)));
accounts.get('/:id/activities', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { account_id: req.params.id, ...req.query }, { defaultSort: { column: 'completed_at', ascending: false } })
)));
accounts.get('/:id/notes', wrap(async (req, res) => res.json(
  await crud.list('crm_notes', orgId(req), { entity_type: 'account', entity_id: req.params.id, ...req.query }, { softDelete: false })
)));
accounts.post('/:id/summarize', wrap(async (req, res) =>
  res.json({ text: await summarizeSvc.summarizeAccount(orgId(req), req.params.id) })));
router.use('/accounts', accounts);

// ---------- DEALS ----------------------------------------------------
const deals = express.Router();
deals.get('/', wrap(async (req, res) => res.json(await stampOwnerNames(await dealsSvc.listDeals(orgId(req), req.query, clientId(req))))));
deals.post('/', wrap(async (req, res) => {
  const parsed = parse(v.dealSchema, req.body);
  const payload = { ...parsed, client_id: parsed.client_id ?? clientId(req) };
  res.status(201).json(await stampOwnerName(await dealsSvc.createDeal(orgId(req), payload, userId(req))));
}));
deals.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await dealsSvc.getDeal(orgId(req), req.params.id)))));
deals.patch('/:id', wrap(async (req, res) =>
  res.json(await stampOwnerName(await dealsSvc.updateDeal(orgId(req), req.params.id, parse(v.dealUpdateSchema, req.body), userId(req))))));
deals.delete('/:id', wrap(async (req, res) => { await dealsSvc.deleteDeal(orgId(req), req.params.id); res.status(204).end(); }));
deals.post('/:id/move-stage', wrap(async (req, res) => {
  const { stage_id } = parse(v.moveStageSchema, req.body);
  res.json(await dealsSvc.moveStage(orgId(req), req.params.id, stage_id, userId(req)));
}));
deals.post('/:id/win', wrap(async (req, res) => res.json(await dealsSvc.winDeal(orgId(req), req.params.id, parse(v.winSchema, req.body), userId(req)))));
deals.post('/:id/lose', wrap(async (req, res) => res.json(await dealsSvc.loseDeal(orgId(req), req.params.id, parse(v.loseSchema, req.body), userId(req)))));
deals.post('/:id/win-probability', wrap(async (req, res) => res.json(await winSvc.compute(orgId(req), req.params.id))));
deals.post('/:id/next-action', wrap(async (req, res) => res.json(await nbaSvc.compute(orgId(req), req.params.id, true))));
deals.get('/:id/history', wrap(async (req, res) => res.json(await dealsSvc.dealHistory(orgId(req), req.params.id))));
deals.get('/:id/activities', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { deal_id: req.params.id, ...req.query }, { defaultSort: { column: 'completed_at', ascending: false } })
)));
deals.get('/:id/contacts', wrap(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('crm_deal_contacts')
    .select('contact_id, role, is_primary, contact:crm_contacts(*)')
    .eq('deal_id', req.params.id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json((data ?? []).map((r: { contact_id: string; role: string | null; is_primary: boolean; contact: unknown }) => ({
    contact_id: r.contact_id,
    role: r.role,
    is_primary: r.is_primary,
    contact: r.contact,
  })));
}));
deals.get('/:id/notes', wrap(async (req, res) => res.json(
  await crud.list('crm_notes', orgId(req), { entity_type: 'deal', entity_id: req.params.id, ...req.query }, { softDelete: false })
)));
// Deal line items (nested under the deal).
deals.get('/:id/line-items', wrap(async (req, res) => res.json(await productsSvc.listLineItems(orgId(req), req.params.id))));
deals.post('/:id/line-items', wrap(async (req, res) =>
  res.status(201).json(await productsSvc.addLineItem(orgId(req), req.params.id, parse(v.lineItemSchema, req.body), userId(req)))));
router.use('/deals', deals);

// Top-level line item update/delete (id is unique enough).
const lineItems = express.Router();
lineItems.patch('/:id', wrap(async (req, res) =>
  res.json(await productsSvc.updateLineItem(orgId(req), req.params.id, parse(v.lineItemSchema.partial(), req.body), userId(req)))));
lineItems.delete('/:id', wrap(async (req, res) => {
  await productsSvc.deleteLineItem(orgId(req), req.params.id);
  res.status(204).end();
}));
router.use('/line-items', lineItems);

// ---------- PIPELINES + STAGES --------------------------------------
// Multi-tenant: pipelines are client-scoped. LIST returns org-level (NULL client_id)
// pipelines plus the active client's pipelines. Stages inherit scope via FK.
const pipelines = express.Router();
pipelines.get('/', wrap(async (req, res) => {
  const cid = clientId(req);
  let q = supabaseAdmin
    .from('crm_pipelines')
    .select('*, stages:crm_deal_stages(*)')
    .eq('org_id', orgId(req))
    .is('deleted_at', null);
  // Hard isolation: client picker scopes the list to that client only;
  // org admin (no client picked) sees all pipelines across the org.
  if (cid) q = q.eq('client_id', cid);
  const { data, error } = await q.order('created_at', { ascending: true });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  // Sort stages by position within each pipeline
  const sorted = (data || []).map((p: any) => ({
    ...p,
    stages: Array.isArray(p.stages) ? [...p.stages].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)) : [],
  }));
  res.json(sorted);
}));
pipelines.post('/', wrap(async (req, res) => {
  const parsed = parse(v.pipelineSchema, req.body);
  const payload: Record<string, unknown> = { ...parsed, client_id: clientId(req) };
  res.status(201).json(await crud.create('crm_pipelines', orgId(req), payload, userId(req)));
}));
pipelines.get('/:id', wrap(async (req, res) => {
  const cid = clientId(req);
  let q = supabaseAdmin
    .from('crm_pipelines')
    .select('*, stages:crm_deal_stages(*)')
    .eq('id', req.params.id).eq('org_id', orgId(req))
    .is('deleted_at', null);
  // Hard isolation: client picker scopes to that client only.
  if (cid) q = q.eq('client_id', cid);
  const { data, error } = await q.single();
  if (error || !data) throw new AppError(404, 'Pipeline not found', 'NOT_FOUND');
  const sortedStages = Array.isArray(data.stages) ? [...data.stages].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)) : [];
  res.json({ ...data, stages: sortedStages });
}));
pipelines.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_pipelines', orgId(req), req.params.id, parse(v.pipelineSchema.partial(), req.body), userId(req)))));
pipelines.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_pipelines', orgId(req), req.params.id); res.status(204).end(); }));
pipelines.get('/:id/stages', wrap(async (req, res) => res.json(
  await crud.list('crm_deal_stages', orgId(req), { pipeline_id: req.params.id }, { softDelete: false, defaultSort: { column: 'position', ascending: true } })
)));
router.use('/pipelines', pipelines);

const stagesRouter = express.Router();
stagesRouter.get('/', wrap(async (req, res) => res.json(await crud.list('crm_deal_stages', orgId(req), req.query, { softDelete: false, defaultSort: { column: 'position', ascending: true } }))));
stagesRouter.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_deal_stages', orgId(req), parse(v.stageSchema, req.body)))));
stagesRouter.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_deal_stages', orgId(req), req.params.id, parse(v.stageSchema.partial(), req.body)))));
stagesRouter.delete('/:id', wrap(async (req, res) => { await crud.hardDelete('crm_deal_stages', orgId(req), req.params.id); res.status(204).end(); }));
stagesRouter.post('/reorder', wrap(async (req, res) => {
  const body = parse(v.reorderStagesSchema, req.body);
  await Promise.all(body.stages.map(s => supabaseAdmin.from('crm_deal_stages')
    .update({ position: s.position }).eq('id', s.id).eq('org_id', orgId(req))));
  res.json({ ok: true });
}));
router.use('/stages', stagesRouter);

// ---------- ACTIVITIES + NOTES + TASKS ------------------------------
const activities = express.Router();
activities.get('/calendar', wrap(async (req, res) => {
  const from = String(req.query.from ?? new Date(Date.now() - 7 * 86400000).toISOString());
  const to = String(req.query.to ?? new Date(Date.now() + 30 * 86400000).toISOString());
  const cid = clientId(req);
  let q = supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', orgId(req)).is('deleted_at', null).gte('due_at', from).lte('due_at', to);
  // Hard isolation: client picker scopes to that client only.
  if (cid) q = q.eq('client_id', cid);
  const { data } = await q.order('due_at', { ascending: true });
  res.json(await stampOwnerNames(data ?? []));
}));
activities.get('/', wrap(async (req, res) => res.json(
  await stampOwnerNames(await crud.clientScopedList('crm_activities', orgId(req), clientId(req), req.query, { defaultSort: { column: 'completed_at', ascending: false }, searchColumns: ['subject','body'], dateRangeColumn: 'completed_at' }))
)));
activities.post('/', wrap(async (req, res) => {
  const parsed = parse(v.activitySchema, req.body);
  const payload: Record<string, unknown> = { ...parsed, client_id: clientId(req) };
  res.status(201).json(await stampOwnerName(await crud.create('crm_activities', orgId(req), payload, userId(req))));
}));
activities.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await crud.get('crm_activities', orgId(req), req.params.id)))));
activities.patch('/:id', wrap(async (req, res) =>
  res.json(await stampOwnerName(await crud.update('crm_activities', orgId(req), req.params.id, parse(v.activitySchema.partial(), req.body), userId(req))))));
activities.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_activities', orgId(req), req.params.id); res.status(204).end(); }));
router.use('/activities', activities);

const notes = express.Router();
notes.get('/', wrap(async (req, res) => res.json(
  await crud.clientScopedList('crm_notes', orgId(req), clientId(req), req.query, { softDelete: false })
)));
notes.post('/', wrap(async (req, res) => {
  const parsed = parse(v.noteSchema, req.body);
  const payload: Record<string, unknown> = { ...parsed, client_id: clientId(req) };
  res.status(201).json(await crud.create('crm_notes', orgId(req), payload, userId(req)));
}));
notes.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_notes', orgId(req), req.params.id, parse(v.noteSchema.partial(), req.body), userId(req)))));
notes.delete('/:id', wrap(async (req, res) => { await crud.hardDelete('crm_notes', orgId(req), req.params.id); res.status(204).end(); }));
router.use('/notes', notes);

const tasks = express.Router();
tasks.get('/', wrap(async (req, res) => res.json(
  await stampOwnerNames(await crud.clientScopedList('crm_activities', orgId(req), clientId(req), { type: 'task', ...req.query }, { defaultSort: { column: 'due_at', ascending: true }, dateRangeColumn: 'due_at' }))
)));
tasks.post('/', wrap(async (req, res) => {
  const parsed = parse(v.taskSchema, req.body);
  const payload: Record<string, unknown> = { ...parsed, type: 'task' as const, client_id: clientId(req) };
  res.status(201).json(await stampOwnerName(await crud.create('crm_activities', orgId(req), payload, userId(req))));
}));
tasks.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await crud.get('crm_activities', orgId(req), req.params.id)))));
tasks.patch('/:id', wrap(async (req, res) => {
  const parsed = parse(v.taskSchema.partial(), req.body);
  const payload: Record<string, unknown> = { ...parsed };
  if (parsed.status === 'done' && !parsed.completed_at) {
    payload.completed_at = new Date().toISOString();
  }
  res.json(await stampOwnerName(await crud.update('crm_activities', orgId(req), req.params.id, payload, userId(req))));
}));
tasks.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_activities', orgId(req), req.params.id); res.status(204).end(); }));
router.use('/tasks', tasks);

// ---------- STATES + CITIES (location management) -------------------
const states = express.Router();
states.get('/', wrap(async (req, res) => res.json(
  await crud.list('crm_states', orgId(req), req.query, { softDelete: false, defaultSort: { column: 'name', ascending: true }, searchColumns: ['name','code'] })
)));
states.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_states', orgId(req), parse(v.stateSchema, req.body), userId(req)))));
states.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_states', orgId(req), req.params.id, parse(v.stateSchema.partial(), req.body), userId(req)))));
states.delete('/:id', wrap(async (req, res) => { await crud.hardDelete('crm_states', orgId(req), req.params.id); res.status(204).end(); }));
states.get('/:id/cities', wrap(async (req, res) => res.json(
  await crud.list('crm_cities', orgId(req), { state_id: req.params.id, ...req.query }, { softDelete: false, defaultSort: { column: 'name', ascending: true } })
)));
states.post('/seed-indian', wrap(async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc('crm_seed_indian_locations', { p_org_id: orgId(req) });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json(data ?? { states: 0, cities: 0 });
}));
router.use('/states', states);

const cities = express.Router();
cities.get('/', wrap(async (req, res) => res.json(
  await crud.list('crm_cities', orgId(req), req.query, { softDelete: false, defaultSort: { column: 'name', ascending: true }, searchColumns: ['name'] })
)));
cities.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_cities', orgId(req), parse(v.citySchema, req.body), userId(req)))));
cities.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_cities', orgId(req), req.params.id, parse(v.citySchema.partial(), req.body), userId(req)))));
cities.delete('/:id', wrap(async (req, res) => { await crud.hardDelete('crm_cities', orgId(req), req.params.id); res.status(204).end(); }));
router.use('/cities', cities);

// ---------- SOURCES + RULES + TERRITORIES + AUTOMATIONS + CUSTOM FIELDS + TEMPLATES + PRODUCTS
//
// `clientScoped: true` opts in to multi-tenant per-client behaviour:
//   - LIST returns rows where (client_id IS NULL) OR (client_id = user.client_id)
//     so org-level defaults are visible to client users alongside their own.
//   - CREATE stamps client_id from the JWT (or NULL for org-level admins).
function attach(
  path: string,
  table: string,
  schema: z.ZodObject<z.ZodRawShape>,
  opts: Partial<crud.CrudOpts> & { clientScoped?: boolean } = {},
) {
  const r = express.Router();
  r.get('/', wrap(async (req, res) => {
    if (opts.clientScoped) {
      const cid = clientId(req);
      let q = supabaseAdmin.from(table).select('*').eq('org_id', orgId(req));
      if (opts.softDelete !== false) q = q.is('deleted_at', null);
      // Hard isolation: client picker scopes to that client only.
      if (cid) q = q.eq('client_id', cid);
      const { data, error } = await q.order(opts.defaultSort?.column ?? 'created_at', { ascending: opts.defaultSort?.ascending ?? false });
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
      return res.json(data ?? []);
    }
    res.json(await crud.list(table, orgId(req), req.query, opts));
  }));
  r.post('/', wrap(async (req, res) => {
    const parsed = parse(schema, req.body);
    const payload: Record<string, unknown> = { ...parsed };
    if (opts.clientScoped) payload.client_id = clientId(req);
    res.status(201).json(await crud.create(table, orgId(req), payload, userId(req)));
  }));
  r.get('/:id', wrap(async (req, res) => res.json(await crud.get(table, orgId(req), req.params.id, opts.softDelete !== false))));
  r.patch('/:id', wrap(async (req, res) => res.json(await crud.update(table, orgId(req), req.params.id, parse(schema.partial(), req.body), userId(req)))));
  r.delete('/:id', wrap(async (req, res) => {
    if (opts.softDelete === false) await crud.hardDelete(table, orgId(req), req.params.id);
    else await crud.softDelete(table, orgId(req), req.params.id);
    res.status(204).end();
  }));
  router.use(path, r);
}
// All CRM config tables are now client-scoped: org-level rows (NULL client_id) act as
// defaults visible to every client; client-stamped rows are visible only to that client.
attach('/lead-sources', 'crm_lead_sources', v.leadSourceSchema, { softDelete: false, clientScoped: true });
attach('/assignment-rules', 'crm_lead_assignment_rules', v.assignmentRuleSchema, { softDelete: false, clientScoped: true });
attach('/territories', 'crm_territories', v.territorySchema, { softDelete: false, clientScoped: true });
attach('/automations', 'crm_workflow_automations', v.automationSchema, { softDelete: false, clientScoped: true });
attach('/custom-fields', 'crm_custom_field_defs', v.customFieldSchema, { softDelete: false, clientScoped: true });
attach('/email-templates', 'crm_email_templates', v.emailTemplateSchema, { softDelete: false, clientScoped: true });
// Phase 2
attach('/product-categories', 'crm_product_categories', v.productCategorySchema, { defaultSort: { column: 'sort_order', ascending: true }, clientScoped: true });
attach('/products', 'crm_products', v.productSchema, { searchColumns: ['name','sku','description'], clientScoped: true });
attach('/whatsapp-templates', 'crm_whatsapp_templates', v.whatsappTemplateSchema, { softDelete: false, clientScoped: true });

// ---------- SETTINGS -------------------------------------------------
// Multi-tenant: settings scoped by (org_id, client_id). If user has a client_id
// and no client-level row exists, fall back to org-level (NULL client_id) row
// so org defaults still apply. PATCH writes to the user's scope (their client
// or org-level depending on JWT).
const settings = express.Router();
settings.get('/', wrap(async (req, res) => {
  const cid = clientId(req);
  let data: any = null;
  if (cid) {
    const r = await supabaseAdmin.from('crm_settings').select('*').eq('org_id', orgId(req)).eq('client_id', cid).maybeSingle();
    data = r.data;
  }
  if (!data) {
    const r = await supabaseAdmin.from('crm_settings').select('*').eq('org_id', orgId(req)).is('client_id', null).maybeSingle();
    data = r.data;
  }
  res.json(data ?? { org_id: orgId(req), client_id: cid, config: {}, business_type: 'both' });
}));
settings.patch('/', wrap(async (req, res) => {
  const body = parse(v.settingsUpdateSchema, req.body);
  const cid = clientId(req);
  // Read existing row in scope to merge config (so we don't blow away unrelated keys)
  let existing: any = null;
  if (cid) {
    const r = await supabaseAdmin.from('crm_settings').select('*').eq('org_id', orgId(req)).eq('client_id', cid).maybeSingle();
    existing = r.data;
  } else {
    const r = await supabaseAdmin.from('crm_settings').select('*').eq('org_id', orgId(req)).is('client_id', null).maybeSingle();
    existing = r.data;
  }
  const mergedConfig = body.config !== undefined
    ? { ...(existing?.config || {}), ...body.config }
    : existing?.config ?? {};
  const update: Record<string, unknown> = {
    org_id: orgId(req),
    client_id: cid,
    config: mergedConfig,
  };
  if (body.business_type !== undefined) update.business_type = body.business_type;
  // Update if exists, else insert
  if (existing?.id) {
    const { data } = await supabaseAdmin.from('crm_settings').update(update).eq('id', existing.id).select('*').single();
    res.json(data);
  } else {
    const { data } = await supabaseAdmin.from('crm_settings').insert(update).select('*').single();
    res.json(data);
  }
}));
settings.post('/seed-defaults', wrap(async (req, res) => {
  const { error } = await supabaseAdmin.rpc('crm_seed_defaults', { p_org_id: orgId(req) });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ ok: true });
}));
router.use('/settings', settings);

// ---------- EMAILS ---------------------------------------------------
const emails = express.Router();
emails.post('/send', wrap(async (req, res) => {
  const body = parse(v.sendEmailSchema, req.body);
  res.status(201).json(await emailsSvc.sendEmail({
    ...body,
    to: body.to!,
    subject: body.subject!,
    body_html: body.body_html!,
    org_id: orgId(req),
    user_id: userId(req),
  }));
}));
emails.get('/', wrap(async (req, res) => res.json(await emailsSvc.listLogs(orgId(req), req.query))));
router.use('/emails', emails);

// ---------- WHATSAPP ------------------------------------------------
const whatsapp = express.Router();
whatsapp.post('/send', wrap(async (req, res) => {
  const body = parse(v.sendWhatsappSchema, req.body);
  res.status(201).json(await whatsappSvc.sendWhatsapp({
    ...body,
    to: body.to!,
    org_id: orgId(req),
    user_id: userId(req),
  }));
}));
whatsapp.get('/logs', wrap(async (req, res) => res.json(await whatsappSvc.listLogs(orgId(req), req.query))));
router.use('/whatsapp', whatsapp);

// ---------- IMPORT ---------------------------------------------------
const imp = express.Router();
imp.post('/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded', 'NO_FILE');
  res.status(201).json(await importSvc.uploadFile(orgId(req), userId(req), req.file.originalname, req.file.buffer));
}));
imp.post('/preview', wrap(async (req, res) => {
  const body = parse(v.importPreviewSchema, req.body);
  res.json(await importSvc.previewJob(orgId(req), body.job_id, body.mapping));
}));
imp.post('/commit', wrap(async (req, res) => {
  const body = parse(v.importCommitSchema, req.body);
  res.json(await importSvc.commitJob(orgId(req), body.job_id));
}));
imp.get('/jobs/:id', wrap(async (req, res) => res.json(await importSvc.getJob(orgId(req), req.params.id))));
imp.get('/jobs', wrap(async (req, res) => res.json(await importSvc.listJobs(orgId(req)))));
router.use('/import', imp);

// ---------- ANALYTICS ------------------------------------------------
const analytics = express.Router();
// `unit=weight` swaps every rupee aggregation for kg derived from line items
// × product weight. Anything else (or omitted) returns rupees as before.
const unitFromReq = (req: Request): 'inr' | 'weight' => req.query.unit === 'weight' ? 'weight' : 'inr';
analytics.get('/dashboard-summary', wrap(async (req, res) => res.json(await analyticsSvc.dashboardSummary(orgId(req), dateRange(req), clientId(req), unitFromReq(req)))));
// Single round-trip dashboard payload (summary + funnel + pipelineValue + winRate + forecast + leadScoreDistribution)
analytics.get('/dashboard-complete', wrap(async (req, res) => res.json(await analyticsSvc.dashboardComplete(orgId(req), dateRange(req), clientId(req), unitFromReq(req)))));
analytics.get('/pipeline-value', wrap(async (req, res) => res.json(await analyticsSvc.pipelineValue(orgId(req), req.query.pipeline_id as string | undefined, clientId(req), unitFromReq(req)))));
analytics.get('/funnel', wrap(async (req, res) => res.json(await analyticsSvc.funnel(orgId(req), Number(req.query.days ?? 30), dateRange(req), clientId(req)))));
analytics.get('/win-rate', wrap(async (req, res) => res.json(await analyticsSvc.winRate(orgId(req), (req.query.by as 'rep'|'source'|'stage') ?? 'rep', dateRange(req), clientId(req)))));
analytics.get('/sales-cycle', wrap(async (req, res) => res.json(await analyticsSvc.salesCycle(orgId(req), dateRange(req), clientId(req)))));
analytics.get('/forecast', wrap(async (req, res) => res.json(await analyticsSvc.forecast(orgId(req), (req.query.period as 'month'|'quarter') ?? 'quarter', dateRange(req), clientId(req), unitFromReq(req)))));
analytics.get('/activity-heatmap', wrap(async (req, res) => res.json(await analyticsSvc.activityHeatmap(orgId(req), clientId(req)))));
analytics.get('/lead-source-roi', wrap(async (req, res) => res.json(await analyticsSvc.leadSourceRoi(orgId(req), clientId(req)))));
analytics.get('/lead-score-distribution', wrap(async (req, res) => res.json(await analyticsSvc.leadScoreDistribution(orgId(req), dateRange(req), clientId(req)))));
// Geo breakdown for dashboard filtering
analytics.get('/by-state', wrap(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('crm_contacts')
    .select('state')
    .eq('org_id', orgId(req))
    .is('deleted_at', null)
    .not('state', 'is', null);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const counts: Record<string, number> = {};
  for (const r of data ?? []) {
    const s = (r as { state: string | null }).state;
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  res.json(Object.entries(counts).map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count));
}));
router.use('/analytics', analytics);

// ---------- AI -------------------------------------------------------
const ai = express.Router();
ai.post('/score-lead/:id', wrap(async (req, res) => res.json(await leadsSvc.rescoreLead(orgId(req), req.params.id))));
ai.post('/draft-reply', wrap(async (req, res) => {
  const body = parse(v.draftReplySchema, req.body);
  res.json(await autoRespSvc.draftReply({
    ...body,
    intent: body.intent!,
    tone: body.tone ?? 'friendly',
    org_id: orgId(req),
    user_id: userId(req),
  }));
}));
ai.post('/next-best-action/:dealId', wrap(async (req, res) => res.json(await nbaSvc.compute(orgId(req), req.params.dealId, true))));
ai.post('/win-probability/:dealId', wrap(async (req, res) => res.json(await winSvc.compute(orgId(req), req.params.dealId))));
ai.post('/summarize/account/:id', wrap(async (req, res) => res.json({ text: await summarizeSvc.summarizeAccount(orgId(req), req.params.id) })));
ai.post('/summarize/deal/:id', wrap(async (req, res) => res.json({ text: await summarizeSvc.summarizeDeal(orgId(req), req.params.id) })));
ai.get('/tools', (_req, res) => res.json(kiniTools.toAnthropicTools()));
ai.post('/tools/execute', wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string(), args: z.record(z.unknown()) }), req.body);
  const result = await kiniTools.executeTool(orgId(req), clientId(req), body.name, body.args);
  if (!result) throw new AppError(404, `Tool ${body.name} not registered`, 'UNKNOWN_TOOL');
  res.json(result);
}));
ai.post('/chat', wrap(async (req, res) => {
  // Shape matches the dashboard chatbot (`KinematicAI` in layout.tsx) which
  // sends `{messages, system, context}` and reads `data.text` / `data.cards`
  // from the response. Keep them aligned.
  const body = parse(z.object({
    messages: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string() })).min(1),
    system: z.string().optional(),
    context: z.object({
      module: z.string().optional(),
      route: z.string().optional(),
      entity: z.object({ type: z.string().optional(), id: z.string().optional() }).nullable().optional(),
      org_id: z.string().nullable().optional(),
    }).optional(),
  }), req.body);

  const tools = kiniTools.toAnthropicTools();
  const cid = clientId(req);
  const crmSuffix = `\n\nYou are KINI, the Kinematic CRM AI assistant. You help sales reps close deals.
You have CRM tools available. Use them to fetch real data — never invent leads, deals, or numbers.
When relevant, return cards via tool results so the UI can render them.
Current route: ${body.context?.route ?? 'unknown'}.
Current entity: ${JSON.stringify(body.context?.entity ?? {})}.
Active client scope: ${cid ?? 'none (org-wide view)'}. Every tool call is hard-filtered to this scope by the backend — do not try to bypass it or reference rows from other clients.`;
  const systemPrompt = `${body.system ?? ''}${crmSuffix}`;

  try {
    const out = await chatWithTools({
      org_id: orgId(req),
      system: systemPrompt,
      tools,
      messages: body.messages.map(m => ({ role: m.role, content: m.content as unknown })),
      onToolCall: async (name, args) => kiniTools.executeTool(orgId(req), cid, name, args as Record<string, unknown>),
      max_tokens: 1500,
    });
    res.json({ success: true, data: { text: out.reply, cards: out.cards, tool_calls: out.tool_calls } });
  } catch (e: unknown) {
    // If the env is missing the Anthropic key, surface a useful 200 message
    // instead of a generic 500. The iOS / dashboard chat UIs both expect
    // {success, data:{text, cards}} and will render the explanation inline.
    const code = (e as { code?: string })?.code;
    if (code === 'CONFIG_ERROR') {
      res.json({
        success: true,
        data: {
          text: 'KINI is offline because the backend has no Anthropic API key configured. Ask an admin to set ANTHROPIC_API_KEY on the Kinematic deployment.',
          cards: [],
          tool_calls: [],
        },
      });
      return;
    }
    throw e;
  }
}));
router.use('/ai', ai);

// ---------- ERROR HANDLER (CRM-scoped) -------------------------------
router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code ?? 'ERROR', message: err.message },
    });
  }
  return res.status(500).json({ success: false, error: { code: 'INTERNAL', message: err.message } });
});

export default router;

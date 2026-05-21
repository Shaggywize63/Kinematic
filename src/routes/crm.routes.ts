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
import * as rbac from '../middleware/rbac';
import { AppError } from '../utils';
import { AuthRequest } from '../types';
import { supabaseAdmin } from '../lib/supabase';

import { demoCrmMiddleware } from '../utils/demoCrm';
import * as v from '../validators/crm.validators';
import * as crud from '../services/crm/crud.service';
import * as leadsSvc from '../services/crm/leads.service';
import * as dealsSvc from '../services/crm/deals.service';
import * as importSvc from '../services/crm/import.service';
import * as analyticsSvc from '../services/crm/analytics.service';
import * as analyticsExt from '../services/crm/analytics-extended.service';
import * as dashboardLayoutSvc from '../services/crm/dashboardLayout.service';
import * as leaderboardSvc from '../services/crm/leaderboard.service';
import * as emailsSvc from '../services/crm/emails.service';
import * as whatsappSvc from '../services/crm/whatsapp.service';
import * as productsSvc from '../services/crm/products.service';
import * as nbaSvc from '../services/crm/ai/nextBestAction.service';
import * as winSvc from '../services/crm/ai/winProbability.service';
import * as autoRespSvc from '../services/crm/ai/autoResponse.service';
import * as summarizeSvc from '../services/crm/ai/summarize.service';
import * as kiniTools from '../services/crm/ai/kiniTools.service';
import * as locationsSvc from '../services/crm/locations.service';
import * as whatsappTranslate from '../services/crm/whatsappTranslate.service';
import * as kiniQuota from '../services/crm/ai/kiniQuota.service';
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
    // Constant-time compare — `expected !== sigHeader` leaks the
    // correct signature byte-by-byte via timing. Buffer.from + length
    // guard + timingSafeEqual gives a length-mismatch return without
    // an early short-circuit.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sigHeader, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  }
  // org_id only from the trusted X-Org-Id header — accepting it from
  // request body let an attacker who can forge the HMAC (or fail open
  // when the secret is unset) attribute leads to any tenant. Header is
  // set by the upstream WA-bridge service that owns the integration row.
  const orgId = (req.headers['x-org-id'] as string | undefined);
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
    /* never fail the webhook */
  }
  res.sendStatus(200);
});

router.use(requireAuth, requireModule('crm'));

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

router.use(demoCrmMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientScope(req: Request): { id: string | null; strict: boolean } {
  const r = req as Request & { user?: { client_id?: string | null; role?: string | null } };
  // Client-pinned users (JWT carries client_id) — strict-scoped to their own
  // client. The X-Client-Id header is ignored so they can't escape via it.
  if (r.user?.client_id) return { id: r.user.client_id, strict: true };
  // Org-level admins (incl. super_admin) — honour the explicit X-Client-Id
  // picker with STRICT scoping. When a client is selected, every read/write
  // is hard-filtered to ONLY that client's rows; org-shared rows
  // (client_id=null) are excluded so the picker behaves like real tenant
  // isolation. When the picker is empty, the admin sees the full org.
  // (Older builds were non-strict here, which let null-stamped rows
  // — e.g. legacy leads from before client stamping — leak into every
  // client view.)
  const headerVal = (req.headers['x-client-id'] as string | undefined)?.trim();
  if (headerVal && UUID_RE.test(headerVal)) return { id: headerVal, strict: true };
  return { id: null, strict: false };
}

function clientId(req: Request): string | null { return clientScope(req).id; }
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
leads.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  // City geo-tag enforcement: pass the user's effective city set (role ∩
  // user) so listLeads can restrict by crm_leads.city. null = no scope.
  const effectiveCities = rbac.getEffectiveCityNames((req as AuthRequest).user);
  return res.json(await stampOwnerNames(await leadsSvc.listLeads(orgId(req), req.query, scope.id, { strictClient: scope.strict, effectiveCities })));
}));
leads.post('/', wrap(async (req, res) => {
  const parsed = parse(v.leadCreateSchema, req.body);
  const payload = { ...parsed, client_id: parsed.client_id ?? clientId(req) };
  res.status(201).json(await stampOwnerName(await leadsSvc.createLead({ org_id: orgId(req), user_id: userId(req), payload })));
}));
// CSV export — same filters as the list endpoint (status, owner, source,
// state/city/district/block, score_gte, q, from, to, etc.) but caps at
// 10k rows server-side and streams a real CSV file. Auth + tenant cap +
// city scope all apply via the same listLeads path; bots can't pull more
// than the user themselves can see.
leads.get('/export', wrap(async (req, res) => {
  const scope = clientScope(req);
  const effectiveCities = rbac.getEffectiveCityNames((req as AuthRequest).user);
  // Force a high per-page cap; listLeads internally clamps to 200 so we
  // page through up to 10000 in 200-row chunks. Keeps memory + DB load
  // bounded.
  const PAGE = 200;
  const MAX  = 10000;
  const rows: any[] = [];
  for (let page = 1; rows.length < MAX; page++) {
    const chunk = await leadsSvc.listLeads(
      orgId(req),
      { ...req.query, limit: PAGE, page },
      scope.id,
      { strictClient: scope.strict, effectiveCities },
    );
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  const stamped = await stampOwnerNames(rows.slice(0, MAX));
  // Resolve source UUIDs → names in one round-trip so the CSV reads
  // "Acme Web Form" instead of an opaque a1b2c3d4-… UUID. Mirrors the
  // owner-name decoration in stampOwnerNames.
  const sourceIds = Array.from(new Set(stamped.map((r: any) => r.source_id).filter(Boolean))) as string[];
  const sourceNameById = new Map<string, string>();
  if (sourceIds.length) {
    const { data: srcs } = await supabaseAdmin
      .from('crm_lead_sources')
      .select('id, name')
      .in('id', sourceIds);
    for (const s of srcs ?? []) sourceNameById.set((s as any).id, (s as any).name as string);
  }
  const enriched = stamped.map((r: any) => ({
    ...r,
    source_name: r.source_id ? (sourceNameById.get(r.source_id) ?? '') : '',
  }));

  // CSV columns — names only. UUIDs are an implementation detail and
  // never make it into the exported file.
  const cols: Array<{ key: string; label: string }> = [
    { key: 'first_name',       label: 'First Name' },
    { key: 'last_name',        label: 'Last Name' },
    { key: 'email',            label: 'Email' },
    { key: 'phone',            label: 'Phone' },
    { key: 'company',          label: 'Company' },
    { key: 'title',            label: 'Title' },
    { key: 'industry',         label: 'Industry' },
    { key: 'state',            label: 'State' },
    { key: 'city',             label: 'City' },
    { key: 'district',         label: 'District' },
    { key: 'block',            label: 'Block' },
    { key: 'status',           label: 'Status' },
    { key: 'lifecycle_stage',  label: 'Lifecycle Stage' },
    { key: 'score',            label: 'Score' },
    { key: 'grade',            label: 'Grade' },
    { key: 'source_name',      label: 'Source' },
    { key: 'owner_name',       label: 'Owner' },
    { key: 'utm_source',       label: 'UTM Source' },
    { key: 'utm_campaign',     label: 'UTM Campaign' },
    { key: 'last_activity_at', label: 'Last Activity At' },
    { key: 'stage_changed_at', label: 'Stage Changed At' },
    { key: 'created_at',       label: 'Created At' },
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // RFC 4180 — wrap in quotes if it contains comma, quote, or newline.
    // Double up internal quotes.
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = cols.map((c) => c.label).join(',');
  const body = enriched.map((r: any) =>
    cols.map((c) => escape((r as Record<string, unknown>)[c.key])).join(',')
  ).join('\n');
  const csv = `${header}\n${body}\n`;
  const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));
leads.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await leadsSvc.getLead(orgId(req), req.params.id)))));
leads.patch('/:id', wrap(async (req, res) =>
  res.json(await stampOwnerName(await leadsSvc.updateLead(orgId(req), req.params.id, parse(v.leadUpdateSchema, req.body), userId(req))))));
leads.delete('/:id', wrap(async (req, res) => { await leadsSvc.deleteLead(orgId(req), req.params.id); res.status(204).end(); }));
leads.post('/:id/score', wrap(async (req, res) => res.json(await leadsSvc.rescoreLead(orgId(req), req.params.id))));
leads.post('/:id/convert', wrap(async (req, res) =>
  res.json(await leadsSvc.convertLead(orgId(req), req.params.id, parse(v.leadConvertSchema, req.body), userId(req)))));
// Reopen / unconvert — flips back to 'working' and clears terminal fields.
leads.post('/:id/reopen', wrap(async (req, res) =>
  res.json(await stampOwnerName(await leadsSvc.reopenLead(orgId(req), req.params.id, parse(v.leadReopenSchema, req.body), userId(req))))));
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
// Mark a lead as won (status=converted + lifecycle_stage=customer + won_reason).
// Distinct from /convert which spawns Account+Contact+Deal — this is the
// lightweight "rep flagged the win" path used by mobile + dashboard.
leads.post('/:id/won', wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
  res.json(await stampOwnerName(
    await leadsSvc.markLeadAsWon(orgId(req), req.params.id, body.reason ?? null, userId(req)),
  ));
}));
router.use('/leads', leads);

// ---------- CONTACTS -------------------------------------------------
const contacts = express.Router();
const contactOpts = { searchColumns: ['first_name','last_name','email','phone'] };
contacts.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  return res.json(
    await stampOwnerNames(await crud.clientScopedList('crm_contacts', orgId(req), scope.id, req.query, { ...contactOpts, strictClient: scope.strict }))
  );
}));
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
  await stampOwnerNames(await crud.clientScopedList('crm_accounts', orgId(req), clientScope(req).id, req.query, { searchColumns: ['name','domain','industry'], strictClient: clientScope(req).strict }))
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
deals.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  return res.json(await stampOwnerNames(await dealsSvc.listDeals(orgId(req), req.query, scope.id, { strictClient: scope.strict })));
}));
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
deals.get('/:id/line-items', wrap(async (req, res) => res.json(await productsSvc.listLineItems(orgId(req), req.params.id))));
deals.post('/:id/line-items', wrap(async (req, res) =>
  res.status(201).json(await productsSvc.addLineItem(orgId(req), req.params.id, parse(v.lineItemSchema, req.body), userId(req)))));
router.use('/deals', deals);

const lineItems = express.Router();
lineItems.patch('/:id', wrap(async (req, res) =>
  res.json(await productsSvc.updateLineItem(orgId(req), req.params.id, parse(v.lineItemSchema.partial(), req.body), userId(req)))));
lineItems.delete('/:id', wrap(async (req, res) => {
  await productsSvc.deleteLineItem(orgId(req), req.params.id);
  res.status(204).end();
}));
router.use('/line-items', lineItems);

// ---------- PIPELINES + STAGES --------------------------------------
const pipelines = express.Router();
pipelines.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  let q = supabaseAdmin
    .from('crm_pipelines')
    .select('*, stages:crm_deal_stages(*)')
    .eq('org_id', orgId(req))
    .is('deleted_at', null);
  if (scope.id) {
    q = scope.strict
      ? q.eq('client_id', scope.id)
      : q.or(`client_id.is.null,client_id.eq.${scope.id}`);
  }
  const { data, error } = await q.order('created_at', { ascending: true });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
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
  const scope = clientScope(req);
  let q = supabaseAdmin
    .from('crm_pipelines')
    .select('*, stages:crm_deal_stages(*)')
    .eq('id', req.params.id).eq('org_id', orgId(req))
    .is('deleted_at', null);
  if (scope.id) {
    q = scope.strict
      ? q.eq('client_id', scope.id)
      : q.or(`client_id.is.null,client_id.eq.${scope.id}`);
  }
  const { data, error } = await q.single();
  if (error || !data) throw new AppError(404, 'Pipeline not found', 'NOT_FOUND');
  const sortedStages = Array.isArray(data.stages) ? [...data.stages].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)) : [];
  res.json({ ...data, stages: sortedStages });
}));
pipelines.patch('/:id', wrap(async (req, res) => {
  const body = parse(v.pipelineSchema.partial(), req.body);
  // Promoting a pipeline to default: atomically demote every other
  // pipeline this tenant owns so the response never shows two flagged
  // defaults at once. We do NOT touch shared (client_id IS NULL)
  // pipelines — those belong to the platform; the per-tenant choice
  // wins over the shared one in the effective-default lookup.
  if (body.is_default === true) {
    const cid = clientId(req as any);
    if (cid) {
      // Tenant user — demote their own other pipelines only.
      await supabaseAdmin.from('crm_pipelines')
        .update({ is_default: false })
        .eq('org_id', orgId(req))
        .eq('client_id', cid)
        .neq('id', req.params.id);
    } else {
      // Platform admin — demote the other shared pipelines.
      await supabaseAdmin.from('crm_pipelines')
        .update({ is_default: false })
        .eq('org_id', orgId(req))
        .is('client_id', null)
        .neq('id', req.params.id);
    }
  }
  res.json(await crud.update('crm_pipelines', orgId(req), req.params.id, body, userId(req)));
}));
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
  const scope = clientScope(req);
  let q = supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', orgId(req)).is('deleted_at', null).gte('due_at', from).lte('due_at', to);
  if (scope.id) {
    q = scope.strict
      ? q.eq('client_id', scope.id)
      : q.or(`client_id.is.null,client_id.eq.${scope.id}`);
  }
  const { data } = await q.order('due_at', { ascending: true });
  res.json(await stampOwnerNames(data ?? []));
}));
activities.get('/', wrap(async (req, res) => res.json(
  await stampOwnerNames(await crud.clientScopedList('crm_activities', orgId(req), clientScope(req).id, req.query, { defaultSort: { column: 'completed_at', ascending: false }, searchColumns: ['subject','body'], dateRangeColumn: 'completed_at', strictClient: clientScope(req).strict }))
)));
// CSV export — same filters as the list endpoint. Pages through all
// matching rows up to a 10k cap with the same tenant + client scope
// the list path uses. Stamps owner names + resolves the parent record
// (lead / contact / account / deal) name so the CSV reads in plain
// English instead of dangling UUIDs.
activities.get('/export', wrap(async (req, res) => {
  const scope = clientScope(req);
  const PAGE = 200;
  const MAX  = 10000;
  const rows: any[] = [];
  for (let page = 1; rows.length < MAX; page++) {
    const chunk = await crud.clientScopedList(
      'crm_activities',
      orgId(req),
      scope.id,
      { ...req.query, limit: PAGE, page },
      { defaultSort: { column: 'completed_at', ascending: false }, searchColumns: ['subject','body'], dateRangeColumn: 'completed_at', strictClient: scope.strict },
    );
    rows.push(...(chunk as any[]));
    if ((chunk as any[]).length < PAGE) break;
  }
  const stamped = await stampOwnerNames(rows.slice(0, MAX));

  // Resolve linked-entity names in a few parallel batched queries so the
  // CSV reads "Lead: Rakesh Sharma" instead of a UUID.
  const leadIds    = Array.from(new Set(stamped.map((r: any) => r.lead_id).filter(Boolean)));
  const contactIds = Array.from(new Set(stamped.map((r: any) => r.contact_id).filter(Boolean)));
  const accountIds = Array.from(new Set(stamped.map((r: any) => r.account_id).filter(Boolean)));
  const dealIds    = Array.from(new Set(stamped.map((r: any) => r.deal_id).filter(Boolean)));

  const [leadsRes, contactsRes, accountsRes, dealsRes] = await Promise.all([
    leadIds.length    ? supabaseAdmin.from('crm_leads').select('id, first_name, last_name, company').in('id', leadIds) : Promise.resolve({ data: [] as any[] }),
    contactIds.length ? supabaseAdmin.from('crm_contacts').select('id, first_name, last_name').in('id', contactIds)    : Promise.resolve({ data: [] as any[] }),
    accountIds.length ? supabaseAdmin.from('crm_accounts').select('id, name').in('id', accountIds)                     : Promise.resolve({ data: [] as any[] }),
    dealIds.length    ? supabaseAdmin.from('crm_deals').select('id, name').in('id', dealIds)                            : Promise.resolve({ data: [] as any[] }),
  ]);
  const leadName    = new Map<string, string>((leadsRes.data    ?? []).map((l: any) => [l.id, [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || l.company || '']));
  const contactName = new Map<string, string>((contactsRes.data ?? []).map((c: any) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ').trim()]));
  const accountName = new Map<string, string>((accountsRes.data ?? []).map((a: any) => [a.id, a.name as string]));
  const dealName    = new Map<string, string>((dealsRes.data    ?? []).map((d: any) => [d.id, d.name as string]));

  const enriched = stamped.map((r: any) => ({
    ...r,
    lead_name:    r.lead_id    ? (leadName.get(r.lead_id)    ?? '') : '',
    contact_name: r.contact_id ? (contactName.get(r.contact_id) ?? '') : '',
    account_name: r.account_id ? (accountName.get(r.account_id) ?? '') : '',
    deal_name:    r.deal_id    ? (dealName.get(r.deal_id)    ?? '') : '',
  }));

  const cols: Array<{ key: string; label: string }> = [
    { key: 'type',             label: 'Type' },
    { key: 'subject',          label: 'Subject' },
    { key: 'body',             label: 'Body' },
    { key: 'status',           label: 'Status' },
    { key: 'priority',         label: 'Priority' },
    { key: 'direction',        label: 'Direction' },
    { key: 'duration_seconds', label: 'Duration (s)' },
    { key: 'due_at',           label: 'Due At' },
    { key: 'completed_at',     label: 'Completed At' },
    { key: 'lead_name',        label: 'Lead' },
    { key: 'contact_name',     label: 'Contact' },
    { key: 'account_name',     label: 'Account' },
    { key: 'deal_name',        label: 'Deal' },
    { key: 'owner_name',       label: 'Owner' },
    { key: 'assigned_to_name', label: 'Assigned To' },
    { key: 'image_url',        label: 'Image URL' },
    { key: 'created_at',       label: 'Created At' },
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = cols.map((c) => c.label).join(',');
  const body = enriched.map((r: any) =>
    cols.map((c) => escape((r as Record<string, unknown>)[c.key])).join(',')
  ).join('\n');
  const csv = `${header}\n${body}\n`;
  const filename = `activities-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));
activities.post('/', wrap(async (req, res) => {
  const parsed = parse(v.activitySchema, req.body);
  const payload: Record<string, unknown> = { ...parsed, client_id: clientId(req) };
  res.status(201).json(await stampOwnerName(await crud.create('crm_activities', orgId(req), payload, userId(req))));
}));
activities.get('/:id', wrap(async (req, res) => res.json(await stampOwnerName(await crud.get('crm_activities', orgId(req), req.params.id)))));
activities.patch('/:id', wrap(async (req, res) =>
  res.json(await stampOwnerName(await crud.update('crm_activities', orgId(req), req.params.id, parse(v.activitySchemaBase.partial(), req.body), userId(req))))));
activities.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_activities', orgId(req), req.params.id); res.status(204).end(); }));
router.use('/activities', activities);

const notes = express.Router();
notes.get('/', wrap(async (req, res) => res.json(
  await crud.clientScopedList('crm_notes', orgId(req), clientScope(req).id, req.query, { softDelete: false, strictClient: clientScope(req).strict })
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
  await stampOwnerNames(await crud.clientScopedList('crm_activities', orgId(req), clientScope(req).id, { type: 'task', ...req.query }, { defaultSort: { column: 'due_at', ascending: true }, dateRangeColumn: 'due_at', strictClient: clientScope(req).strict }))
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

function attach(
  path: string,
  table: string,
  schema: z.ZodObject<z.ZodRawShape>,
  opts: Partial<crud.CrudOpts> & { clientScoped?: boolean } = {},
) {
  const r = express.Router();
  r.get('/', wrap(async (req, res) => {
    if (opts.clientScoped) {
      const scope = clientScope(req);
      let q = supabaseAdmin.from(table).select('*').eq('org_id', orgId(req));
      if (opts.softDelete !== false) q = q.is('deleted_at', null);
      if (scope.id) {
        q = scope.strict
          ? q.eq('client_id', scope.id)
          : q.or(`client_id.is.null,client_id.eq.${scope.id}`);
      }
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
attach('/lead-sources', 'crm_lead_sources', v.leadSourceSchema, { softDelete: false, clientScoped: true });
attach('/assignment-rules', 'crm_lead_assignment_rules', v.assignmentRuleSchema, { softDelete: false, clientScoped: true });
attach('/territories', 'crm_territories', v.territorySchema, { softDelete: false, clientScoped: true });
attach('/automations', 'crm_workflow_automations', v.automationSchema, { softDelete: false, clientScoped: true });
attach('/custom-fields', 'crm_custom_field_defs', v.customFieldSchema, { softDelete: false, clientScoped: true });
// Drag-and-drop reordering. Frontend sends the new (id, position)
// tuples after a drop; we apply them in a single batch within the
// tenant's scope. No-op if any row doesn't belong to the caller's
// org/client — they just stay where they are. Position is just an
// integer; gaps are fine since the renderer sorts by it.
router.post('/custom-fields/reorder', wrap(async (req, res) => {
  const body = parse(v.customFieldReorderSchema, req.body);
  const scope = clientScope(req);
  for (const item of body.items) {
    let q = supabaseAdmin.from('crm_custom_field_defs')
      .update({ position: item.position, updated_at: new Date().toISOString() })
      .eq('org_id', orgId(req))
      .eq('id', item.id);
    if (scope.id) {
      q = scope.strict ? q.eq('client_id', scope.id) : q.or(`client_id.is.null,client_id.eq.${scope.id}`);
    }
    await q;
  }
  res.json({ ok: true, count: body.items.length });
}));
attach('/email-templates', 'crm_email_templates', v.emailTemplateSchema, { softDelete: false, clientScoped: true });
attach('/product-categories', 'crm_product_categories', v.productCategorySchema, { defaultSort: { column: 'sort_order', ascending: true }, clientScoped: true });
attach('/products', 'crm_products', v.productSchema, { searchColumns: ['name','sku','description'], clientScoped: true });
attach('/whatsapp-templates', 'crm_whatsapp_templates', v.whatsappTemplateSchema, { softDelete: false, clientScoped: true });
router.post('/whatsapp-templates/:id/translate', wrap(async (req, res) => {
  const langs = Array.isArray(req.body?.languages) ? req.body.languages.filter((l: unknown) => typeof l === 'string') : [];
  if (!langs.length) return res.status(400).json({ success: false, error: 'languages array required' });
  const supported = new Set(whatsappTranslate.SUPPORTED_LANGUAGES);
  const invalid = langs.filter((l: string) => !supported.has(l));
  if (invalid.length) return res.status(400).json({ success: false, error: `Unsupported languages: ${invalid.join(', ')}` });
  const translations = await whatsappTranslate.translateTemplate(orgId(req), req.params.id, langs);
  res.json({ translations });
}));
router.get('/whatsapp-templates-supported-languages', wrap(async (_req, res) => {
  res.json({ languages: whatsappTranslate.SUPPORTED_LANGUAGES });
}));

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
  if (existing?.id) {
    const { data } = await supabaseAdmin.from('crm_settings').update(update).eq('id', existing.id).select('*').single();
    const { invalidateIcpCache } = await import('../services/crm/ai/leadScoring.service');
    invalidateIcpCache(orgId(req), cid);
    res.json(data);
  } else {
    const { data } = await supabaseAdmin.from('crm_settings').insert(update).select('*').single();
    const { invalidateIcpCache } = await import('../services/crm/ai/leadScoring.service');
    invalidateIcpCache(orgId(req), cid);
    res.json(data);
  }
}));
settings.post('/seed-defaults', wrap(async (req, res) => {
  const { error } = await supabaseAdmin.rpc('crm_seed_defaults', { p_org_id: orgId(req) });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ ok: true });
}));
router.use('/settings', settings);

const locations = express.Router();
locations.get('/', wrap(async (req, res) => {
  const { state, city, district } = req.query as Record<string, string | undefined>;
  res.json(await locationsSvc.listLocations(orgId(req), clientId(req), { state, city, district }));
}));
locations.get('/options', wrap(async (req, res) => {
  res.json(await locationsSvc.locationOptions(orgId(req), clientId(req)));
}));
locations.post('/', wrap(async (req, res) => {
  const body = req.body as { state?: string; city?: string; district?: string; block?: string };
  if (!body.state || !body.city) return res.status(400).json({ success: false, error: 'state and city are required' });
  const row = await locationsSvc.createLocation(orgId(req), clientId(req), userId(req), {
    state: body.state, city: body.city, district: body.district, block: body.block,
  });
  res.status(201).json(row);
}));
locations.post('/bulk-import', wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  res.json(await locationsSvc.bulkImport(orgId(req), clientId(req), userId(req), rows));
}));
locations.delete('/:id', wrap(async (req, res) => {
  await locationsSvc.deleteLocation(orgId(req), req.params.id);
  res.status(204).end();
}));
router.use('/locations', locations);

const activityTypes = express.Router();
const BUILTIN_TYPES = [
  { slug: 'call',     name: 'Call',     icon: '📞' },
  { slug: 'meeting',  name: 'Meeting',  icon: '📅' },
  { slug: 'task',     name: 'Task',     icon: '✅' },
  { slug: 'note',     name: 'Note',     icon: '📝' },
  { slug: 'email',    name: 'Email',    icon: '✉️' },
  { slug: 'sms',      name: 'SMS',      icon: '💬' },
  { slug: 'whatsapp', name: 'WhatsApp', icon: '💚' },
];
activityTypes.get('/', wrap(async (req, res) => {
  const cid = clientId(req);
  let q = supabaseAdmin.from('crm_activity_types').select('*').eq('org_id', orgId(req)).eq('is_active', true);
  if (cid) q = q.or(`client_id.is.null,client_id.eq.${cid}`);
  const { data, error } = await q.order('position').order('name');
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const customSlugs = new Set((data ?? []).map(r => r.slug));
  const builtins = BUILTIN_TYPES.filter(b => !customSlugs.has(b.slug)).map(b => ({
    id: `builtin:${b.slug}`, org_id: orgId(req), client_id: null,
    slug: b.slug, name: b.name, icon: b.icon, color: null, position: -1,
    is_active: true, is_system: true,
  }));
  res.json([...builtins, ...(data ?? [])]);
}));
activityTypes.post('/', wrap(async (req, res) => {
  const body = req.body as { slug?: string; name?: string; icon?: string; color?: string; position?: number };
  const slug = (body.slug || '').trim().toLowerCase();
  const name = (body.name || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(slug)) {
    return res.status(400).json({ success: false, error: 'slug: lowercase letters, digits, _, - only' });
  }
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });
  const { data, error } = await supabaseAdmin.from('crm_activity_types').insert({
    org_id: orgId(req), client_id: clientId(req), slug, name,
    icon: body.icon || null, color: body.color || null,
    position: body.position ?? 0, created_by: userId(req),
  }).select('*').single();
  if (error) throw new AppError(error.code === '23505' ? 409 : 500, error.message, 'DB_ERROR');
  res.status(201).json(data);
}));
activityTypes.patch('/:id', wrap(async (req, res) => {
  const body = req.body as { name?: string; icon?: string; color?: string; position?: number; is_active?: boolean };
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name      !== undefined) update.name      = body.name.trim();
  if (body.icon      !== undefined) update.icon      = body.icon;
  if (body.color     !== undefined) update.color     = body.color;
  if (body.position  !== undefined) update.position  = body.position;
  if (body.is_active !== undefined) update.is_active = body.is_active;
  const { data, error } = await supabaseAdmin.from('crm_activity_types')
    .update(update).eq('org_id', orgId(req)).eq('id', req.params.id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json(data);
}));
activityTypes.delete('/:id', wrap(async (req, res) => {
  const { error } = await supabaseAdmin.from('crm_activity_types')
    .delete().eq('org_id', orgId(req)).eq('id', req.params.id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.status(204).end();
}));
router.use('/activity-types', activityTypes);

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
const unitFromReq = (req: Request): 'inr' | 'weight' => req.query.unit === 'weight' ? 'weight' : 'inr';
const ANALYTICS_TTL = 60;
const cacheKey = (req: Request, name: string) => {
  const r = dateRange(req);
  return `crm:an:${name}:${orgId(req)}:${clientId(req) ?? 'org'}:${unitFromReq(req)}:${r.from ?? ''}:${r.to ?? ''}:${req.query.pipeline_id ?? ''}:${req.query.by ?? ''}:${req.query.period ?? ''}:${req.query.days ?? ''}`;
};
const { cached: cachedAnalytics } = require('../utils/analyticsCache') as typeof import('../utils/analyticsCache');

analytics.get('/dashboard-summary', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'dashboard-summary'), ANALYTICS_TTL,
    () => analyticsSvc.dashboardSummary(orgId(req), dateRange(req), clientId(req), unitFromReq(req))))));
analytics.get('/dashboard-complete', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'dashboard-complete'), ANALYTICS_TTL,
    () => analyticsSvc.dashboardComplete(orgId(req), dateRange(req), clientId(req), unitFromReq(req))))));
analytics.get('/pipeline-value', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'pipeline-value'), ANALYTICS_TTL,
    () => analyticsSvc.pipelineValue(orgId(req), req.query.pipeline_id as string | undefined, clientId(req), unitFromReq(req))))));
analytics.get('/funnel', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'funnel'), ANALYTICS_TTL,
    () => analyticsSvc.funnel(orgId(req), Number(req.query.days ?? 30), dateRange(req), clientId(req))))));
analytics.get('/win-rate', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'win-rate'), ANALYTICS_TTL,
    () => analyticsSvc.winRate(orgId(req), (req.query.by as 'rep'|'source'|'stage') ?? 'rep', dateRange(req), clientId(req))))));
analytics.get('/sales-cycle', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'sales-cycle'), ANALYTICS_TTL,
    () => analyticsSvc.salesCycle(orgId(req), dateRange(req), clientId(req))))));
analytics.get('/forecast', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'forecast'), ANALYTICS_TTL,
    () => analyticsSvc.forecast(orgId(req), (req.query.period as 'month'|'quarter') ?? 'quarter', dateRange(req), clientId(req), unitFromReq(req))))));
analytics.get('/activity-heatmap', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'activity-heatmap'), ANALYTICS_TTL,
    () => analyticsSvc.activityHeatmap(orgId(req), clientId(req))))));
analytics.get('/lead-source-roi', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-source-roi'), ANALYTICS_TTL,
    () => analyticsSvc.leadSourceRoi(orgId(req), clientId(req))))));
analytics.get('/lead-score-distribution', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-score-distribution'), ANALYTICS_TTL,
    () => analyticsSvc.leadScoreDistribution(orgId(req), dateRange(req), clientId(req))))));
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

// ── Extended analytics (15 widgets for the customisable Lead Analytics page) ──
analytics.get('/lead-velocity', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-velocity'), ANALYTICS_TTL,
    () => analyticsExt.leadVelocity(orgId(req), clientId(req), Number(req.query.months ?? 6))))));
analytics.get('/time-to-first-touch', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'time-to-first-touch'), ANALYTICS_TTL,
    () => analyticsExt.timeToFirstTouch(orgId(req), clientId(req), dateRange(req), Number(req.query.sla_minutes ?? 60))))));
analytics.get('/stuck-leads', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'stuck-leads'), ANALYTICS_TTL,
    () => analyticsExt.stuckLeads(orgId(req), clientId(req))))));
analytics.get('/lost-reasons', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lost-reasons'), ANALYTICS_TTL,
    () => analyticsExt.lostReasons(orgId(req), clientId(req), dateRange(req))))));
analytics.get('/won-reasons', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'won-reasons'), ANALYTICS_TTL,
    () => analyticsExt.wonReasons(orgId(req), clientId(req), dateRange(req))))));
analytics.get('/disqualification-reasons', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'disqualification-reasons'), ANALYTICS_TTL,
    () => analyticsExt.disqualificationReasons(orgId(req), clientId(req), dateRange(req))))));
analytics.get('/stage-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'stage-conversion'), ANALYTICS_TTL,
    () => analyticsExt.stageConversion(orgId(req), req.query.pipeline_id as string | undefined, clientId(req))))));
analytics.get('/lead-aging', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-aging'), ANALYTICS_TTL,
    () => analyticsExt.leadAging(orgId(req), clientId(req))))));
analytics.get('/cohort-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'cohort-conversion'), ANALYTICS_TTL,
    () => analyticsExt.cohortConversion(orgId(req), clientId(req), Number(req.query.months ?? 6))))));
analytics.get('/engagement-comparison', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'engagement-comparison'), ANALYTICS_TTL,
    () => analyticsExt.engagementComparison(orgId(req), clientId(req), dateRange(req))))));
analytics.get('/days-since-touch', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'days-since-touch'), ANALYTICS_TTL,
    () => analyticsExt.daysSinceTouch(orgId(req), clientId(req))))));
analytics.get('/score-band-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'score-band-conversion'), ANALYTICS_TTL,
    () => analyticsExt.scoreBandConversion(orgId(req), clientId(req), dateRange(req))))));
analytics.get('/territory-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'territory-conversion'), ANALYTICS_TTL,
    () => analyticsExt.territoryConversion(orgId(req), clientId(req), dateRange(req))))));
analytics.get('/touchpoints-to-response', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'touchpoints-to-response'), ANALYTICS_TTL,
    () => analyticsExt.touchpointsToResponse(orgId(req), clientId(req), dateRange(req))))));
analytics.get('/leads-at-risk', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'leads-at-risk'), ANALYTICS_TTL,
    () => analyticsExt.leadsAtRisk(orgId(req), clientId(req), Number(req.query.score ?? 60), Number(req.query.idle_days ?? 14))))));
router.use('/analytics', analytics);

// ── DASHBOARD LAYOUTS (per-user widget grid for /crm/analytics + overview) ──
const layouts = express.Router();
layouts.get('/:page', wrap(async (req, res) => {
  const page = req.params.page as 'analytics' | 'overview';
  if (!['analytics', 'overview'].includes(page)) {
    throw new AppError(400, "page must be 'analytics' or 'overview'", 'VALIDATION');
  }
  const uid = userId(req);
  if (!uid) throw new AppError(400, 'No user context on request', 'NO_USER');
  res.json(await dashboardLayoutSvc.getLayout(uid, orgId(req), page));
}));
layouts.put('/:page', wrap(async (req, res) => {
  const page = req.params.page as 'analytics' | 'overview';
  if (!['analytics', 'overview'].includes(page)) {
    throw new AppError(400, "page must be 'analytics' or 'overview'", 'VALIDATION');
  }
  const uid = userId(req);
  if (!uid) throw new AppError(400, 'No user context on request', 'NO_USER');
  const config = req.body as dashboardLayoutSvc.DashboardConfig;
  res.json(await dashboardLayoutSvc.saveLayout(uid, orgId(req), clientId(req), page, config));
}));
layouts.post('/overview/pin', wrap(async (req, res) => {
  const uid = userId(req);
  if (!uid) throw new AppError(400, 'No user context on request', 'NO_USER');
  const widget = req.body as dashboardLayoutSvc.WidgetInstance;
  if (!widget?.id || !widget?.widget_type) {
    throw new AppError(400, 'widget.id and widget.widget_type are required', 'VALIDATION');
  }
  res.json(await dashboardLayoutSvc.pinWidgetToOverview(uid, orgId(req), clientId(req), widget));
}));
layouts.delete('/:page/widgets/:widget_id', wrap(async (req, res) => {
  const page = req.params.page as 'analytics' | 'overview';
  if (!['analytics', 'overview'].includes(page)) {
    throw new AppError(400, "page must be 'analytics' or 'overview'", 'VALIDATION');
  }
  const uid = userId(req);
  if (!uid) throw new AppError(400, 'No user context on request', 'NO_USER');
  res.json(await dashboardLayoutSvc.removeWidget(uid, orgId(req), clientId(req), page, req.params.widget_id));
}));
router.use('/dashboard-layouts', layouts);

router.get('/leaderboard', wrap(async (req, res) => {
  const metric = (req.query.metric === 'revenue' ? 'revenue' : 'count') as leaderboardSvc.LeaderboardMetric;
  const period = ((['mtd', 'qtd', 'ytd', 'custom'] as const).find(p => p === req.query.period) ?? 'mtd') as leaderboardSvc.LeaderboardPeriod;
  const from = req.query.from ? String(req.query.from) : undefined;
  const to = req.query.to ? String(req.query.to) : undefined;
  if (period === 'custom' && (!from || !to)) {
    throw new AppError(400, "period='custom' requires both from and to (YYYY-MM-DD)", 'VALIDATION');
  }
  const scope = clientScope(req);
  const result = await leaderboardSvc.leaderboard(
    orgId(req),
    { metric, period, from, to },
    { client_id: scope.id, strict: scope.strict },
  );
  res.json(result);
}));

const ai = express.Router();

async function gateAi(req: Request, res: Response): Promise<{ proceed: true; actor: { id?: string; org_id?: string; role?: string; client_id?: string | null } } | { proceed: false }> {
  const u = (req as Request & { user?: { id?: string; org_id?: string; role?: string; client_id?: string | null } }).user;
  const scope = clientScope(req);
  const actor = { id: u?.id, org_id: u?.org_id, role: u?.role, client_id: u?.client_id ?? scope.id ?? null };
  const gate = await kiniQuota.checkQuota(actor);
  if (!gate.allowed) {
    const code = gate.reason ?? 'USER_KINI_LIMIT_REACHED';
    const msg = code === 'ORG_KINI_LIMIT_REACHED'
      ? `Your organization has reached its monthly AI limit (${gate.org_cap ?? gate.cap} queries). Resets on the 1st.`
      : `Monthly AI limit reached (${gate.cap} queries). Resets on the 1st.`;
    res.status(429).json({
      success: false,
      error: { code, message: msg },
      data: {
        usage: {
          used: gate.used, cap: gate.cap, remaining: 0,
          month: gate.month, exempt: gate.exempt, limit_reached: true,
          reason: code,
          org_used: gate.org_used, org_cap: gate.org_cap,
        },
      },
    });
    return { proceed: false };
  }
  return { proceed: true, actor };
}

function platformOf(req: Request): 'web' | 'ios' | 'android' {
  const raw = (req.headers['x-kinematic-platform'] as string | undefined ?? '').toLowerCase().trim();
  return (raw === 'ios' || raw === 'android') ? raw : 'web';
}

ai.post('/score-lead/:id', wrap(async (req, res) => {
  const g = await gateAi(req, res); if (!g.proceed) return;
  const out = await leadsSvc.rescoreLead(orgId(req), req.params.id);
  void kiniQuota.recordQuery(g.actor, undefined, platformOf(req));
  res.json(out);
}));
ai.post('/draft-reply', wrap(async (req, res) => {
  const g = await gateAi(req, res); if (!g.proceed) return;
  const body = parse(v.draftReplySchema, req.body);
  const out = await autoRespSvc.draftReply({
    ...body,
    intent: body.intent!,
    tone: body.tone ?? 'friendly',
    org_id: orgId(req),
    user_id: userId(req),
  });
  void kiniQuota.recordQuery(g.actor, undefined, platformOf(req));
  res.json(out);
}));
ai.post('/next-best-action/:dealId', wrap(async (req, res) => {
  const g = await gateAi(req, res); if (!g.proceed) return;
  const out = await nbaSvc.compute(orgId(req), req.params.dealId, true);
  void kiniQuota.recordQuery(g.actor, undefined, platformOf(req));
  res.json(out);
}));
ai.post('/win-probability/:dealId', wrap(async (req, res) => {
  const g = await gateAi(req, res); if (!g.proceed) return;
  const out = await winSvc.compute(orgId(req), req.params.dealId);
  void kiniQuota.recordQuery(g.actor, undefined, platformOf(req));
  res.json(out);
}));
ai.post('/summarize/account/:id', wrap(async (req, res) => {
  const g = await gateAi(req, res); if (!g.proceed) return;
  const text = await summarizeSvc.summarizeAccount(orgId(req), req.params.id);
  void kiniQuota.recordQuery(g.actor, undefined, platformOf(req));
  res.json({ text });
}));
ai.post('/summarize/deal/:id', wrap(async (req, res) => {
  const g = await gateAi(req, res); if (!g.proceed) return;
  const text = await summarizeSvc.summarizeDeal(orgId(req), req.params.id);
  void kiniQuota.recordQuery(g.actor, undefined, platformOf(req));
  res.json({ text });
}));
ai.get('/tools', (_req, res) => res.json(kiniTools.toAnthropicTools()));
ai.post('/tools/execute', wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string(), args: z.record(z.unknown()) }), req.body);
  const result = await kiniTools.executeTool(orgId(req), clientId(req), body.name, body.args);
  if (!result) throw new AppError(404, `Tool ${body.name} not registered`, 'UNKNOWN_TOOL');
  res.json(result);
}));
ai.get('/usage', wrap(async (req, res) => {
  const u = (req as Request & { user?: { id?: string; org_id?: string; role?: string; client_id?: string | null } }).user;
  const scope = clientScope(req);
  res.json(await kiniQuota.getUsage({ id: u?.id, org_id: u?.org_id, role: u?.role, client_id: u?.client_id ?? scope.id ?? null }));
}));

ai.get('/credits', wrap(async (req, res) => {
  res.json(await kiniQuota.getCredits(orgId(req), kiniQuota.currentMonth()));
}));

ai.post('/chat', wrap(async (req, res) => {
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

  const reqUser = (req as Request & { user?: { id?: string; org_id?: string; role?: string; client_id?: string | null } }).user;
  const scope = clientScope(req);
  const actor = { id: reqUser?.id, org_id: reqUser?.org_id, role: reqUser?.role, client_id: reqUser?.client_id ?? scope.id ?? null };
  const platform = platformOf(req);
  const gate = await kiniQuota.checkQuota(actor);
  if (!gate.allowed) {
    const code = gate.reason ?? 'USER_KINI_LIMIT_REACHED';
    const msg = code === 'ORG_KINI_LIMIT_REACHED'
      ? `Your organization has reached its monthly AI limit (${gate.org_cap ?? gate.cap} queries). Resets on the 1st.`
      : `Monthly AI limit reached (${gate.cap} queries). Resets on the 1st.`;
    return res.status(429).json({
      success: false,
      error: { code, message: msg },
      data: {
        usage: {
          used: gate.used, cap: gate.cap, remaining: 0,
          month: gate.month, exempt: gate.exempt, limit_reached: true,
          reason: code,
          org_used: gate.org_used, org_cap: gate.org_cap,
        },
      },
    });
  }

  const tools = kiniTools.toAnthropicTools();
  const cid = clientId(req);
  const multiLangSuffix = `\n\nLanguage policy: Detect the language of the user's most recent message. If it's Hindi (Devanagari), Bengali, Odia, Assamese, or another Indian language, reply in the same language and script. Otherwise reply in English. Keep tool call arguments in English (slugs, IDs, JSON values must stay machine-readable).`;
  const crmSuffix = `\n\nYou are KINI, the Kinematic CRM AI assistant. You help sales reps close deals.
You have CRM tools available. Use them to fetch real data — never invent leads, deals, or numbers.
When relevant, return cards via tool results so the UI can render them.
Current route: ${body.context?.route ?? 'unknown'}.
Current entity: ${JSON.stringify(body.context?.entity ?? {})}.
Active client scope: ${cid ?? 'none (org-wide view)'}. Every tool call is hard-filtered to this scope by the backend — do not try to bypass it or reference rows from other clients.${multiLangSuffix}`;
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
    const tokenUsage = (out as { usage?: { input?: number; output?: number } }).usage;
    void kiniQuota.recordQuery(actor, tokenUsage, platform);
    const after = await kiniQuota.getUsage(actor);
    res.json({ success: true, data: { text: out.reply, cards: out.cards, tool_calls: out.tool_calls, usage: after } });
  } catch (e: unknown) {
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

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
import { requireAuth, requireRole } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import * as rbac from '../middleware/rbac';
import { AppError } from '../utils';
import { AuthRequest } from '../types';
import { supabaseAdmin } from '../lib/supabase';

import { demoCrmMiddleware } from '../utils/demoCrm';
import * as v from '../validators/crm.validators';
import * as crud from '../services/crm/crud.service';
import * as leadsSvc from '../services/crm/leads.service';
import * as placesSvc from '../services/crm/places.service';
import * as hierarchy from '../services/crm/hierarchy.service';
import * as dealsSvc from '../services/crm/deals.service';
import * as importSvc from '../services/crm/import.service';
import * as activityImportSvc from '../services/crm/activityImport.service';
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
import * as targetsSvc from '../services/crm/targets.service';
import * as homeSvc from '../services/crm/home.service';
import * as kiniQuota from '../services/crm/ai/kiniQuota.service';
import { chatWithTools } from '../services/crm/ai/aiClient';
import { stampOwnerNames, stampOwnerName, stampSourceNames, stampSourceName, stampCreatedByNames, relabelImportedUploader, stampLinkedEntityNames, listCustomFieldColumns, stampCustomFieldValues } from '../services/crm/owners.helper';
import { discoverExportColumns } from '../services/crm/exportColumns.helper';

const router: Router = express.Router();

// Email tracking (open pixel + click redirect) moved to a dedicated public
// router at src/routes/crm/email-tracking.routes.ts. Those routes have to
// be reachable without a Bearer token because the recipient hits them
// straight from their email client; leaving them in this router meant the
// router-level requireAuth applied in app.ts was 401'ing every inbound
// click. Mount happens before the auth-gated /crm prefix in app.ts.

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

// System roles that get full activity visibility in their org/client
// scope when no narrower org-role designation overrides.
// Most tenants set EVERY user to sub_admin regardless of seniority,
// so this check alone isn't enough — the org_role_data_scope below
// is the canonical signal.
const ADMIN_LIKE_ROLES = new Set([
  'super_admin', 'admin', 'main_admin', 'sub_admin', 'client', 'city_manager', 'supervisor',
]);

/**
 * Returns the userScope opts to pass to crud.list* for activity
 * queries. Three layers, in priority order:
 *
 *   1. org_role.data_scope = 'own' on the user's designation → always
 *      restrict to own rows, regardless of system role. This is the
 *      tenant-configurable signal (set per designation in the
 *      org_roles table). Tata Tiscon's "Consumer Champion" and
 *      "Area Sales Officer" designations have data_scope='own' for
 *      example.
 *   2. org_role.data_scope = 'team' → reserved for future
 *      supervisor-of-direct-reports; for now treat as 'all' (the
 *      hierarchy model isn't wired yet).
 *   3. system role not in ADMIN_LIKE_ROLES → restrict to own.
 *   4. Otherwise full visibility.
 *
 * Centralised here so the same scoping is applied uniformly across
 * the activities list, calendar, export, single-fetch, and the
 * lead/contact/deal/account sub-resource activity endpoints.
 */
function activityVisibilityScope(req: Request): { user_id: string; columns: string[] } | undefined {
  const u = (req as AuthRequest).user;
  if (!u?.id) return undefined;
  if (u.org_role_data_scope === 'own') {
    return { user_id: u.id, columns: ['owner_id', 'assigned_to'] };
  }
  if (u.role && ADMIN_LIKE_ROLES.has(u.role)) return undefined;
  return { user_id: u.id, columns: ['owner_id', 'assigned_to'] };
}

/**
 * Visibility opts for the activity list/sub-resource endpoints. Picks
 * between hierarchy-RBAC subtree scoping and the legacy per-user scope
 * exactly once per request — and returns a spreadable opts fragment so
 * the call sites stay short. Clients that haven't opted into hierarchy
 * RBAC (Tata Tiscon today) hit the same code path they always did.
 */
async function activityScopeOpts(req: AuthRequest): Promise<{
  visibleOwnerIds?: string[] | null;
  ownerColumns?: string[];
  userScope?: { user_id: string; columns: string[] };
}> {
  const subtree = await hierarchy.maybeSubtreeOwnerIds(req);
  if (subtree) {
    return { visibleOwnerIds: subtree, ownerColumns: ['owner_id', 'assigned_to'] };
  }
  return { userScope: activityVisibilityScope(req) };
}

/**
 * Normalise an activity payload to the actual `crm_activities` columns.
 * The dashboard edit modal sends `description`, but the table's note column is
 * `body` — writing `description` straight through made every edit fail with
 * "column description does not exist". Fold `description` into `body`.
 * (`outcome` IS a real column now, so it's left to pass through.)
 */
/**
 * Look up the linked record (lead → contact → account → deal, in that
 * order) and return its `client_id`. Used by the activity POST so the
 * activity inherits its parent's tenant scope instead of the request's
 * X-Client-Id header — that header can be wrong (e.g. NBA suggestions
 * triggered while the picker is on a different client) and would
 * otherwise scribble cross-tenant activities. Returns null when none
 * of the linked-id fields are present or none of the lookups hit.
 */
async function resolveLinkedClientId(
  org_id: string,
  parsed: Record<string, unknown>,
): Promise<string | null> {
  const probes: Array<[string, string]> = [
    ['lead_id', 'crm_leads'],
    ['contact_id', 'crm_contacts'],
    ['account_id', 'crm_accounts'],
    ['deal_id', 'crm_deals'],
  ];
  for (const [key, table] of probes) {
    const id = parsed[key];
    if (typeof id !== 'string' || !UUID_RE.test(id)) continue;
    const { data } = await supabaseAdmin
      .from(table).select('client_id').eq('org_id', org_id).eq('id', id)
      .maybeSingle();
    const cid = (data as { client_id: string | null } | null)?.client_id;
    if (cid) return cid;
  }
  return null;
}

function normalizeActivityPayload(p: Record<string, unknown>): Record<string, unknown> {
  if ('description' in p) {
    if (p.body === undefined || p.body === null) p.body = (p as Record<string, unknown>).description;
    delete (p as Record<string, unknown>).description;
  }
  return p;
}

/**
 * Validate the activities ?owner_id= filter value. Returns the UUID when it's
 * a well-formed id (safe to interpolate into a PostgREST .or()), else null.
 * Used to filter activities by owner_id OR assigned_to.
 */
function activityOwnerFilter(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

// A uuid that can never match a real row — used to force an empty result when
// a location filter resolves to zero leads.
const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000';
const ACTIVITY_LOCATION_KEYS = ['city', 'state', 'district', 'block'] as const;
/**
 * crm_activities has no geo columns — it links to leads via lead_id. The
 * dashboard's global location filter (and the leads filters) send
 * city/state/district/block, so for activities we resolve the matching lead
 * ids first and let the caller filter activities by `lead_id IN (...)`.
 * Returns null when no location filter is present (no constraint), else the
 * list of matching lead ids (possibly empty → caller should show nothing).
 */
async function activityLocationLeadIds(
  query: Record<string, unknown>,
  org_id: string,
  scope: { id: string | null; strict: boolean },
): Promise<string[] | null> {
  const loc: Record<string, string> = {};
  for (const k of ACTIVITY_LOCATION_KEYS) {
    const v = query[k];
    if (typeof v === 'string' && v.trim()) loc[k] = v.trim();
  }
  if (Object.keys(loc).length === 0) return null;
  let lq = supabaseAdmin.from('crm_leads').select('id').eq('org_id', org_id).is('deleted_at', null);
  if (scope.id) {
    lq = scope.strict ? lq.eq('client_id', scope.id) : lq.or(`client_id.is.null,client_id.eq.${scope.id}`);
  }
  for (const [k, v] of Object.entries(loc)) lq = lq.eq(k, v);
  const { data, error } = await lq.limit(20000);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []).map((r: { id: string }) => r.id);
}

/**
 * Single-row access check for activities (GET / PATCH / DELETE
 * /activities/:id). Under hierarchy mode the caller is allowed any
 * activity whose owner_id OR assigned_to is in their subtree; under the
 * legacy mode the existing "own activities only" guard applies. Returns
 * a not-found error to throw if the caller may not touch the row,
 * else null. Using NOT_FOUND (rather than 403) preserves the existing
 * non-disclosure semantic — we don't tell unauthorised callers a row
 * exists.
 */
async function activityAccessError(req: AuthRequest, row: Record<string, unknown>): Promise<AppError | null> {
  const subtree = await hierarchy.maybeSubtreeOwnerIds(req);
  if (subtree) {
    const owner = row.owner_id as string | null;
    const assigned = row.assigned_to as string | null;
    const allowed = (owner && subtree.includes(owner)) || (assigned && subtree.includes(assigned));
    if (!allowed) return new AppError(404, 'crm_activities not found', 'NOT_FOUND');
    return null;
  }
  const userScope = activityVisibilityScope(req);
  if (userScope) {
    if (row.owner_id !== userScope.user_id && row.assigned_to !== userScope.user_id) {
      return new AppError(404, 'crm_activities not found', 'NOT_FOUND');
    }
  }
  return null;
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
  // Hierarchy-RBAC scope: when the caller's client has opted in
  // (clients.settings.uses_hierarchy_rbac === true), restrict the
  // visible owners to the caller's subtree via users.supervisor_id.
  // Every existing client keeps the flag off and skips this branch
  // entirely, so behaviour is unchanged for Tata Tiscon today.
  let visibleOwnerIds: string[] | null = null;
  const hierOn = await hierarchy.useHierarchyRbac(req as AuthRequest);
  if (hierOn) {
    visibleOwnerIds = await hierarchy.subtreeUserIds(req as AuthRequest);
  }
  // A rep always sees their own leads (selfOwnerId) even when the lead's
  // city is outside their scope or absent. City-less leads (the bulk of the
  // book: imported / web-form leads carry no geo tag) must not be hidden by
  // the city filter — they're governed by the owner/hierarchy scope instead.
  // So include them when the caller is a tenant-wide admin (data_scope='all')
  // OR when hierarchy RBAC is active (the owner-subtree filter already bounds
  // exposure, so a manager sees the null-city leads owned by their team
  // rather than losing ~85% of them). Non-hierarchy city-restricted users are
  // unchanged.
  const me = (req as AuthRequest).user;
  const selfOwnerId = me?.id ?? null;
  const includeNullCity = (me?.org_role_data_scope ?? 'all') === 'all' || hierOn;
  // Return both the page and the matching total so the UI can render
  // real pagination ("Page 2 of 47") and a jump control. `data` is the
  // existing array shape every legacy caller expects; `pagination` is
  // additive — old callers ignore it.
  const { rows, total, page, limit } = await leadsSvc.listLeadsWithCount(
    orgId(req), req.query, scope.id, { strictClient: scope.strict, effectiveCities, visibleOwnerIds, selfOwnerId, includeNullCity }
  );
  // Owner UUIDs → owner_name; source UUIDs → source_name; created_by
  // UUIDs → created_by_name. The created_by stamp lets the leads list
  // surface "Uploaded by" without the FE having to resolve user names
  // itself.
  // Imported leads display "Kinematic Admin" as the uploader (relabel only —
  // created_by in the DB still points at the real importer for audit). Keys
  // off source_name, so stampSourceNames must run first.
  const stamped = relabelImportedUploader(await stampCreatedByNames(
    (await stampSourceNames(await stampOwnerNames(rows))) as unknown as Array<Record<string, unknown> & { source_name?: string | null; created_by?: string | null; created_by_name?: string | null }>
  ));
  res.json({
    success: true,
    data: stamped,
    pagination: {
      total, page, limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
}));
leads.post('/', wrap(async (req, res) => {
  const parsed = parse(v.leadCreateSchema, req.body);
  // Tata Tiscon "Also log as Site Visit" checkbox — pop the meta flag
  // off before the lead insert (it's not a column on crm_leads), use it
  // after to spawn a sibling crm_activities row.
  const autoLogSiteVisit = parsed._auto_log_site_visit === true;
  const { _auto_log_site_visit: _drop, ...rest } = parsed;
  const payload = { ...rest, client_id: rest.client_id ?? clientId(req) };
  const lead = await leadsSvc.createLead({ org_id: orgId(req), user_id: userId(req), payload });

  // Spawn the site-visit activity. Best-effort — failures here don't
  // fail the lead create (the rep still gets the lead back in the 201).
  if (autoLogSiteVisit && lead?.id) {
    try {
      const photoUrl = (lead as { photo_url?: string | null }).photo_url ?? null;
      await supabaseAdmin.from('crm_activities').insert({
        org_id: orgId(req),
        client_id: (lead as { client_id?: string | null }).client_id ?? clientId(req) ?? null,
        type: 'site_visit',
        subject: 'Site visit',
        status: 'completed',
        completed_at: new Date().toISOString(),
        activity_date: new Date().toISOString(),
        lead_id: lead.id,
        owner_id: userId(req),
        assigned_to: userId(req),
        // Propagate the lead's photo onto the activity so the FE's
        // site-visit evidence is visible from the Activities timeline
        // without the rep having to upload the same image twice.
        image_url: photoUrl,
        created_by: userId(req),
      });
    } catch { /* non-fatal — the lead create itself succeeded */ }
  }

  res.status(201).json(await stampSourceName(await stampOwnerName(lead)));
}));
// CSV export — same filters as the list endpoint (status, owner, source,
// state/city/district/block, score_gte, q, from, to, etc.) but caps at
// 10k rows server-side and streams a real CSV file. Auth + tenant cap +
// city scope all apply via the same listLeads path; bots can't pull more
// than the user themselves can see.
leads.get('/export', wrap(async (req, res) => {
  const scope = clientScope(req);
  const effectiveCities = rbac.getEffectiveCityNames((req as AuthRequest).user);
  // Same hierarchy-RBAC guard as the list endpoint above. Without this,
  // a user could pull rows via /export that they can't see in the UI.
  let visibleOwnerIds: string[] | null = null;
  const hierOn = await hierarchy.useHierarchyRbac(req as AuthRequest);
  if (hierOn) {
    visibleOwnerIds = await hierarchy.subtreeUserIds(req as AuthRequest);
  }
  // Mirror the list endpoint's visibility so /export never returns more (or
  // fewer) rows than the UI shows: own leads always, and city-less leads for
  // tenant-wide admins or whenever hierarchy RBAC bounds exposure by owner.
  const me = (req as AuthRequest).user;
  const selfOwnerId = me?.id ?? null;
  const includeNullCity = (me?.org_role_data_scope ?? 'all') === 'all' || hierOn;
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
      { strictClient: scope.strict, effectiveCities, visibleOwnerIds, selfOwnerId, includeNullCity },
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
  const enrichedBase = stamped.map((r: any) => ({
    ...r,
    source_name: r.source_id ? (sourceNameById.get(r.source_id) ?? '') : '',
  }));

  // Hydrate the latest_update_by UUID into a display name + pull the full
  // updates timeline (latest-first) so the CSV carries the conversation
  // history each lead carries inside the dashboard. Capped at the last
  // 20 updates per lead in the joined cell so big rows stay manageable;
  // anything more is rare in practice.
  const leadIds = enrichedBase.map((r: any) => r.id).filter(Boolean) as string[];
  const updaterIds = Array.from(new Set(enrichedBase.map((r: any) => r.latest_update_by).filter(Boolean))) as string[];
  const updaterNameById = new Map<string, string>();
  if (updaterIds.length) {
    const { data: us } = await supabaseAdmin
      .from('users').select('id, name, email').in('id', updaterIds);
    for (const u of us ?? []) {
      updaterNameById.set((u as any).id, ((u as any).name as string) || ((u as any).email as string) || '');
    }
  }
  const updatesByLead = new Map<string, Array<{ created_at: string; body: string; author: string }>>();
  if (leadIds.length) {
    const { data: us } = await supabaseAdmin
      .from('crm_lead_updates')
      .select('lead_id, body, created_at, author_id')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })
      .limit(20 * leadIds.length);
    const authorIds = Array.from(new Set((us ?? []).map((u: any) => u.author_id).filter(Boolean))) as string[];
    const authorNameById = new Map<string, string>();
    if (authorIds.length) {
      const { data: au } = await supabaseAdmin.from('users').select('id, name, email').in('id', authorIds);
      for (const a of au ?? []) {
        authorNameById.set((a as any).id, ((a as any).name as string) || ((a as any).email as string) || '');
      }
    }
    for (const u of (us ?? []) as any[]) {
      if (!updatesByLead.has(u.lead_id)) updatesByLead.set(u.lead_id, []);
      const list = updatesByLead.get(u.lead_id)!;
      if (list.length >= 20) continue;
      list.push({
        created_at: u.created_at,
        body: u.body,
        author: u.author_id ? (authorNameById.get(u.author_id) ?? '') : '',
      });
    }
  }

  // Pull the tenant's admin-defined lead custom fields and flatten each
  // row.custom_fields[field_key] onto a `custom__<key>` synthetic column
  // so the CSV writer below picks them up via the same `r[col.key]` lookup
  // as the built-in columns. Auto-includes every new field the admin adds.
  const customCols = await listCustomFieldColumns(orgId(req), 'lead');
  const enrichedHydrated = enrichedBase.map((r: any) => ({
    ...r,
    latest_update_by_name: r.latest_update_by ? (updaterNameById.get(r.latest_update_by) ?? '') : '',
    updates_history: (updatesByLead.get(r.id) ?? [])
      .map((u) => `${u.created_at.slice(0, 16).replace('T', ' ')} ${u.author ? `[${u.author}]` : ''} ${u.body}`)
      .join(' | '),
  }));
  const enriched = stampCustomFieldValues(enrichedHydrated as any[], customCols);

  // Auto-discover the column set from the sample row so any column added
  // by a future migration appears in the next CSV pull without a code
  // change. exportColumns.helper applies an exclude list (UUIDs, hashes,
  // internal jsonb, soft-delete markers) and a preferred ordering.
  // We prepend the raw lead id as a leading "Lead ID" column — it's the
  // exact match key for the bulk coordinate upload (Leads → export → add
  // lat/long → re-upload). discoverExportColumns excludes UUIDs by design,
  // so we add it explicitly here rather than un-excluding it globally
  // (which would leak/mislabel ids in deal/contact/account exports).
  const cols: Array<{ key: string; label: string }> = enriched.length > 0
    ? [{ key: 'id', label: 'Lead ID' }, ...discoverExportColumns(enriched[0] as Record<string, unknown>)]
    : [];
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
// Geo points for the dashboard map — every lead that carries real
// coordinates, with just the fields the map needs. The list endpoint caps at
// 200 rows; the map needs all of them, so this dedicated endpoint returns up
// to 5000 minimal rows. Tenant + client scoped; honours the city/state filter
// (so the map respects the global location scope). Must be declared before
// '/:id' so the literal path wins over the param route.
leads.get('/geo', wrap(async (req, res) => {
  const scope = clientScope(req);
  const me = (req as AuthRequest).user!;
  // `phone` is included so the mobile "Nearest Leads" board can light up
  // the Call / WhatsApp quick actions per row. Without it those buttons
  // gated to disabled because the geo payload had no phone field.
  let q = supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, phone, email, city, state, status, latitude, longitude, score, score_grade')
    .eq('org_id', orgId(req)).is('deleted_at', null)
    .not('latitude', 'is', null).not('longitude', 'is', null);
  if (scope.id) {
    q = scope.strict ? q.eq('client_id', scope.id) : q.or(`client_id.is.null,client_id.eq.${scope.id}`);
  }
  // Visibility scope — mirror the list endpoint so the map shows exactly the
  // leads the rep can see in the list: leads in their effective cities (so a
  // city-allocated Area Sales Officer sees their Consumer Champions' pins),
  // OR owned by them / their hierarchy subtree. Admins / data_scope='all'
  // see everything.
  const effectiveCities = rbac.getEffectiveCityNames(me);
  const subtreeIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  const hasCity = effectiveCities !== null;
  const hasOwner = subtreeIds !== null;
  // data_scope='own' on a non-hierarchy client still scopes to self.
  const ownOnly = !hasOwner && (me.org_role_data_scope ?? 'all') === 'own';
  if (hasCity || hasOwner || ownOnly) {
    const orParts: string[] = [];
    if (hasCity && effectiveCities!.length > 0) {
      const cityCsv = effectiveCities!.map((c) => `"${String(c).replace(/[\\"]/g, (m) => '\\' + m)}"`).join(',');
      orParts.push(`city.in.(${cityCsv})`);
    }
    if (me.id) orParts.push(`owner_id.eq.${me.id}`);
    if (hasOwner && subtreeIds!.length > 0) orParts.push(`owner_id.in.(${subtreeIds!.join(',')})`);
    q = orParts.length ? q.or(orParts.join(',')) : q.eq('owner_id', NO_MATCH_UUID);
  }
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  if (city) q = q.eq('city', city);
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  if (state) q = q.eq('state', state);
  const { data, error } = await q.limit(5000);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data: data ?? [] });
}));
leads.get('/:id', wrap(async (req, res) => res.json(await stampSourceName(await stampOwnerName(await leadsSvc.getLead(orgId(req), req.params.id))))));
leads.patch('/:id', wrap(async (req, res) => {
  const parsed = parse(v.leadUpdateSchema, req.body);
  // Mirror the POST path: the rep can tick "Also log as Site Visit" on
  // the edit form too, e.g. for a follow-up visit on a lead they
  // created earlier without ticking the box. Pop the flag off — it's
  // not a column — and best-effort spawn the activity after the update.
  const autoLogSiteVisit = parsed._auto_log_site_visit === true;
  const { _auto_log_site_visit: _drop, ...rest } = parsed;
  const lead = await leadsSvc.updateLead(orgId(req), req.params.id, rest, userId(req));
  if (autoLogSiteVisit && lead?.id) {
    try {
      const photoUrl = (lead as { photo_url?: string | null }).photo_url ?? null;
      await supabaseAdmin.from('crm_activities').insert({
        org_id: orgId(req),
        client_id: (lead as { client_id?: string | null }).client_id ?? clientId(req) ?? null,
        type: 'site_visit',
        subject: 'Site visit',
        status: 'completed',
        completed_at: new Date().toISOString(),
        activity_date: new Date().toISOString(),
        lead_id: lead.id,
        owner_id: userId(req),
        assigned_to: userId(req),
        image_url: photoUrl,
        created_by: userId(req),
      });
    } catch { /* non-fatal — the lead update itself succeeded */ }
  }
  res.json(await stampSourceName(await stampOwnerName(lead)));
}));
leads.delete('/:id', wrap(async (req, res) => { await leadsSvc.deleteLead(orgId(req), req.params.id); res.status(204).end(); }));
leads.post('/:id/score', wrap(async (req, res) => res.json(await leadsSvc.rescoreLead(orgId(req), req.params.id))));
leads.post('/:id/convert', wrap(async (req, res) =>
  res.json(await leadsSvc.convertLead(orgId(req), req.params.id, parse(v.leadConvertSchema, req.body), userId(req)))));
// Reopen / unconvert — flips back to 'working' and clears terminal fields.
leads.post('/:id/reopen', wrap(async (req, res) =>
  res.json(await stampSourceName(await stampOwnerName(await leadsSvc.reopenLead(orgId(req), req.params.id, parse(v.leadReopenSchema, req.body), userId(req)))))));
leads.get('/:id/score-history', wrap(async (req, res) => res.json(await leadsSvc.listScoreHistory(orgId(req), req.params.id))));
leads.get('/:id/activities', wrap(async (req, res) => {
  const visibilityOpts = await activityScopeOpts(req as AuthRequest);
  // The dashboard auto-attaches the global geo scope (?city/&state/...)
  // to every /api/v1/crm/leads/* GET. crm_activities has no geo columns,
  // so passing those through to crud.list runs `.eq('city', …)` against
  // a non-existent column and PostgREST 400s — the activities tab on
  // the lead detail page then renders empty even though rows exist.
  // The lead-id filter already scopes the result to a single lead, so
  // any global geo filter would be redundant anyway; strip them.
  const { city: _c, state: _s, district: _d, block: _b, ...rest } = req.query as Record<string, unknown>;
  return res.json(
    await crud.list('crm_activities', orgId(req), { lead_id: req.params.id, ...rest }, {
      // Sort by the generated activity_date column (COALESCE of
      // completed_at, due_at, created_at) so the tab reads as a real
      // timeline regardless of whether rows are done or planned.
      defaultSort: { column: 'activity_date', ascending: false },
      ...visibilityOpts,
    }),
  );
}));
leads.get('/:id/deals', wrap(async (req, res) => res.json(
  await crud.list('crm_deals', orgId(req), { lead_id: req.params.id, ...req.query })
)));
leads.post('/bulk-assign', wrap(async (req, res) => {
  const body = parse(z.object({ lead_ids: z.array(z.string().uuid()), owner_id: z.string().uuid() }), req.body);
  res.json(await leadsSvc.bulkAssign(orgId(req), body.lead_ids, body.owner_id, userId(req)));
}));
// Bulk lat/long backfill for existing leads. Body: { rows: [{ id|email|phone,
// latitude, longitude }] }. Matched to leads by id → email → phone, all
// org-scoped. Powers the dashboard "upload coordinates" tool.
leads.post('/bulk-coordinates', wrap(async (req, res) => {
  const body = parse(v.leadBulkCoordinatesSchema, req.body);
  // Schema requires latitude/longitude on every row (refine guarantees a
  // matcher too); cast past zod's optional-number inference.
  res.json(await leadsSvc.bulkUpdateCoordinates(orgId(req), body.rows as leadsSvc.BulkCoordinateRow[], userId(req)));
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
// Home aggregator — composes today's target + near-to-close leads +
// next-best-actions (rules-based, no LLM round-trip) + today's activity
// + productivity tips into one payload so the Home tab on web + mobile
// is a single round-trip. See home.service.ts for the merge logic.
router.get('/home', wrap(async (req, res) => {
  const me = (req as AuthRequest).user;
  if (!me?.id) throw new AppError(401, 'Auth required', 'AUTH_REQUIRED');
  const payload = await homeSvc.homePayload({
    org_id: orgId(req),
    user_id: me.id,
    client_id: clientId(req),
  });
  res.json({ success: true, data: payload });
}));

router.use('/leads', rbac.requireModuleAccess('crm_leads'), leads);

// ---------- CONTACTS -------------------------------------------------
const contacts = express.Router();
const contactOpts = { searchColumns: ['first_name','last_name','email','phone'] };
contacts.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  const visibleOwnerIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  return res.json(
    await stampOwnerNames(await crud.clientScopedList('crm_contacts', orgId(req), scope.id, req.query, { ...contactOpts, strictClient: scope.strict, visibleOwnerIds }))
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
contacts.get('/:id/activities', wrap(async (req, res) => {
  const visibilityOpts = await activityScopeOpts(req as AuthRequest);
  return res.json(
    await crud.list('crm_activities', orgId(req), { contact_id: req.params.id, ...req.query }, {
      // Sort by the generated activity_date column (COALESCE of
      // completed_at, due_at, created_at) so the tab reads as a real
      // timeline regardless of whether rows are done or planned.
      defaultSort: { column: 'activity_date', ascending: false },
      ...visibilityOpts,
    }),
  );
}));
contacts.get('/:id/deals', wrap(async (req, res) => res.json(
  await crud.list('crm_deals', orgId(req), { primary_contact_id: req.params.id, ...req.query })
)));
contacts.get('/:id/notes', wrap(async (req, res) => res.json(
  await crud.list('crm_notes', orgId(req), { entity_type: 'contact', entity_id: req.params.id, ...req.query }, { softDelete: false })
)));
contacts.get('/:id/emails', wrap(async (req, res) => res.json(await emailsSvc.listLogs(orgId(req), { contact_id: req.params.id }))));
router.use('/contacts', rbac.requireModuleAccess('crm_contacts'), contacts);

// ---------- ACCOUNTS -------------------------------------------------
const accounts = express.Router();
accounts.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  const visibleOwnerIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  return res.json(
    await stampOwnerNames(await crud.clientScopedList('crm_accounts', orgId(req), scope.id, req.query, { searchColumns: ['name','domain','industry'], strictClient: scope.strict, visibleOwnerIds }))
  );
}));
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
accounts.get('/:id/activities', wrap(async (req, res) => {
  const visibilityOpts = await activityScopeOpts(req as AuthRequest);
  return res.json(
    await crud.list('crm_activities', orgId(req), { account_id: req.params.id, ...req.query }, {
      // Sort by the generated activity_date column (COALESCE of
      // completed_at, due_at, created_at) so the tab reads as a real
      // timeline regardless of whether rows are done or planned.
      defaultSort: { column: 'activity_date', ascending: false },
      ...visibilityOpts,
    }),
  );
}));
accounts.get('/:id/notes', wrap(async (req, res) => res.json(
  await crud.list('crm_notes', orgId(req), { entity_type: 'account', entity_id: req.params.id, ...req.query }, { softDelete: false })
)));
accounts.post('/:id/summarize', wrap(async (req, res) =>
  res.json({ text: await summarizeSvc.summarizeAccount(orgId(req), req.params.id) })));
router.use('/accounts', rbac.requireModuleAccess('crm_accounts'), accounts);

// ---------- DEALS ----------------------------------------------------
const deals = express.Router();
deals.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  const visibleOwnerIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  const [{ rows, total, page, limit }, totals] = await Promise.all([
    dealsSvc.listDealsWithCount(orgId(req), req.query, scope.id, { strictClient: scope.strict, visibleOwnerIds }),
    dealsSvc.dealsTotals(orgId(req), req.query, scope.id, { strictClient: scope.strict, visibleOwnerIds }),
  ]);
  const stamped = await stampOwnerNames(rows);
  res.json({
    success: true,
    data: stamped,
    // Value + volume summed across the whole filtered set (all pages).
    totals: { value: totals.total_value, volume_kg: totals.total_volume_kg },
    pagination: {
      total, page, limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
}));
// CSV export of every deal visible to the caller. Mirrors the
// activities/export pattern: paginated fetch up to MAX rows so a
// massive org can't OOM the server, then enriched in batch with
// lead / contact / account / owner names and the line-items
// breakdown captured at convert time.
deals.get('/export', wrap(async (req, res) => {
  const scope = clientScope(req);
  const visibleOwnerIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  const PAGE = 200;
  const MAX  = 10000;
  const rows: any[] = [];
  for (let page = 1; rows.length < MAX; page++) {
    const { rows: chunk } = await dealsSvc.listDealsWithCount(
      orgId(req), { ...req.query, limit: PAGE, page }, scope.id, { strictClient: scope.strict, visibleOwnerIds },
    );
    rows.push(...(chunk as any[]));
    if ((chunk as any[]).length < PAGE) break;
  }
  const limited = rows.slice(0, MAX);
  const stamped = await stampOwnerNames(limited);
  // Reuse the shared linked-entity decorator so the CSV reads
  // "Acme Steel" instead of a UUID. Deals' primary-contact column is
  // named `primary_contact_id` though, while the decorator expects
  // `contact_id` — alias it on the way in, strip on the way out so
  // we don't accidentally clobber the original column name on the
  // returned row.
  const aliased = stamped.map((r: any) => ({ ...r, contact_id: r.primary_contact_id ?? null }));
  const enriched = await stampLinkedEntityNames(aliased as any[]);

  // Resolve stage_name from the embedded crm_deal_stages relation —
  // listDealsWithCount selects it as `crm_deal_stages` (an object).
  // Flatten to a single string so the CSV stays one column.
  const flat = enriched.map((r: any) => {
    const stage = r.crm_deal_stages || null;
    const cf    = (r.custom_fields || {}) as Record<string, unknown>;
    const lines = Array.isArray((cf as any).line_items) ? ((cf as any).line_items as any[]) : [];
    // Render each line as "ProductName (Npc, Kkg, ₹Subtotal)" joined by
    // "; " — a single column is easier to filter in Excel than N
    // variable-width product columns, and the per-row math is already
    // captured during convert so we don't recompute.
    const lineItemsStr = lines.map((l) => {
      const parts: string[] = [];
      if (l.pieces    != null) parts.push(`${Number(l.pieces).toLocaleString()}pc`);
      if (l.volume_kg != null) parts.push(`${Number(l.volume_kg).toLocaleString()}kg`);
      if (l.subtotal  != null) parts.push(`₹${Number(l.subtotal).toLocaleString()}`);
      const name = l.product_name || l.product_id || 'Product';
      return parts.length ? `${name} (${parts.join(', ')})` : String(name);
    }).join('; ');
    const totalPieces = lines.reduce((s: number, l: any) => s + (Number(l.pieces)    || 0), 0);
    const totalKg     = Number((cf as any).volume_kg ?? lines.reduce((s: number, l: any) => s + (Number(l.volume_kg) || 0), 0));

    return {
      ...r,
      stage_name:   stage?.name ?? null,
      total_pieces: totalPieces > 0 ? totalPieces : null,
      total_kg:     totalKg > 0 ? totalKg : null,
      line_items_str: lineItemsStr || null,
      tags_str:     Array.isArray(r.tags) ? r.tags.join(', ') : null,
      probability_pct: r.probability != null ? `${Math.round(Number(r.probability) * 100)}%` : null,
    };
  });
  // Append admin-defined deal custom fields after the built-in columns.
  // Same flattening + stamping as leads/export so the CSV writer below
  // reads each value via the synthetic custom__<field_key> column.
  const customCols = await listCustomFieldColumns(orgId(req), 'deal');
  const flatWithCustom = stampCustomFieldValues(flat as any[], customCols);

  const cols: Array<{ key: string; label: string }> = [
    { key: 'name',                label: 'Name' },
    { key: 'stage_name',          label: 'Stage' },
    { key: 'status',              label: 'Status' },
    { key: 'amount',              label: 'Amount' },
    { key: 'currency',            label: 'Currency' },
    { key: 'probability_pct',     label: 'Probability' },
    { key: 'expected_close_date', label: 'Expected Close Date' },
    { key: 'lead_name',           label: 'Source Lead' },
    { key: 'lead_phone',          label: 'Source Lead Phone' },
    { key: 'account_name',        label: 'Account' },
    { key: 'contact_name',        label: 'Primary Contact' },
    { key: 'owner_name',          label: 'Owner' },
    { key: 'total_pieces',        label: 'Total Pieces' },
    { key: 'total_kg',            label: 'Total Volume (kg)' },
    { key: 'line_items_str',      label: 'Line Items' },
    { key: 'tags_str',            label: 'Tags' },
    { key: 'won_at',              label: 'Won At' },
    { key: 'lost_at',             label: 'Lost At' },
    { key: 'lost_reason',         label: 'Lost Reason' },
    { key: 'created_at',          label: 'Created At' },
    ...customCols.map((c) => ({ key: c.key, label: c.label })),
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = cols.map((c) => c.label).join(',');
  const body = flatWithCustom.map((r: any) =>
    cols.map((c) => escape((r as Record<string, unknown>)[c.key])).join(',')
  ).join('\n');
  const csv = `${header}\n${body}\n`;
  const filename = `deals-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
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
deals.get('/:id/activities', wrap(async (req, res) => {
  const visibilityOpts = await activityScopeOpts(req as AuthRequest);
  return res.json(
    await crud.list('crm_activities', orgId(req), { deal_id: req.params.id, ...req.query }, {
      // Sort by the generated activity_date column (COALESCE of
      // completed_at, due_at, created_at) so the tab reads as a real
      // timeline regardless of whether rows are done or planned.
      defaultSort: { column: 'activity_date', ascending: false },
      ...visibilityOpts,
    }),
  );
}));
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
router.use('/deals', rbac.requireModuleAccess('crm_deals'), deals);

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
  const subtreeIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  // Hierarchy mode supersedes the per-user scope (the caller's id is
  // always in their subtree, so the new filter is a strict superset of
  // the old "own activities only" filter). When the gate is off we
  // fall back to the legacy userScope behaviour unchanged.
  const userScope = subtreeIds ? undefined : activityVisibilityScope(req);
  let q = supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', orgId(req)).is('deleted_at', null).gte('due_at', from).lte('due_at', to);
  if (scope.id) {
    q = scope.strict
      ? q.eq('client_id', scope.id)
      : q.or(`client_id.is.null,client_id.eq.${scope.id}`);
  }
  if (subtreeIds) {
    if (subtreeIds.length === 0) { res.json([]); return; }
    const ids = subtreeIds.join(',');
    q = q.or(`owner_id.in.(${ids}),assigned_to.in.(${ids})`);
  } else if (userScope) {
    q = q.or(userScope.columns.map((c) => `${c}.eq.${userScope.user_id}`).join(','));
  }
  const { data } = await q.order('due_at', { ascending: true });
  const stamped = await stampOwnerNames(data ?? []);
  res.json(await stampLinkedEntityNames(stamped as any[]));
}));
activities.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  const subtreeIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  // `view` is the dashboard's KPI-tile-as-filter: clicking the
  // Overdue / Upcoming / Completed tile sends ?view=<x>, and we
  // translate that into the right date predicates here.
  //   overdue   = past due AND not yet completed
  //   upcoming  = due in the future AND not yet completed
  //   completed = explicitly marked completed (via completed_at)
  //   all       = no extra constraint (default)
  const view = String(req.query.view ?? 'all').toLowerCase();
  const nowIso = new Date().toISOString();
  // The FE/owner filter (?owner_id=) must match either owner_id OR
  // assigned_to: activities are almost always tracked via assigned_to with
  // owner_id null, so a plain owner_id.eq filter (what the generic crud
  // helper would apply) hides them all. Strip it from the generic query and
  // apply an OR here instead.
  const ownerFilter = activityOwnerFilter(req.query.owner_id);
  // Location filter (city/state/district/block) → resolve to lead ids, since
  // crm_activities has no geo columns. null = no location filter.
  const locLeadIds = await activityLocationLeadIds(req.query as Record<string, unknown>, orgId(req), scope);
  // Pull from/to out of the query and apply them ourselves below — the
  // generic crud helper filters on a single column (completed_at by
  // default), which silently hides every planned/upcoming activity
  // because completed_at IS NULL until the row is marked done. Reps
  // logging "Followup tomorrow" against a lead would then see nothing
  // in the activity list whenever the dashboard's date range picker
  // was set to anything but "All time".
  const { owner_id: _ownerOmit, city: _c, state: _s, district: _d, block: _b, from: fromQ, to: toQ, ...listQuery } = req.query as Record<string, unknown>;
  const from = typeof fromQ === 'string' && fromQ ? fromQ : null;
  const to = typeof toQ === 'string' && toQ ? toQ : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extraFilters = (q: any) => {
    if (view === 'overdue')   q = q.not('due_at', 'is', null).lt('due_at', nowIso).is('completed_at', null);
    else if (view === 'upcoming')  q = q.not('due_at', 'is', null).gte('due_at', nowIso).is('completed_at', null);
    else if (view === 'completed') q = q.not('completed_at', 'is', null);
    if (ownerFilter) q = q.or(`owner_id.eq.${ownerFilter},assigned_to.eq.${ownerFilter}`);
    if (locLeadIds !== null) q = q.in('lead_id', locLeadIds.length ? locLeadIds : [NO_MATCH_UUID]);
    // View-aware date-range filter so planned activities don't vanish
    // whenever a date range is picked:
    //   completed view → filter by completed_at
    //   overdue / upcoming view → due_at (the natural axis there)
    //   all view → row qualifies if ANY of completed_at / due_at /
    //              created_at falls inside the window, expressed as a
    //              PostgREST .or() of three and-conditions.
    if (from || to) {
      if (view === 'completed') {
        if (from) q = q.gte('completed_at', from);
        if (to) q = q.lte('completed_at', to);
      } else if (view === 'overdue' || view === 'upcoming') {
        if (from) q = q.gte('due_at', from);
        if (to) q = q.lte('due_at', to);
      } else {
        const lo = from ?? '0001-01-01';
        const hi = to ?? '9999-12-31';
        q = q.or(
          [
            `and(completed_at.gte.${lo},completed_at.lte.${hi})`,
            `and(due_at.gte.${lo},due_at.lte.${hi})`,
            `and(created_at.gte.${lo},created_at.lte.${hi})`,
          ].join(','),
        );
      }
    }
    return q;
  };
  const { rows, total, page, limit } = await crud.clientScopedListWithCount(
    'crm_activities', orgId(req), scope.id, listQuery,
    {
      // Sort by `activity_date` — a generated column on crm_activities
      // that is COALESCE(completed_at, due_at, created_at), so the list
      // reads chronologically: completed rows by when they were done,
      // planned rows by when they're due, orphans by when they were
      // logged. Indexed on (org_id, client_id, activity_date DESC).
      defaultSort: { column: 'activity_date', ascending: false },
      searchColumns: ['subject', 'body'],
      strictClient: scope.strict,
      // Hierarchy gate on → caller sees self + subtree across
      // owner_id and assigned_to. Gate off → fall back to the legacy
      // per-user scope (own activities for non-admins).
      ...(subtreeIds
        ? { visibleOwnerIds: subtreeIds, ownerColumns: ['owner_id', 'assigned_to'] }
        : { userScope: activityVisibilityScope(req) }),
      extraFilters,
    },
  );
  const stamped = await stampOwnerNames(rows as Record<string, unknown>[]);
  // Decorate each activity with the linked entity's display name
  // (lead/contact/account/deal) so the UI can render "Rakesh Sharma"
  // instead of a generic "Lead" badge. Two extra batched lookups,
  // one round-trip each, regardless of page size.
  const enriched = await stampLinkedEntityNames(stamped as any[]);
  res.json({
    success: true,
    data: enriched,
    pagination: {
      total, page, limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
}));
// CSV export — same filters as the list endpoint. Pages through all
// matching rows up to a 10k cap with the same tenant + client scope
// the list path uses. Stamps owner names + resolves the parent record
// (lead / contact / account / deal) name so the CSV reads in plain
// English instead of dangling UUIDs.
activities.get('/export', wrap(async (req, res) => {
  const scope = clientScope(req);
  // Same hierarchy/userScope split as the list endpoint — without it
  // the export would leak rows the user can't see in the UI.
  const subtreeIds = await hierarchy.maybeSubtreeOwnerIds(req as AuthRequest);
  const userScope = subtreeIds ? undefined : activityVisibilityScope(req);
  const visibilityOpts = subtreeIds
    ? { visibleOwnerIds: subtreeIds, ownerColumns: ['owner_id', 'assigned_to'] }
    : { userScope };
  // Match the list endpoint: ?owner_id= filters on owner_id OR assigned_to,
  // and city/state/district/block filter via the linked lead.
  const ownerFilter = activityOwnerFilter(req.query.owner_id);
  const locLeadIds = await activityLocationLeadIds(req.query as Record<string, unknown>, orgId(req), scope);
  const exportView = String(req.query.view ?? 'all').toLowerCase();
  // Strip from/to here too — same reasoning as the list endpoint above:
  // the single-column dateRangeColumn filter on completed_at would
  // hide every planned activity from the export the moment a range
  // is set, leaving the two surfaces out of sync.
  const { owner_id: _ownerOmit, city: _c, state: _s, district: _d, block: _b, from: fromQ, to: toQ, ...exportQuery } = req.query as Record<string, unknown>;
  const fromExp = typeof fromQ === 'string' && fromQ ? fromQ : null;
  const toExp = typeof toQ === 'string' && toQ ? toQ : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ownerExtra = (ownerFilter || locLeadIds !== null || fromExp || toExp)
    ? (q: any) => {
        if (ownerFilter) q = q.or(`owner_id.eq.${ownerFilter},assigned_to.eq.${ownerFilter}`);
        if (locLeadIds !== null) q = q.in('lead_id', locLeadIds.length ? locLeadIds : [NO_MATCH_UUID]);
        if (fromExp || toExp) {
          if (exportView === 'completed') {
            if (fromExp) q = q.gte('completed_at', fromExp);
            if (toExp) q = q.lte('completed_at', toExp);
          } else if (exportView === 'overdue' || exportView === 'upcoming') {
            if (fromExp) q = q.gte('due_at', fromExp);
            if (toExp) q = q.lte('due_at', toExp);
          } else {
            const lo = fromExp ?? '0001-01-01';
            const hi = toExp ?? '9999-12-31';
            q = q.or(
              [
                `and(completed_at.gte.${lo},completed_at.lte.${hi})`,
                `and(due_at.gte.${lo},due_at.lte.${hi})`,
                `and(created_at.gte.${lo},created_at.lte.${hi})`,
              ].join(','),
            );
          }
        }
        return q;
      }
    : undefined;
  const PAGE = 200;
  const MAX  = 10000;
  const rows: any[] = [];
  for (let page = 1; rows.length < MAX; page++) {
    const chunk = await crud.clientScopedList(
      'crm_activities',
      orgId(req),
      scope.id,
      { ...exportQuery, limit: PAGE, page },
      { defaultSort: { column: 'activity_date', ascending: false }, searchColumns: ['subject','body'], strictClient: scope.strict, ...visibilityOpts, ...(ownerExtra ? { extraFilters: ownerExtra } : {}) },
    );
    rows.push(...(chunk as any[]));
    if ((chunk as any[]).length < PAGE) break;
  }
  const stamped = await stampOwnerNames(rows.slice(0, MAX));
  // Resolve lead / contact / account / deal names via the shared
  // helper so the CSV reads "Rakesh Sharma" instead of a UUID. Same
  // decorator the list endpoint uses — keeps the two paths in lockstep.
  const enriched = await stampLinkedEntityNames(stamped as any[]);

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
    { key: 'lead_phone',       label: 'Lead Phone' },
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
  const parsed = normalizeActivityPayload(parse(v.activitySchema, req.body));
  // Derive client_id from the linked lead / contact / account / deal
  // when one is present, instead of blindly stamping clientId(req) from
  // the X-Client-Id header. NBA "Call the lead" / "Follow up" flows
  // surface from any list view — if the user's picker happens to be
  // on a different tenant when the suggestion fires, the activity
  // would otherwise land on the wrong client and become invisible on
  // the lead's detail page (the activities tab is scoped to the lead's
  // client). The header value stays the fallback for orphan-style
  // creates (no linked record, currently blocked by activitySchema but
  // kept defensively).
  const linkedClientId = await resolveLinkedClientId(orgId(req), parsed);
  const payload: Record<string, unknown> = {
    ...parsed,
    client_id: linkedClientId ?? clientId(req),
  };
  // Default owner to the creating user when not specified. Otherwise
  // a non-admin user could create an activity they're then not allowed
  // to see (because activityVisibilityScope filters on owner_id /
  // assigned_to). Admins explicitly setting owner_id keep that value.
  if (!payload.owner_id && !payload.assigned_to) {
    const uid = userId(req);
    if (uid) payload.owner_id = uid;
  }
  const created = await crud.create('crm_activities', orgId(req), payload, userId(req)) as Record<string, unknown>;
  // Side-effect: mirror to the assignee/owner's Google Calendar when
  // they've connected the integration. Fire-and-forget — calendar
  // hiccups must not block the CRM write or the response.
  void (async () => {
    try {
      const { pushActivity } = await import('../services/integrations/googleCalendar.service');
      const evId = await pushActivity(orgId(req), created as any);
      if (evId) {
        await supabaseAdmin.from('crm_activities').update({ google_event_id: evId }).eq('id', created.id);
      }
    } catch (e) { console.warn('[googleCalendar] post-create hook failed', (e as Error).message); }
  })();
  res.status(201).json(await stampOwnerName(created));
}));
activities.get('/:id', wrap(async (req, res) => {
  const row = await crud.get('crm_activities', orgId(req), req.params.id) as Record<string, unknown>;
  const err = await activityAccessError(req as AuthRequest, row);
  if (err) throw err;
  res.json(await stampOwnerName(row));
}));
activities.patch('/:id', wrap(async (req, res) => {
  const existing = await crud.get('crm_activities', orgId(req), req.params.id) as Record<string, unknown>;
  const err = await activityAccessError(req as AuthRequest, existing);
  if (err) throw err;
  const updated = await crud.update('crm_activities', orgId(req), req.params.id, normalizeActivityPayload(parse(v.activitySchemaBase.partial(), req.body)), userId(req)) as Record<string, unknown>;
  void (async () => {
    try {
      const { pushActivity } = await import('../services/integrations/googleCalendar.service');
      const evId = await pushActivity(orgId(req), updated as any);
      if (evId && evId !== updated.google_event_id) {
        await supabaseAdmin.from('crm_activities').update({ google_event_id: evId }).eq('id', updated.id);
      }
    } catch (e) { console.warn('[googleCalendar] post-update hook failed', (e as Error).message); }
  })();
  res.json(await stampOwnerName(updated));
}));
activities.delete('/:id', wrap(async (req, res) => {
  const existing = await crud.get('crm_activities', orgId(req), req.params.id) as Record<string, unknown>;
  const err = await activityAccessError(req as AuthRequest, existing);
  if (err) throw err;
  await crud.softDelete('crm_activities', orgId(req), req.params.id);
  void (async () => {
    try {
      const { deleteActivity } = await import('../services/integrations/googleCalendar.service');
      await deleteActivity(orgId(req), existing as any);
    } catch (e) { console.warn('[googleCalendar] post-delete hook failed', (e as Error).message); }
  })();
  res.status(204).end();
}));
router.use('/activities', rbac.requireModuleAccess('crm_activities'), activities);

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
router.use('/tasks', rbac.requireModuleAccess('crm_tasks'), tasks);

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
      // Route through the shared helper so query filters actually apply:
      // `q` (via searchColumns), any non-reserved key as `.eq`, plus the
      // client scope. Previously this branch built its own query and
      // ignored req.query, so e.g. the products search box + category
      // filter did nothing.
      const scope = clientScope(req);
      const data = await crud.clientScopedList(table, orgId(req), scope.id, req.query, {
        ...opts,
        strictClient: scope.strict,
      });
      return res.json(data);
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

// People Directory — per-client address book (dealers / influencers /
// referrers) that sits alongside contacts. Strict client scope so Tata
// Tiscon's roster never leaks into Kinematic and vice-versa. RBAC gate:
// only roles with `crm_settings` can manage entries (CRM Admin /
// Business Head / Distributor GM), matching the user's request that
// CRM Admin and above own this surface.
const peopleDir = express.Router();
peopleDir.get('/', wrap(async (req, res) => {
  const scope = clientScope(req);
  res.json(await crud.clientScopedList(
    'people_directory', orgId(req), scope.id, req.query,
    {
      defaultSort: { column: 'created_at', ascending: false },
      searchColumns: ['first_name', 'last_name', 'mobile', 'email'],
      strictClient: true,
    },
  ));
}));
peopleDir.get('/:id', wrap(async (req, res) =>
  res.json(await crud.get('people_directory', orgId(req), req.params.id))));
peopleDir.post('/', wrap(async (req, res) => {
  const parsed = parse(v.peopleDirectorySchema, req.body);
  const cid = clientId(req);
  if (!cid) throw new AppError(400, 'A client must be selected to add to the People Directory', 'CLIENT_REQUIRED');
  const payload: Record<string, unknown> = { ...parsed, client_id: cid };
  res.status(201).json(await crud.create('people_directory', orgId(req), payload, userId(req)));
}));
peopleDir.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('people_directory', orgId(req), req.params.id, parse(v.peopleDirectoryBase.partial(), req.body), userId(req)))));
peopleDir.delete('/:id', wrap(async (req, res) => {
  await crud.softDelete('people_directory', orgId(req), req.params.id);
  res.status(204).end();
}));

// Bulk-import endpoint. Takes mapped rows from the dashboard mapping UI
// and writes them with simple mobile/email-based dedup. `on_duplicate`
// switches between skip (default) and update — both modes report counts
// back so the FE can show "added X, updated Y, skipped Z".
peopleDir.post('/bulk-import', wrap(async (req, res) => {
  const body = parse(v.peopleDirectoryBulkImportSchema, req.body);
  const cid = clientId(req);
  if (!cid) throw new AppError(400, 'A client must be selected to import People Directory rows', 'CLIENT_REQUIRED');
  const org_id = orgId(req);
  let added = 0, updated = 0, skipped = 0;
  for (const row of body.rows) {
    const first_name = row.first_name?.trim() || null;
    const last_name  = row.last_name?.trim()  || null;
    const mobile     = row.mobile?.trim()     || null;
    const email      = row.email?.trim()      || null;
    const address    = row.address?.trim()    || null;
    const personType = row.type?.trim()       || null;
    const city       = row.city?.trim()       || null;
    if (!first_name && !last_name && !mobile && !email) { skipped++; continue; }

    // Look up an existing row by mobile then email — both are
    // independently indexed so the probe stays O(log n).
    let existingId: string | null = null;
    if (mobile) {
      const r = await supabaseAdmin.from('people_directory').select('id')
        .eq('org_id', org_id).eq('client_id', cid).eq('mobile', mobile)
        .is('deleted_at', null).limit(1).maybeSingle();
      existingId = (r.data?.id as string) ?? null;
    }
    if (!existingId && email) {
      const r = await supabaseAdmin.from('people_directory').select('id')
        .eq('org_id', org_id).eq('client_id', cid)
        .ilike('email', email).is('deleted_at', null).limit(1).maybeSingle();
      existingId = (r.data?.id as string) ?? null;
    }

    if (existingId) {
      if (body.on_duplicate === 'skip') { skipped++; continue; }
      await supabaseAdmin.from('people_directory').update({
        first_name, last_name, mobile, email, address, type: personType, city,
        updated_at: new Date().toISOString(),
        updated_by: userId(req) ?? null,
      }).eq('id', existingId);
      updated++;
    } else {
      await supabaseAdmin.from('people_directory').insert({
        org_id, client_id: cid,
        first_name, last_name, mobile, email, address, type: personType, city,
        created_by: userId(req) ?? null,
      });
      added++;
    }
  }
  res.json({ added, updated, skipped, total: body.rows.length });
}));

// CSV export — same client + soft-delete scope as the list endpoint, with
// the dashboard's optional ?type=… / ?city=… filter forwarded through. The
// generic list path applies any non-reserved query key as `.eq(...)`, so
// the same filters the FE uses on the list page also narrow the export.
peopleDir.get('/export', wrap(async (req, res) => {
  const scope = clientScope(req);
  const rows = await crud.clientScopedList('people_directory', orgId(req), scope.id, req.query, {
    defaultSort: { column: 'created_at', ascending: false },
    searchColumns: ['first_name', 'last_name', 'mobile', 'email', 'type', 'city'],
    strictClient: true,
  }) as Array<Record<string, unknown>>;
  const esc = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['first_name', 'last_name', 'mobile', 'email', 'type', 'city', 'address', 'created_at'];
  const body = rows.map((r) => header.map((k) => esc(r[k])).join(',')).join('\n');
  const csv = `${header.join(',')}\n${body}\n`;
  const filename = `people-directory-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));
router.use('/people-directory', rbac.requireModuleAccess('crm_settings'), peopleDir);

// People Directory Type catalogue — per (org, client) admin-managed list
// of role labels (Dealer / Engineer / Architect + whatever the tenant
// adds). Shares the same RBAC gate as the directory itself so only roles
// with crm_settings can curate it.
const peopleDirTypes = express.Router();
peopleDirTypes.get('/', wrap(async (req, res) => {
  res.json(await crud.clientScopedList(
    'people_directory_types', orgId(req), clientScope(req).id, req.query,
    {
      defaultSort: { column: 'position', ascending: true },
      searchColumns: ['name'],
      strictClient: true,
    },
  ));
}));
peopleDirTypes.post('/', wrap(async (req, res) => {
  const parsed = parse(v.peopleDirectoryTypeSchema, req.body);
  const cid = clientId(req);
  if (!cid) throw new AppError(400, 'A client must be selected to add a People Directory type', 'CLIENT_REQUIRED');
  // Default position = current max + 1 so new entries land at the end of
  // the dropdown rather than at the top.
  const { data: maxRow } = await supabaseAdmin.from('people_directory_types')
    .select('position').eq('org_id', orgId(req)).eq('client_id', cid).is('deleted_at', null)
    .order('position', { ascending: false }).limit(1).maybeSingle();
  const nextPos = ((maxRow?.position as number | undefined) ?? -1) + 1;
  const payload = { ...parsed, client_id: cid, position: parsed.position ?? nextPos };
  res.status(201).json(await crud.create('people_directory_types', orgId(req), payload, userId(req)));
}));
peopleDirTypes.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('people_directory_types', orgId(req), req.params.id, parse(v.peopleDirectoryTypeSchema.partial(), req.body), userId(req)))));
peopleDirTypes.delete('/:id', wrap(async (req, res) => {
  await crud.softDelete('people_directory_types', orgId(req), req.params.id);
  res.status(204).end();
}));
router.use('/people-directory-types', rbac.requireModuleAccess('crm_settings'), peopleDirTypes);

// Generic lookup search — powers the "linked record" picker for the new
// lookup custom-field type. Takes a target table (allowlisted on the FE
// + here in case the FE forgets), an optional `q` for case-insensitive
// substring search on the display columns, and an optional `filter` query
// param that the lookup field carries (encoded JSON list of conditions
// the admin configured when authoring the lookup field). Returns up to
// 50 rows so the picker dropdown stays responsive.
const LOOKUP_TABLES: Record<string, { search: string[]; display: (r: Record<string, unknown>) => string }> = {
  crm_leads: { search: ['first_name','last_name','email','phone','company'], display: (r) =>
    [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || (r.email as string) || (r.phone as string) || 'Lead' },
  crm_contacts: { search: ['first_name','last_name','email','mobile'], display: (r) =>
    [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || (r.email as string) || (r.mobile as string) || 'Contact' },
  crm_accounts: { search: ['name','domain','industry'], display: (r) => (r.name as string) || 'Account' },
  crm_deals: { search: ['title','name'], display: (r) => (r.title as string) || (r.name as string) || 'Deal' },
  people_directory: { search: ['first_name','last_name','mobile','email'], display: (r) =>
    [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || (r.email as string) || (r.mobile as string) || 'Person' },
};
router.get('/lookup/search', wrap(async (req, res) => {
  const target = String(req.query.target ?? '');
  const meta = LOOKUP_TABLES[target];
  if (!meta) throw new AppError(400, `Unknown lookup target: ${target}`, 'BAD_TARGET');
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const scope = clientScope(req);
  let query = supabaseAdmin.from(target).select('*').eq('org_id', orgId(req));
  // Soft-delete column exists on every lookup-eligible table.
  query = query.is('deleted_at', null);
  // Client scope: tenant-isolated for the real CRM tables, also strict
  // on people_directory.
  if (scope.id) query = query.eq('client_id', scope.id);
  if (q) {
    const sanitized = q.replace(/[%,]/g, ' ').slice(0, 80);
    const orExpr = meta.search.map((c) => `${c}.ilike.%${sanitized}%`).join(',');
    query = query.or(orExpr);
  }
  // Apply the admin-configured filter, if the picker forwards one. Each
  // clause is ANDed; the FE has already converted the clause list to a
  // shape we can iterate directly. UUIDs are not interpolated — values
  // go through supabase-js's parameterised API.
  const filterRaw = typeof req.query.filter === 'string' ? req.query.filter : '';
  if (filterRaw) {
    try {
      const clauses = JSON.parse(filterRaw) as Array<{ field: string; op: string; value: unknown }>;
      for (const c of Array.isArray(clauses) ? clauses : []) {
        if (typeof c.field !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(c.field)) continue;
        switch (c.op) {
          case 'eq':       query = query.eq(c.field, c.value as never); break;
          case 'ne':       query = query.neq(c.field, c.value as never); break;
          case 'contains': query = query.ilike(c.field, `%${String(c.value ?? '').replace(/[%]/g,'')}%`); break;
          case 'gte':      query = query.gte(c.field, c.value as never); break;
          case 'lte':      query = query.lte(c.field, c.value as never); break;
        }
      }
    } catch { /* ignore bad filter JSON, fall through to unfiltered */ }
  }
  const { data, error } = await query.limit(50);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  // Slim down to (id, label) the picker can render directly without
  // every column over the wire.
  const items = (data ?? []).map((r) => ({ id: r.id as string, label: meta.display(r), raw: r }));
  res.json({ success: true, data: items });
}));
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
// crm_settings is now keyed by (org_id, client_id) — one row per client
// in an org, plus an optional org-default row where client_id IS NULL.
// Reads prefer the per-client row and fall back to the org-default so a
// super-admin viewing without a client picker still sees something useful.
async function loadSettingsRow(orgIdValue: string, cid: string | null) {
  if (cid) {
    const own = await supabaseAdmin
      .from('crm_settings').select('*')
      .eq('org_id', orgIdValue).eq('client_id', cid)
      .maybeSingle();
    if (own.data) return own.data;
  }
  const fallback = await supabaseAdmin
    .from('crm_settings').select('*')
    .eq('org_id', orgIdValue).is('client_id', null)
    .maybeSingle();
  return fallback.data ?? null;
}
settings.get('/', wrap(async (req, res) => {
  const cid = clientId(req);
  const row = await loadSettingsRow(orgId(req), cid);
  const base = row ?? { org_id: orgId(req), client_id: cid, config: {}, business_type: 'both' };

  // Per-client overlay for vertical-specific lead-score-boost suggestions.
  // crm_settings is keyed by org and can't distinguish two clients that share
  // an org (e.g. Kinematic vs Tata Tiscon), so the enabled "boost signals"
  // live on clients.settings.score_boost_signals. Resolve them for the scoped
  // client and inject into the returned config — the dashboard reads this to
  // show only the boost items relevant to the current client. Default empty
  // (generic CRM items only) for clients that haven't opted in.
  let scoreBoostSignals: string[] = [];
  if (cid) {
    const { data: client } = await supabaseAdmin.from('clients').select('settings').eq('id', cid).maybeSingle();
    const sig = (client?.settings as Record<string, unknown> | null | undefined)?.score_boost_signals;
    if (Array.isArray(sig)) scoreBoostSignals = sig.map(String);
  }
  const config = { ...((base as { config?: Record<string, unknown> }).config || {}), score_boost_signals: scoreBoostSignals };
  res.json({ ...base, config });
}));
settings.patch('/', wrap(async (req, res) => {
  const body = parse(v.settingsUpdateSchema, req.body);
  const cid = clientId(req);
  // Per-client row: look up by (org_id, client_id). With cid=null we
  // upsert the org-default row. The new UNIQUE(org_id, client_id) NULLS
  // NOT DISTINCT constraint guarantees there's exactly one row per
  // (org, client) so we never collide and never leak across clients.
  let existingQuery = supabaseAdmin.from('crm_settings').select('*').eq('org_id', orgId(req));
  existingQuery = cid ? existingQuery.eq('client_id', cid) : existingQuery.is('client_id', null);
  const { data: existing } = await existingQuery.maybeSingle();
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
router.use('/settings', rbac.requireModuleAccess('crm_settings'), settings);

// ---------- TARGETS (per-FE daily lead targets) ----------------------
// Managers/admins set targets (per FE or "same for all"); every CRM user
// can read their own resolved target + today's achievement for the
// dashboard ticker and the lead-add "1/5" badge. Tenant-scoped via the
// X-Client-Id scope, so Tata Tiscon gets its own targets.
const targets = express.Router();
const MANAGER_ROLES = ['supervisor', 'city_manager', 'sub_admin', 'admin', 'super_admin', 'main_admin', 'client'] as const;

// FE-facing: my target + achievement for today. Any authenticated CRM user.
targets.get('/me', wrap(async (req, res) => {
  const user = (req as AuthRequest).user!;
  res.json(await targetsSvc.myTargetToday(orgId(req), user.id, clientId(req)));
}));

// Manager-facing: the hierarchy "levels" to set targets against — the org's
// custom roles (org_roles), e.g. Tata's Consumer Champion / Area Sales Officer.
targets.get('/levels', requireRole(...MANAGER_ROLES), wrap(async (req, res) => {
  res.json({ success: true, data: await targetsSvc.listTargetRoles(orgId(req), clientId(req)) });
}));

// Leaderboard analytics — leads per user vs target for the window, plus
// top/lowest/average. ?period=today|week|month (default today). Open to any
// authenticated user: managers see the configured role (or whole force), while
// a non-manager (e.g. a Consumer Champion) is locked to their own role so the
// board only ever lists their peers.
targets.get('/leaderboard', wrap(async (req, res) => {
  const u = (req as AuthRequest).user!;
  const p = String(req.query.period ?? 'today');
  const period = (['today', 'week', 'month'].includes(p) ? p : 'today') as targetsSvc.LeaderboardPeriod;
  res.json({ success: true, data: await targetsSvc.targetsLeaderboard(orgId(req), clientId(req), period, {
    org_role_id: (u as any).org_role_id ?? null,
    org_role_data_scope: (u as any).org_role_data_scope ?? null,
  }) });
}));

// Manager-facing: which hierarchy role the leaderboard is scoped to (per client).
targets.get('/leaderboard-role', requireRole(...MANAGER_ROLES), wrap(async (req, res) => {
  res.json({ success: true, data: { role_id: await targetsSvc.getLeaderboardRoleId(orgId(req), clientId(req)) } });
}));
targets.put('/leaderboard-role', requireRole(...MANAGER_ROLES), wrap(async (req, res) => {
  const role_id = (req.body?.role_id ?? null) as string | null;
  res.json({ success: true, data: await targetsSvc.setLeaderboardRoleId(orgId(req), clientId(req), role_id) });
}));

// Manager-facing: list current targets (default + per-FE overrides).
targets.get('/', requireRole(...MANAGER_ROLES), wrap(async (req, res) => {
  res.json(await targetsSvc.listTargets(orgId(req), clientId(req)));
}));

// Manager-facing: set a target. Body { target_value, user_id?,
// hierarchy_level_id? } — user_id = per-FE override, hierarchy_level_id =
// per-level (applies to everyone at that tier), all=true = org-wide default.
targets.put('/', requireRole(...MANAGER_ROLES), wrap(async (req, res) => {
  const { user_id, org_role_id, hierarchy_level_id, target_value, all } = req.body ?? {};
  if (target_value === undefined || target_value === null) throw new AppError(400, 'target_value is required', 'VALIDATION');
  const row = all
    ? await targetsSvc.setAllTargets(orgId(req), clientId(req), Number(target_value), userId(req))
    : await targetsSvc.setTarget(orgId(req), clientId(req), { user_id: user_id ?? null, org_role_id: org_role_id ?? null, hierarchy_level_id: hierarchy_level_id ?? null, target_value: Number(target_value) }, userId(req));
  res.json(row);
}));
router.use('/targets', targets);

// ---------- HIERARCHY (Phase 3 — client-admin org hierarchy) ----------
// Every endpoint here (except /enabled) 404s when the active client
// hasn't opted in to hierarchy RBAC. Tata Tiscon therefore never sees
// this surface — the dashboard hides the menu entry too, but the gate
// is enforced server-side regardless.
const hier = express.Router();
// Cheap probe the dashboard uses to decide whether to render the
// Hierarchy menu entry. Returns { enabled } without throwing, so the
// nav bar render path can stay synchronous.
hier.get('/enabled', wrap(async (req, res) => {
  const enabled = await hierarchy.useHierarchyRbac(req as AuthRequest);
  res.json({ success: true, data: { enabled } });
}));
hier.use(async (req, res, next) => {
  try {
    if (!(await hierarchy.useHierarchyRbac(req as AuthRequest))) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Hierarchy not enabled for this client' } });
    }
    next();
  } catch (e) { next(e); }
});

// List levels for the active client. Includes org-wide rows
// (client_id IS NULL) so a tenant inherits shared scaffolding when
// they exist. Levels are sorted by level_order ascending (1 = top).
hier.get('/levels', wrap(async (req, res) => {
  const cid = clientId(req);
  let q = supabaseAdmin
    .from('org_hierarchy_levels')
    .select('*')
    .eq('org_id', orgId(req))
    .order('level_order', { ascending: true });
  q = cid ? q.or(`client_id.is.null,client_id.eq.${cid}`) : q.is('client_id', null);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data: data ?? [] });
}));

hier.post('/levels', wrap(async (req, res) => {
  const { name, level_order, parent_level_id, capabilities } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
  }
  if (level_order === undefined || level_order === null || Number.isNaN(Number(level_order))) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'level_order is required' } });
  }
  const { data, error } = await supabaseAdmin
    .from('org_hierarchy_levels')
    .insert({
      org_id: orgId(req),
      client_id: clientId(req),
      name: name.trim(),
      level_order: Number(level_order),
      parent_level_id: parent_level_id || null,
      capabilities: capabilities ?? {},
    })
    .select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return res.status(201).json({ success: true, data });
}));

hier.patch('/levels/:id', wrap(async (req, res) => {
  const { name, level_order, parent_level_id, capabilities } = req.body ?? {};
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = String(name).trim();
  if (level_order !== undefined) updates.level_order = Number(level_order);
  if (parent_level_id !== undefined) updates.parent_level_id = parent_level_id || null;
  if (capabilities !== undefined) updates.capabilities = capabilities;
  const { data, error } = await supabaseAdmin
    .from('org_hierarchy_levels')
    .update(updates)
    .eq('id', req.params.id)
    .eq('org_id', orgId(req))
    .select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data });
}));

hier.delete('/levels/:id', wrap(async (req, res) => {
  // Safety: refuse to delete a level that still has users on it. They
  // would silently lose their hierarchy slot and fall back to the
  // role-based path, which we want to be an explicit admin action.
  const { count } = await supabaseAdmin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('hierarchy_level_id', req.params.id);
  if ((count ?? 0) > 0) {
    return res.status(409).json({ success: false, error: { code: 'IN_USE', message: `${count} users are still on this level — reassign them first.` } });
  }
  const { error } = await supabaseAdmin
    .from('org_hierarchy_levels')
    .delete()
    .eq('id', req.params.id)
    .eq('org_id', orgId(req));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.status(204).end();
}));

// Members listing: every user belonging to the active client, joined
// with their hierarchy_level_id + supervisor_id so the page can group
// them by level. The active client filter mirrors clientScopedList:
// when client_id is set we accept rows where users.client_id matches
// OR is null (org-level admins are visible to every client).
hier.get('/members', wrap(async (req, res) => {
  const cid = clientId(req);
  let q = supabaseAdmin
    .from('users')
    .select('id, name, email, role, supervisor_id, hierarchy_level_id, client_id')
    .eq('org_id', orgId(req))
    .order('name', { ascending: true });
  if (cid) q = q.or(`client_id.is.null,client_id.eq.${cid}`);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data: data ?? [] });
}));

hier.patch('/members/:id', wrap(async (req, res) => {
  const { hierarchy_level_id, supervisor_id } = req.body ?? {};
  // Guard against accidentally pointing a user at their own subtree
  // (which would create a cycle in the supervisor chain).
  if (supervisor_id && supervisor_id === req.params.id) {
    return res.status(400).json({ success: false, error: { code: 'CYCLE', message: 'A user cannot be their own supervisor.' } });
  }
  if (supervisor_id) {
    const { data: rpc } = await supabaseAdmin.rpc('user_subtree_ids', { p_user_id: req.params.id });
    const subtree = (rpc ?? []).map((r: any) => r.user_id as string);
    if (subtree.includes(supervisor_id)) {
      return res.status(400).json({ success: false, error: { code: 'CYCLE', message: 'New supervisor is already a direct/indirect report — would create a cycle.' } });
    }
  }
  const updates: Record<string, unknown> = {};
  if (hierarchy_level_id !== undefined) updates.hierarchy_level_id = hierarchy_level_id || null;
  if (supervisor_id !== undefined) updates.supervisor_id = supervisor_id || null;
  const { data, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.params.id)
    .eq('org_id', orgId(req))
    .select('id, name, email, role, supervisor_id, hierarchy_level_id, client_id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data });
}));

router.use('/hierarchy', hier);

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

// Google Places (New) proxy — address autocomplete for the lead forms on
// mobile (and a server-side option for the dashboard). Keyless requests
// return empty so callers fall back to manual entry.
const places = express.Router();
places.get('/autocomplete', wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ success: true, data: await placesSvc.autocomplete(q) });
}));
places.get('/details', wrap(async (req, res) => {
  const id = typeof req.query.place_id === 'string' ? req.query.place_id : '';
  res.json({ success: true, data: await placesSvc.details(id) });
}));
router.use('/places', places);

const activityTypes = express.Router();
const BUILTIN_TYPES = [
  { slug: 'call',     name: 'Call',     icon: '📞' },
  { slug: 'meeting',  name: 'Meeting',  icon: '📅' },
  { slug: 'task',     name: 'Task',     icon: '✅' },
  { slug: 'note',     name: 'Note',     icon: '📝' },
  { slug: 'email',    name: 'Email',    icon: '✉️' },
  { slug: 'sms',      name: 'SMS',      icon: '💬' },
  // No emoji for WhatsApp — the dashboard renders the official brand
  // SVG via <ActivityTypeIcon>. Any emoji here (a heart, a phone, a
  // speech bubble) gets misread as the WhatsApp logo and we've had
  // multiple complaints. Leave this empty; clients that fall back to
  // the emoji column just see "WhatsApp" with no glyph, which is
  // still less wrong than 💚.
  { slug: 'whatsapp', name: 'WhatsApp', icon: '' },
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
router.use('/whatsapp', rbac.requireModuleAccess('crm_whatsapp'), whatsapp);

const imp = express.Router();
imp.post('/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded', 'NO_FILE');
  const out = await importSvc.uploadFile(orgId(req), userId(req), req.file.originalname, req.file.buffer);
  // FE reads `r.data.id` from this response to seed the import job
  // state; without an `id` field the Map → Preview flow silently
  // no-ops (Preview's `if (!job) return` exits without a toast).
  res.status(201).json({
    success: true,
    data: {
      id: out.job_id,
      job_id: out.job_id,
      headers: out.headers,
      sample: out.sample,
      sample_rows: out.sample,
      suggested_mapping: out.suggested_mapping,
      total_rows: out.sample.length,
      status: 'mapping',
    },
  });
}));
imp.post('/preview', wrap(async (req, res) => {
  const body = parse(v.importPreviewSchema, req.body);
  const result = await importSvc.previewJob(orgId(req), body.job_id, body.mapping);
  // FE reads r.data.sample + r.data.job — wrap so the response shape
  // matches every other crud endpoint instead of returning the bare
  // {mapped_sample, warnings} which would TypeError on the client.
  res.json({ success: true, data: result });
}));
imp.post('/commit', wrap(async (req, res) => {
  const body = parse(v.importCommitSchema, req.body);
  // Pass the importing user's client scope through so every imported lead
  // inherits the right client_id. Without this, a super-admin importing
  // while the dashboard's client picker points at a tenant would dump
  // leads as client_id=null and the tenant view wouldn't show them.
  const result = await importSvc.commitJob(orgId(req), body.job_id, userId(req), clientId(req));
  res.json({ success: true, data: result });
}));
imp.get('/jobs/:id', wrap(async (req, res) => {
  const job = await importSvc.getJob(orgId(req), req.params.id);
  res.json({ success: true, data: job });
}));
imp.get('/jobs', wrap(async (req, res) => res.json(await importSvc.listJobs(orgId(req)))));

// Activity bulk import — parallel three-stage flow to leads import
// above. Shares the crm_import_jobs table; rows are tagged with
// kind='activities' so the two never bleed into each other.
imp.post('/activities/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new AppError(400, 'No file uploaded', 'NO_FILE');
  res.status(201).json(await activityImportSvc.uploadFile(orgId(req), userId(req), req.file.originalname, req.file.buffer));
}));
imp.post('/activities/preview', wrap(async (req, res) => {
  const body = parse(v.importPreviewSchema, req.body);
  res.json(await activityImportSvc.previewJob(orgId(req), body.job_id, body.mapping));
}));
imp.post('/activities/commit', wrap(async (req, res) => {
  const body = parse(v.importCommitSchema, req.body);
  res.json(await activityImportSvc.commitJob(orgId(req), body.job_id, userId(req) ?? null));
}));
imp.get('/activities/jobs/:id', wrap(async (req, res) => res.json(await activityImportSvc.getJob(orgId(req), req.params.id))));
imp.get('/activities/jobs', wrap(async (req, res) => res.json(await activityImportSvc.listJobs(orgId(req)))));
router.use('/import', rbac.requireModuleAccess('crm_leads'), imp);

// ---------- ANALYTICS ------------------------------------------------
const analytics = express.Router();
const unitFromReq = (req: Request): 'inr' | 'weight' => req.query.unit === 'weight' ? 'weight' : 'inr';
const ANALYTICS_TTL = 60;
const cacheKey = (req: Request, name: string) => {
  const r = dateRange(req);
  // The per-user scope signature is part of the key so a scoped result is
  // never served to a different user from cache.
  const sig = analyticsSvc.analyticsScopeSig((req as AuthRequest).analyticsScope);
  return `crm:an:${name}:${orgId(req)}:${clientId(req) ?? 'org'}:${unitFromReq(req)}:${r.from ?? ''}:${r.to ?? ''}:${req.query.pipeline_id ?? ''}:${req.query.by ?? ''}:${req.query.period ?? ''}:${req.query.days ?? ''}:${sig}`;
};
const { cached: cachedAnalytics } = require('../utils/analyticsCache') as typeof import('../utils/analyticsCache');

// Per-user analytics scope — identical to the leads/deals list endpoints so
// the dashboard shows each user only their slice (assigned city + role
// hierarchy). null fields = no extra restriction (admins see everything).
async function analyticsScope(req: Request): Promise<analyticsSvc.AnalyticsScope> {
  const me = (req as AuthRequest).user;
  const effectiveCities = rbac.getEffectiveCityNames(me);
  const selfOwnerId = me?.id ?? null;
  let visibleOwnerIds: string[] | null = null;
  const hierOn = await hierarchy.useHierarchyRbac(req as AuthRequest);
  if (hierOn) {
    visibleOwnerIds = await hierarchy.subtreeUserIds(req as AuthRequest);
  }
  // City-less leads (most of the book) are scoped by owner/hierarchy, not
  // geo — include them for tenant-wide admins and whenever hierarchy RBAC
  // bounds exposure, so dashboard/analytics/map counts match the leads list.
  const includeNullCity = (me?.org_role_data_scope ?? 'all') === 'all' || hierOn;
  return { effectiveCities, visibleOwnerIds, selfOwnerId, includeNullCity };
}
// The scope signature MUST be part of the cache key, otherwise one user's
// scoped dashboard would be served to another from the cache.
// Compute the caller's analytics scope once per request and stash it on req
// so cacheKey + every handler below share it without re-querying.
analytics.use((req, _res, next) => {
  analyticsScope(req).then((sc) => { (req as AuthRequest).analyticsScope = sc; next(); }).catch(next);
});
analytics.get('/dashboard-summary', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'dashboard-summary'), ANALYTICS_TTL,
    () => analyticsSvc.dashboardSummary(orgId(req), dateRange(req), clientId(req), unitFromReq(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/dashboard-complete', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'dashboard-complete'), ANALYTICS_TTL,
    () => analyticsSvc.dashboardComplete(orgId(req), dateRange(req), clientId(req), unitFromReq(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/pipeline-value', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'pipeline-value'), ANALYTICS_TTL,
    () => analyticsSvc.pipelineValue(orgId(req), req.query.pipeline_id as string | undefined, clientId(req), unitFromReq(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/funnel', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'funnel'), ANALYTICS_TTL,
    () => analyticsSvc.funnel(orgId(req), Number(req.query.days ?? 30), dateRange(req), clientId(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/win-rate', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'win-rate'), ANALYTICS_TTL,
    () => analyticsSvc.winRate(orgId(req), (req.query.by as 'rep'|'source'|'stage') ?? 'rep', dateRange(req), clientId(req), (req as AuthRequest).analyticsScope)))));
// Team Performance — per-rep KPI roll-up across the caller's hierarchy
// subtree. Surfaces won volume, conversion rate, lead ageing, and new
// leads this period as one consolidated report for managers.
analytics.get('/team-performance', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'team-performance'), ANALYTICS_TTL,
    () => analyticsSvc.teamPerformance(orgId(req), dateRange(req), clientId(req), (req as AuthRequest).analyticsScope)))));
// Lead Tracker — monthly new-lead counts (default 6 months) + today /
// week / month summary roll-ups for the caller's subtree. Drives the
// bar-chart report and the period cards underneath it.
analytics.get('/lead-tracker', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-tracker'), ANALYTICS_TTL,
    () => analyticsSvc.leadTracker(orgId(req), Number(req.query.months ?? 6), clientId(req), (req as AuthRequest).analyticsScope)))));
// Team Daily Activity — one card per rep in the subtree for a given
// calendar day. Attendance check-in (time + location), today's visits
// achieved vs scheduled, and leads added.
analytics.get('/team-daily', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'team-daily'), ANALYTICS_TTL,
    () => analyticsSvc.teamDaily(orgId(req), String(req.query.date ?? ''), clientId(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/sales-cycle', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'sales-cycle'), ANALYTICS_TTL,
    () => analyticsSvc.salesCycle(orgId(req), dateRange(req), clientId(req))))));
analytics.get('/forecast', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'forecast'), ANALYTICS_TTL,
    () => analyticsSvc.forecast(orgId(req), (req.query.period as 'month'|'quarter') ?? 'quarter', dateRange(req), clientId(req), unitFromReq(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/activity-heatmap', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'activity-heatmap'), ANALYTICS_TTL,
    () => analyticsSvc.activityHeatmap(orgId(req), clientId(req))))));
analytics.get('/lead-source-roi', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-source-roi'), ANALYTICS_TTL,
    () => analyticsSvc.leadSourceRoi(orgId(req), clientId(req))))));
analytics.get('/lead-score-distribution', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-score-distribution'), ANALYTICS_TTL,
    () => analyticsSvc.leadScoreDistribution(orgId(req), dateRange(req), clientId(req), (req as AuthRequest).analyticsScope)))));
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
    () => analyticsExt.leadVelocity(orgId(req), clientId(req), Number(req.query.months ?? 6), (req as AuthRequest).analyticsScope)))));
analytics.get('/time-to-first-touch', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'time-to-first-touch'), ANALYTICS_TTL,
    () => analyticsExt.timeToFirstTouch(orgId(req), clientId(req), dateRange(req), Number(req.query.sla_minutes ?? 60), (req as AuthRequest).analyticsScope)))));
analytics.get('/stuck-leads', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'stuck-leads'), ANALYTICS_TTL,
    () => analyticsExt.stuckLeads(orgId(req), clientId(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/lost-reasons', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lost-reasons'), ANALYTICS_TTL,
    () => analyticsExt.lostReasons(orgId(req), clientId(req), dateRange(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/won-reasons', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'won-reasons'), ANALYTICS_TTL,
    () => analyticsExt.wonReasons(orgId(req), clientId(req), dateRange(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/disqualification-reasons', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'disqualification-reasons'), ANALYTICS_TTL,
    () => analyticsExt.disqualificationReasons(orgId(req), clientId(req), dateRange(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/stage-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'stage-conversion'), ANALYTICS_TTL,
    () => analyticsExt.stageConversion(orgId(req), req.query.pipeline_id as string | undefined, clientId(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/lead-aging', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'lead-aging'), ANALYTICS_TTL,
    () => analyticsExt.leadAging(orgId(req), clientId(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/cohort-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'cohort-conversion'), ANALYTICS_TTL,
    () => analyticsExt.cohortConversion(orgId(req), clientId(req), Number(req.query.months ?? 6), (req as AuthRequest).analyticsScope)))));
analytics.get('/engagement-comparison', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'engagement-comparison'), ANALYTICS_TTL,
    () => analyticsExt.engagementComparison(orgId(req), clientId(req), dateRange(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/days-since-touch', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'days-since-touch'), ANALYTICS_TTL,
    () => analyticsExt.daysSinceTouch(orgId(req), clientId(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/score-band-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'score-band-conversion'), ANALYTICS_TTL,
    () => analyticsExt.scoreBandConversion(orgId(req), clientId(req), dateRange(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/territory-conversion', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'territory-conversion'), ANALYTICS_TTL,
    () => analyticsExt.territoryConversion(orgId(req), clientId(req), dateRange(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/touchpoints-to-response', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'touchpoints-to-response'), ANALYTICS_TTL,
    () => analyticsExt.touchpointsToResponse(orgId(req), clientId(req), dateRange(req), (req as AuthRequest).analyticsScope)))));
analytics.get('/leads-at-risk', wrap(async (req, res) => res.json(
  await cachedAnalytics(cacheKey(req, 'leads-at-risk'), ANALYTICS_TTL,
    () => analyticsExt.leadsAtRisk(orgId(req), clientId(req), Number(req.query.score ?? 60), Number(req.query.idle_days ?? 14), (req as AuthRequest).analyticsScope)))));
router.use('/analytics', rbac.requireModuleAccess('crm_lead_analytics'), analytics);

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
ai.post('/draft-email-template', wrap(async (req, res) => {
  const g = await gateAi(req, res); if (!g.proceed) return;
  const body = parse(v.draftEmailTemplateSchema, req.body);
  const out = await autoRespSvc.draftEmailTemplate({
    org_id: orgId(req),
    goal: body.goal!,
    tone: body.tone,
    audience: body.audience,
    language: body.language,
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
    // Guard against empty reply when the last turn was tool-use-only: prefer
    // a card summary over a blank bubble, then a safe fallback as last resort.
    const replyText = out.reply
      || (out.tool_calls?.length ? 'Done — see the results above.' : "I couldn't generate a response for that. Could you rephrase?");
    res.json({ success: true, data: { text: replyText, cards: out.cards, tool_calls: out.tool_calls, usage: after } });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    const msg = (e as { message?: string })?.message ?? '';
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
    // All other errors (Anthropic API errors, network failures, tool crashes,
    // etc.) must NOT re-throw — the outer CRM error handler returns a plain
    // { success: false } envelope with no data.text, which the dashboard and
    // mobile clients interpret as the generic "I apologize" fallback. Return
    // a 200 with a user-facing message so the chat stays alive.
    console.error('[kini.chat] unexpected error:', msg, e);
    res.json({
      success: true,
      data: {
        text: "I ran into a problem on my end — please try again. If this keeps happening, the team has been notified.",
        cards: [],
        tool_calls: [],
      },
    });
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

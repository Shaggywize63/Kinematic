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

import * as v from '../validators/crm.validators';
import * as crud from '../services/crm/crud.service';
import * as leadsSvc from '../services/crm/leads.service';
import * as dealsSvc from '../services/crm/deals.service';
import * as importSvc from '../services/crm/import.service';
import * as analyticsSvc from '../services/crm/analytics.service';
import * as emailsSvc from '../services/crm/emails.service';
import * as nbaSvc from '../services/crm/ai/nextBestAction.service';
import * as winSvc from '../services/crm/ai/winProbability.service';
import * as autoRespSvc from '../services/crm/ai/autoResponse.service';
import * as summarizeSvc from '../services/crm/ai/summarize.service';
import * as kiniTools from '../services/crm/ai/kiniTools.service';
import { chatWithTools } from '../services/crm/ai/aiClient';

const router: Router = express.Router();
router.use(requireAuth, requireModule('crm'));

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
// Generic over the schema type so z.infer<T> preserves required-vs-optional fields.
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
leads.get('/', wrap(async (req, res) => res.json(await leadsSvc.listLeads(orgId(req), req.query))));
leads.post('/', wrap(async (req, res) => res.status(201).json(await leadsSvc.createLead({
  org_id: orgId(req), user_id: userId(req), payload: parse(v.leadCreateSchema, req.body) }))));
leads.get('/:id', wrap(async (req, res) => res.json(await leadsSvc.getLead(orgId(req), req.params.id))));
leads.patch('/:id', wrap(async (req, res) =>
  res.json(await leadsSvc.updateLead(orgId(req), req.params.id, parse(v.leadUpdateSchema, req.body), userId(req)))));
leads.delete('/:id', wrap(async (req, res) => { await leadsSvc.deleteLead(orgId(req), req.params.id); res.status(204).end(); }));
leads.post('/:id/score', wrap(async (req, res) => res.json(await leadsSvc.rescoreLead(orgId(req), req.params.id))));
leads.post('/:id/convert', wrap(async (req, res) =>
  res.json(await leadsSvc.convertLead(orgId(req), req.params.id, parse(v.leadConvertSchema, req.body), userId(req)))));
leads.get('/:id/score-history', wrap(async (req, res) => res.json(await leadsSvc.listScoreHistory(orgId(req), req.params.id))));
leads.get('/:id/activities', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { lead_id: req.params.id, ...req.query }, { defaultSort: { column: 'completed_at', ascending: false } })
)));
leads.post('/bulk-assign', wrap(async (req, res) => {
  const body = parse(z.object({ lead_ids: z.array(z.string().uuid()), owner_id: z.string().uuid() }), req.body);
  res.json(await leadsSvc.bulkAssign(orgId(req), body.lead_ids, body.owner_id, userId(req)));
}));
router.use('/leads', leads);

// ---------- CONTACTS -------------------------------------------------
const contacts = express.Router();
const contactOpts = { searchColumns: ['first_name','last_name','email','phone'] };
contacts.get('/', wrap(async (req, res) => res.json(await crud.list('crm_contacts', orgId(req), req.query, contactOpts))));
contacts.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_contacts', orgId(req), parse(v.contactSchema, req.body), userId(req)))));
contacts.get('/:id', wrap(async (req, res) => res.json(await crud.get('crm_contacts', orgId(req), req.params.id))));
contacts.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_contacts', orgId(req), req.params.id, parse(v.contactSchema.partial(), req.body), userId(req)))));
contacts.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_contacts', orgId(req), req.params.id); res.status(204).end(); }));
contacts.get('/:id/activities', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { contact_id: req.params.id, ...req.query })
)));
router.use('/contacts', contacts);

// ---------- ACCOUNTS -------------------------------------------------
const accounts = express.Router();
accounts.get('/', wrap(async (req, res) => res.json(await crud.list('crm_accounts', orgId(req), req.query, { searchColumns: ['name','domain','industry'] }))));
accounts.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_accounts', orgId(req), parse(v.accountSchema, req.body), userId(req)))));
accounts.get('/:id', wrap(async (req, res) => res.json(await crud.get('crm_accounts', orgId(req), req.params.id))));
accounts.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_accounts', orgId(req), req.params.id, parse(v.accountSchema.partial(), req.body), userId(req)))));
accounts.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_accounts', orgId(req), req.params.id); res.status(204).end(); }));
accounts.get('/:id/contacts', wrap(async (req, res) => res.json(
  await crud.list('crm_contacts', orgId(req), { account_id: req.params.id, ...req.query })
)));
accounts.get('/:id/deals', wrap(async (req, res) => res.json(
  await crud.list('crm_deals', orgId(req), { account_id: req.params.id, ...req.query })
)));
accounts.get('/:id/activities', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { account_id: req.params.id, ...req.query })
)));
accounts.post('/:id/summarize', wrap(async (req, res) =>
  res.json({ text: await summarizeSvc.summarizeAccount(orgId(req), req.params.id) })));
router.use('/accounts', accounts);

// ---------- DEALS ----------------------------------------------------
const deals = express.Router();
deals.get('/', wrap(async (req, res) => res.json(await dealsSvc.listDeals(orgId(req), req.query))));
deals.post('/', wrap(async (req, res) =>
  res.status(201).json(await dealsSvc.createDeal(orgId(req), parse(v.dealSchema, req.body), userId(req)))));
deals.get('/:id', wrap(async (req, res) => res.json(await dealsSvc.getDeal(orgId(req), req.params.id))));
deals.patch('/:id', wrap(async (req, res) =>
  res.json(await dealsSvc.updateDeal(orgId(req), req.params.id, parse(v.dealUpdateSchema, req.body), userId(req)))));
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
  await crud.list('crm_activities', orgId(req), { deal_id: req.params.id, ...req.query })
)));
router.use('/deals', deals);

// ---------- PIPELINES + STAGES --------------------------------------
const pipelines = express.Router();
pipelines.get('/', wrap(async (req, res) => res.json(await crud.list('crm_pipelines', orgId(req), req.query, { defaultSort: { column: 'created_at', ascending: true } }))));
pipelines.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_pipelines', orgId(req), parse(v.pipelineSchema, req.body), userId(req)))));
pipelines.get('/:id', wrap(async (req, res) => res.json(await crud.get('crm_pipelines', orgId(req), req.params.id))));
pipelines.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_pipelines', orgId(req), req.params.id, parse(v.pipelineSchema.partial(), req.body), userId(req)))));
pipelines.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_pipelines', orgId(req), req.params.id); res.status(204).end(); }));
pipelines.get('/:id/stages', wrap(async (req, res) => res.json(
  await crud.list('crm_deal_stages', orgId(req), { pipeline_id: req.params.id }, { softDelete: false, defaultSort: { column: 'position', ascending: true } })
)));
router.use('/pipelines', pipelines);

const stages = express.Router();
stages.get('/', wrap(async (req, res) => res.json(await crud.list('crm_deal_stages', orgId(req), req.query, { softDelete: false, defaultSort: { column: 'position', ascending: true } }))));
stages.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_deal_stages', orgId(req), parse(v.stageSchema, req.body)))));
stages.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_deal_stages', orgId(req), req.params.id, parse(v.stageSchema.partial(), req.body)))));
stages.delete('/:id', wrap(async (req, res) => { await crud.hardDelete('crm_deal_stages', orgId(req), req.params.id); res.status(204).end(); }));
stages.post('/reorder', wrap(async (req, res) => {
  const body = parse(v.reorderStagesSchema, req.body);
  await Promise.all(body.stages.map(s => supabaseAdmin.from('crm_deal_stages')
    .update({ position: s.position }).eq('id', s.id).eq('org_id', orgId(req))));
  res.json({ ok: true });
}));
router.use('/stages', stages);

// ---------- ACTIVITIES + NOTES + TASKS ------------------------------
const activities = express.Router();
activities.get('/calendar', wrap(async (req, res) => {
  const from = String(req.query.from ?? new Date(Date.now() - 7 * 86400000).toISOString());
  const to = String(req.query.to ?? new Date(Date.now() + 30 * 86400000).toISOString());
  const { data } = await supabaseAdmin.from('crm_activities').select('*')
    .eq('org_id', orgId(req)).is('deleted_at', null).gte('due_at', from).lte('due_at', to)
    .order('due_at', { ascending: true });
  res.json(data ?? []);
}));
activities.get('/', wrap(async (req, res) => res.json(await crud.list('crm_activities', orgId(req), req.query, { defaultSort: { column: 'completed_at', ascending: false }, searchColumns: ['subject','body'] }))));
activities.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_activities', orgId(req), parse(v.activitySchema, req.body), userId(req)))));
activities.get('/:id', wrap(async (req, res) => res.json(await crud.get('crm_activities', orgId(req), req.params.id))));
activities.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_activities', orgId(req), req.params.id, parse(v.activitySchema.partial(), req.body), userId(req)))));
activities.delete('/:id', wrap(async (req, res) => { await crud.softDelete('crm_activities', orgId(req), req.params.id); res.status(204).end(); }));
router.use('/activities', activities);

const notes = express.Router();
notes.get('/', wrap(async (req, res) => res.json(await crud.list('crm_notes', orgId(req), req.query, { softDelete: false }))));
notes.post('/', wrap(async (req, res) =>
  res.status(201).json(await crud.create('crm_notes', orgId(req), parse(v.noteSchema, req.body), userId(req)))));
notes.patch('/:id', wrap(async (req, res) =>
  res.json(await crud.update('crm_notes', orgId(req), req.params.id, parse(v.noteSchema.partial(), req.body), userId(req)))));
notes.delete('/:id', wrap(async (req, res) => { await crud.hardDelete('crm_notes', orgId(req), req.params.id); res.status(204).end(); }));
router.use('/notes', notes);

const tasks = express.Router();
tasks.get('/', wrap(async (req, res) => res.json(
  await crud.list('crm_activities', orgId(req), { type: 'task', ...req.query }, { defaultSort: { column: 'due_at', ascending: true } })
)));
router.use('/tasks', tasks);

// ---------- SOURCES + RULES + TERRITORIES + CAMPAIGNS + AUTOMATIONS + CUSTOM FIELDS + TEMPLATES
function attach(path: string, table: string, schema: z.ZodObject<z.ZodRawShape>, opts: Partial<crud.CrudOpts> = {}) {
  const r = express.Router();
  r.get('/', wrap(async (req, res) => res.json(await crud.list(table, orgId(req), req.query, opts))));
  r.post('/', wrap(async (req, res) => res.status(201).json(await crud.create(table, orgId(req), parse(schema, req.body), userId(req)))));
  r.get('/:id', wrap(async (req, res) => res.json(await crud.get(table, orgId(req), req.params.id, opts.softDelete !== false))));
  r.patch('/:id', wrap(async (req, res) => res.json(await crud.update(table, orgId(req), req.params.id, parse(schema.partial(), req.body), userId(req)))));
  r.delete('/:id', wrap(async (req, res) => {
    if (opts.softDelete === false) await crud.hardDelete(table, orgId(req), req.params.id);
    else await crud.softDelete(table, orgId(req), req.params.id);
    res.status(204).end();
  }));
  router.use(path, r);
}
attach('/lead-sources', 'crm_lead_sources', v.leadSourceSchema, { softDelete: false });
attach('/assignment-rules', 'crm_lead_assignment_rules', v.assignmentRuleSchema, { softDelete: false });
attach('/territories', 'crm_territories', v.territorySchema, { softDelete: false });
attach('/campaigns', 'crm_campaigns', v.campaignSchema, { softDelete: false });
attach('/automations', 'crm_workflow_automations', v.automationSchema, { softDelete: false });
attach('/custom-fields', 'crm_custom_field_defs', v.customFieldSchema, { softDelete: false });
attach('/email-templates', 'crm_email_templates', v.emailTemplateSchema, { softDelete: false });

// ---------- SETTINGS -------------------------------------------------
const settings = express.Router();
settings.get('/', wrap(async (req, res) => {
  const { data } = await supabaseAdmin.from('crm_settings').select('*').eq('org_id', orgId(req)).maybeSingle();
  res.json(data ?? { org_id: orgId(req), config: {} });
}));
settings.patch('/', wrap(async (req, res) => {
  const body = parse(z.object({ config: z.record(z.unknown()) }), req.body);
  const { data } = await supabaseAdmin.from('crm_settings').upsert({ org_id: orgId(req), config: body.config }, { onConflict: 'org_id' }).select('*').single();
  res.json(data);
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
  res.status(201).json(await emailsSvc.sendEmail({ ...body, org_id: orgId(req), user_id: userId(req) }));
}));
emails.get('/', wrap(async (req, res) => res.json(await emailsSvc.listLogs(orgId(req), req.query))));
// Tracking endpoints — public (no auth) by design. Token is the auth.
router.get('/emails/track/open/:token', async (req, res) => {
  await emailsSvc.recordOpen(req.params.token).catch(() => {});
  res.set('Content-Type', 'image/gif');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});
router.get('/emails/track/click/:token', async (req, res) => {
  await emailsSvc.recordClick(req.params.token).catch(() => {});
  res.redirect(302, String(req.query.u ?? '/'));
});
router.use('/emails', emails);

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
analytics.get('/dashboard-summary', wrap(async (req, res) => res.json(await analyticsSvc.dashboardSummary(orgId(req)))));
analytics.get('/pipeline-value', wrap(async (req, res) => res.json(await analyticsSvc.pipelineValue(orgId(req), req.query.pipeline_id as string | undefined))));
analytics.get('/funnel', wrap(async (req, res) => res.json(await analyticsSvc.funnel(orgId(req), Number(req.query.days ?? 30)))));
analytics.get('/win-rate', wrap(async (req, res) => res.json(await analyticsSvc.winRate(orgId(req), (req.query.by as 'rep'|'source'|'stage') ?? 'rep'))));
analytics.get('/sales-cycle', wrap(async (req, res) => res.json(await analyticsSvc.salesCycle(orgId(req)))));
analytics.get('/forecast', wrap(async (req, res) => res.json(await analyticsSvc.forecast(orgId(req), (req.query.period as 'month'|'quarter') ?? 'quarter'))));
analytics.get('/activity-heatmap', wrap(async (req, res) => res.json(await analyticsSvc.activityHeatmap(orgId(req)))));
analytics.get('/lead-source-roi', wrap(async (req, res) => res.json(await analyticsSvc.leadSourceRoi(orgId(req)))));
analytics.get('/lead-score-distribution', wrap(async (req, res) => res.json(await analyticsSvc.leadScoreDistribution(orgId(req)))));
router.use('/analytics', analytics);

// ---------- AI -------------------------------------------------------
const ai = express.Router();
ai.post('/score-lead/:id', wrap(async (req, res) => res.json(await leadsSvc.rescoreLead(orgId(req), req.params.id))));
ai.post('/draft-reply', wrap(async (req, res) => {
  const body = parse(v.draftReplySchema, req.body);
  res.json(await autoRespSvc.draftReply({ ...body, org_id: orgId(req), user_id: userId(req) }));
}));
ai.post('/next-best-action/:dealId', wrap(async (req, res) => res.json(await nbaSvc.compute(orgId(req), req.params.dealId, true))));
ai.post('/win-probability/:dealId', wrap(async (req, res) => res.json(await winSvc.compute(orgId(req), req.params.dealId))));
ai.post('/summarize/account/:id', wrap(async (req, res) => res.json({ text: await summarizeSvc.summarizeAccount(orgId(req), req.params.id) })));
ai.post('/summarize/deal/:id', wrap(async (req, res) => res.json({ text: await summarizeSvc.summarizeDeal(orgId(req), req.params.id) })));
ai.get('/tools', (_req, res) => res.json(kiniTools.toAnthropicTools()));
ai.post('/tools/execute', wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string(), args: z.record(z.unknown()) }), req.body);
  const result = await kiniTools.executeTool(orgId(req), body.name, body.args);
  if (!result) throw new AppError(404, `Tool ${body.name} not registered`, 'UNKNOWN_TOOL');
  res.json(result);
}));
// CRM-flavored chat: registers tools then runs the tool-use loop.
ai.post('/chat', wrap(async (req, res) => {
  const body = parse(z.object({
    message: z.string().min(1),
    history: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string() })).optional(),
    context: z.object({
      route: z.string().optional(),
      entity: z.object({ type: z.string().optional(), id: z.string().optional() }).optional(),
    }).optional(),
  }), req.body);

  const tools = kiniTools.toAnthropicTools();
  const systemPrompt = `You are KINI, the Kinematic CRM AI assistant. You help sales reps close deals.
You have CRM tools available. Use them to fetch real data — never invent leads, deals, or numbers.
When relevant, return cards via tool results so the UI can render them.
Current route: ${body.context?.route ?? 'unknown'}.
Current entity: ${JSON.stringify(body.context?.entity ?? {})}.`;

  const out = await chatWithTools({
    org_id: orgId(req),
    system: systemPrompt,
    tools,
    messages: [
      ...(body.history ?? []).map(m => ({ role: m.role, content: m.content as unknown })),
      { role: 'user' as const, content: body.message as unknown },
    ],
    onToolCall: async (name, args) => kiniTools.executeTool(orgId(req), name, args as Record<string, unknown>),
    max_tokens: 1500,
  });

  res.json(out);
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

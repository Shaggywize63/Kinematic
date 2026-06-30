/**
 * Automation engine — event-driven only (no cron worker yet).
 *
 * Wiring model:
 *   1. Lead / deal services call `fireForTrigger(trigger, context)` after
 *      a state change (lead created, status flipped, deal won, etc.). The
 *      call is fire-and-forget — errors are logged and never propagate
 *      back to the caller, so a misconfigured automation can't 500 a CRUD
 *      operation.
 *   2. `fireForTrigger` queries `crm_automations` for active rows in the
 *      same org with matching `trigger_type`, evaluates each row's
 *      `trigger_config.conditions`, executes the row's single
 *      `action_type` if conditions pass, and bumps `run_count` +
 *      `last_run_at`.
 *
 * DB shape (per the existing crm_automations schema):
 *   - One action per automation row (action_type + action_config). For a
 *     "do A and B and C" rule, create three rows with the same trigger.
 *   - Conditions live inside trigger_config.conditions to avoid a schema
 *     change; format: [{ field, op, value }].
 *
 * Action types supported in this initial pass:
 *   - create_task       — open task assigned to lead owner or fixed user
 *   - create_activity   — note / call / email log
 *   - update_lead       — patch status / lifecycle_stage / tags / owner
 *   - send_notification — best-effort row in `notifications` (no-op if
 *                         the table doesn't exist in this tenant)
 *
 * Time-based triggers (e.g. "if stuck for 7 days") require a cron worker
 * and are out of scope for this PR — they'll wrap the same engine via a
 * scheduled job that synthesises the trigger context.
 */
import { supabaseAdmin } from '../../lib/supabase';

// ── Types ───────────────────────────────────────────────────

export type TriggerType =
  | 'lead_created'
  | 'lead_status_changed'
  | 'lead_lifecycle_stage_changed'
  | 'lead_owner_changed'
  | 'lead_disqualified'
  | 'lead_converted'
  | 'deal_created'
  | 'deal_stage_changed'
  | 'deal_won'
  | 'deal_lost'
  | 'activity_created'
  | 'activity_completed'
  // Time-based — fired by runScheduledAutomations(), config in trigger_config.days
  | 'lead_idle'
  | 'deal_stalled'
  | 'task_overdue';

export type ActionType =
  | 'create_task'
  | 'create_activity'
  | 'update_lead'
  | 'update_deal'
  | 'send_notification'
  | 'send_email'
  | 'send_whatsapp'
  | 'assign_owner'
  | 'convert_lead';

export type EntityKind = 'lead' | 'deal' | 'contact' | 'account';

/**
 * `data` carries the entity row plus any change-specific fields (before,
 * after, old_status, new_status, …). Action templates reference these via
 * `{{lead.email}}` / `{{old_status}}` / `{{after.score}}` etc.
 */
export interface AutomationContext {
  org_id: string;
  user_id?: string;
  entity: EntityKind;
  entity_id: string;
  data: Record<string, unknown>;
}

interface Condition {
  field: string;
  op: '=' | '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'contains' | 'exists';
  value: unknown;
}

interface AutomationRow {
  id: string;
  org_id: string;
  client_id: string | null;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown> | null;
  action_type: string;
  action_config: Record<string, unknown> | null;
  is_active: boolean;
  run_count: number | null;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Fire all matching automations for a trigger. Never throws — caller is
 * expected to invoke as `fireForTrigger(...).catch(() => {})`.
 *
 * Returns the count of actually-fired automations (excluding rows whose
 * conditions failed, which counts as a no-op skip).
 */
export async function fireForTrigger(
  trigger_type: TriggerType,
  context: AutomationContext,
): Promise<{ fired: number; matched: number }> {
  let q = supabaseAdmin.from('crm_automations').select('*')
    .eq('org_id', context.org_id)
    .eq('trigger_type', trigger_type)
    .eq('is_active', true);
  // Client scoping: if the entity is stamped with a client_id, only fire
  // automations that are either client-agnostic (NULL) or for the same
  // client. Prevents tenant A's automations from running on tenant B's
  // shared-org leads.
  const ctxClientId = (context.data as Record<string, unknown>)?.client_id
    ?? ((context.data as Record<string, unknown>)?.lead as Record<string, unknown> | undefined)?.client_id
    ?? null;
  if (ctxClientId) {
    q = q.or(`client_id.is.null,client_id.eq.${String(ctxClientId)}`);
  }

  const { data: rows, error } = await q;
  if (error || !rows || rows.length === 0) return { fired: 0, matched: 0 };

  const automations = rows as AutomationRow[];
  let fired = 0;

  for (const automation of automations) {
    try {
      const conditions = readConditions(automation.trigger_config);
      if (!evaluateConditions(conditions, context)) continue;

      await executeAction(automation, context);
      fired++;

      await supabaseAdmin.from('crm_automations')
        .update({
          run_count: (automation.run_count ?? 0) + 1,
          last_run_at: new Date().toISOString(),
        })
        .eq('id', automation.id);
    } catch (err) {
      // Swallow — never let an automation failure block the caller. Log
      // with enough context to debug later.
      console.error(
        `[automation] ${automation.id} (${automation.name}) failed for trigger ${trigger_type}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { fired, matched: automations.length };
}

// ── Condition evaluation ────────────────────────────────────

function readConditions(trigger_config: Record<string, unknown> | null): Condition[] {
  if (!trigger_config) return [];
  const raw = (trigger_config as Record<string, unknown>).conditions;
  if (!Array.isArray(raw)) return [];
  return raw as Condition[];
}

function evaluateConditions(conditions: Condition[], context: AutomationContext): boolean {
  // No conditions = always fire. Matches HubSpot's "any" behaviour for
  // workflow enrolments without filters.
  if (conditions.length === 0) return true;
  return conditions.every((cond) => evaluateCondition(cond, context));
}

function evaluateCondition(cond: Condition, context: AutomationContext): boolean {
  const left = getPath(context.data, cond.field);
  return compare(left, cond.op, cond.value);
}

function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function compare(left: unknown, op: Condition['op'], right: unknown): boolean {
  switch (op) {
    case '=':
    case '==':       return left == right; // eslint-disable-line eqeqeq
    case '!=':       return left != right; // eslint-disable-line eqeqeq
    case '>':        return (left as number) >  (right as number);
    case '>=':       return (left as number) >= (right as number);
    case '<':        return (left as number) <  (right as number);
    case '<=':       return (left as number) <= (right as number);
    case 'in':       return Array.isArray(right) && right.includes(left);
    case 'contains': return typeof left === 'string' && typeof right === 'string' && left.includes(right);
    case 'exists':   return left !== null && left !== undefined && left !== '';
    default:         return false;
  }
}

// ── Action execution ────────────────────────────────────────

async function executeAction(automation: AutomationRow, context: AutomationContext) {
  const cfg = (automation.action_config ?? {}) as Record<string, unknown>;
  switch (automation.action_type as ActionType) {
    case 'create_task':       return createTaskAction(cfg, context);
    case 'create_activity':   return createActivityAction(cfg, context);
    case 'update_lead':       return updateLeadAction(cfg, context);
    case 'update_deal':       return updateDealAction(cfg, context);
    case 'send_notification': return sendNotificationAction(cfg, context);
    case 'send_email':        return sendEmailAction(cfg, context);
    case 'send_whatsapp':     return sendWhatsappAction(cfg, context);
    case 'assign_owner':      return assignOwnerAction(cfg, context);
    case 'convert_lead':      return convertLeadAction(cfg, context);
    default:
      console.warn(`[automation] ${automation.id} unknown action_type=${automation.action_type}`);
  }
}

async function createTaskAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  const subject = interpolate(String(cfg.subject ?? 'Automated task'), ctx.data);
  const body    = interpolate(String(cfg.body    ?? ''),                ctx.data);
  const due_at  = cfg.due_in_days != null
    ? new Date(Date.now() + Number(cfg.due_in_days) * 86_400_000).toISOString()
    : (cfg.due_at as string | null | undefined) ?? null;
  const owner_id = resolveOwner(cfg.assign_to, ctx);

  const row: Record<string, unknown> = {
    org_id: ctx.org_id,
    subject,
    description: body,
    status: 'open',
    priority: cfg.priority ?? 'normal',
    due_at,
    owner_id,
    assigned_to: owner_id,
    created_by: ctx.user_id ?? null,
  };
  // Bind the task to whichever entity fired the trigger.
  row[`${ctx.entity}_id`] = ctx.entity_id;

  await supabaseAdmin.from('crm_tasks').insert(row);
}

async function createActivityAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  const subject = interpolate(String(cfg.subject ?? 'Automated activity'), ctx.data);
  const body    = interpolate(String(cfg.body    ?? ''),                   ctx.data);
  const owner_id = resolveOwner(cfg.assign_to, ctx);

  const row: Record<string, unknown> = {
    org_id: ctx.org_id,
    type: cfg.activity_type ?? 'note',
    subject,
    body,
    description: body,
    status: 'completed',
    direction: cfg.direction ?? null,
    owner_id,
    assigned_to: owner_id,
    completed_at: new Date().toISOString(),
    created_by: ctx.user_id ?? null,
  };
  row[`${ctx.entity}_id`] = ctx.entity_id;

  await supabaseAdmin.from('crm_activities').insert(row);
}

async function updateLeadAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  // Guard — only meaningful when the trigger fired on a lead.
  if (ctx.entity !== 'lead') return;

  const updates: Record<string, unknown> = {};
  if (cfg.set_status)          updates.status          = cfg.set_status;
  if (cfg.set_lifecycle_stage) updates.lifecycle_stage = cfg.set_lifecycle_stage;
  if (cfg.set_owner_id)        updates.owner_id        = cfg.set_owner_id;
  if (cfg.set_priority)        updates.priority        = cfg.set_priority;
  if (cfg.set_score_delta != null) {
    // Bump score by a fixed delta; clamp into [0, 100] in the SQL UPDATE.
    // We fetch + recompute in JS rather than a raw SQL expression to keep
    // this path supabase-client friendly.
    const lead = ((ctx.data as Record<string, unknown>).lead ?? {}) as Record<string, unknown>;
    const current = Number(lead.score ?? 0);
    const next    = Math.max(0, Math.min(100, current + Number(cfg.set_score_delta)));
    updates.score = next;
  }
  if (cfg.add_tags && Array.isArray(cfg.add_tags)) {
    const lead = ((ctx.data as Record<string, unknown>).lead ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(lead.tags) ? (lead.tags as string[]) : [];
    updates.tags = Array.from(new Set([...existing, ...(cfg.add_tags as string[])]));
  }

  if (Object.keys(updates).length === 0) return;

  await supabaseAdmin.from('crm_leads')
    .update(updates)
    .eq('org_id', ctx.org_id)
    .eq('id', ctx.entity_id);
}

async function sendNotificationAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  const recipient_id = resolveOwner(cfg.recipient, ctx);
  if (!recipient_id) return;

  const title = interpolate(String(cfg.title ?? 'CRM automation'), ctx.data);
  const body  = interpolate(String(cfg.body  ?? ''),                ctx.data);

  // Best-effort — the `notifications` table is part of the broadcast /
  // in-app messaging system. Some tenants may not have it provisioned,
  // so we swallow the error rather than failing the whole automation
  // run.
  try {
    await supabaseAdmin.from('notifications').insert({
      org_id: ctx.org_id,
      user_id: recipient_id,
      title,
      body,
      type: 'automation',
      metadata: { entity: ctx.entity, entity_id: ctx.entity_id },
    });
  } catch (_err) {
    /* swallowed — see comment above */
  }
}

// Pull the entity row (lead/deal) out of the trigger context.
function entityRow(ctx: AutomationContext): Record<string, unknown> {
  return ((ctx.data as Record<string, unknown>)[ctx.entity] ?? {}) as Record<string, unknown>;
}

async function updateDealAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  if (ctx.entity !== 'deal') return;
  const updates: Record<string, unknown> = {};
  if (cfg.set_stage_id) updates.stage_id = cfg.set_stage_id;
  if (cfg.set_owner_id) updates.owner_id = cfg.set_owner_id;
  if (cfg.set_status)   updates.status   = cfg.set_status;
  if (cfg.set_amount != null) updates.amount = Number(cfg.set_amount);
  if (Object.keys(updates).length === 0) return;
  const { updateDeal } = await import('./deals.service');
  await updateDeal(ctx.org_id, ctx.entity_id, updates, ctx.user_id);
}

async function sendEmailAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  const entity = entityRow(ctx);
  const to = (interpolate(String(cfg.to ?? ''), ctx.data) || (entity.email as string) || '').trim();
  if (!to) return;
  const { sendEmail } = await import('./emails.service');
  await sendEmail({
    org_id: ctx.org_id,
    user_id: ctx.user_id,
    to,
    subject:  interpolate(String(cfg.subject ?? ''), ctx.data),
    body_html: interpolate(String(cfg.body_html ?? cfg.body ?? ''), ctx.data),
    template_id: (cfg.template_id as string) ?? null,
    lead_id: ctx.entity === 'lead' ? ctx.entity_id : null,
    deal_id: ctx.entity === 'deal' ? ctx.entity_id : null,
  });
}

async function sendWhatsappAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  const entity = entityRow(ctx);
  const to = (interpolate(String(cfg.to ?? ''), ctx.data) || (entity.phone as string) || '').trim();
  if (!to) return;
  const { sendWhatsapp } = await import('./whatsapp.service');
  await sendWhatsapp({
    org_id: ctx.org_id,
    user_id: ctx.user_id,
    to,
    body_text: interpolate(String(cfg.body_text ?? cfg.body ?? ''), ctx.data) || undefined,
    template_id: (cfg.template_id as string) ?? null,
    lead_id: ctx.entity === 'lead' ? ctx.entity_id : null,
    deal_id: ctx.entity === 'deal' ? ctx.entity_id : null,
  });
}

async function assignOwnerAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  let newOwner: string | null = null;
  if (cfg.user_id) {
    // Explicit user.
    newOwner = String(cfg.user_id);
  } else {
    // Re-run the assignment rules (round-robin / territory / default).
    const { assignOwner } = await import('./assignment.service');
    newOwner = await assignOwner(ctx.org_id, entityRow(ctx), ctx.user_id ?? null);
  }
  if (!newOwner) return;
  const table = ctx.entity === 'deal' ? 'crm_deals' : 'crm_leads';
  await supabaseAdmin.from(table)
    .update({ owner_id: newOwner })
    .eq('org_id', ctx.org_id)
    .eq('id', ctx.entity_id);
}

async function convertLeadAction(cfg: Record<string, unknown>, ctx: AutomationContext) {
  if (ctx.entity !== 'lead') return;
  const { convertLead } = await import('./leads.service');
  await convertLead(ctx.org_id, ctx.entity_id, {
    create_deal: cfg.create_deal !== false,
    deal_name: cfg.deal_name ? interpolate(String(cfg.deal_name), ctx.data) : undefined,
    deal_amount: cfg.deal_amount != null ? Number(cfg.deal_amount) : undefined,
    pipeline_id: (cfg.pipeline_id as string) ?? undefined,
    stage_id: (cfg.stage_id as string) ?? undefined,
  }, ctx.user_id);
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Resolve an owner reference. Supports:
 *   - 'lead_owner' / 'deal_owner' / 'entity_owner' — pulls from ctx.data
 *   - explicit UUID string — used verbatim
 *   - undefined / null — returns null
 */
function resolveOwner(ref: unknown, ctx: AutomationContext): string | null {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref === 'lead_owner' || ref === 'entity_owner') {
    const entity = (ctx.data as Record<string, unknown>)[ctx.entity] as Record<string, unknown> | undefined;
    return (entity?.owner_id as string | undefined) ?? null;
  }
  if (ref === 'deal_owner') {
    const deal = (ctx.data as Record<string, unknown>).deal as Record<string, unknown> | undefined;
    return (deal?.owner_id as string | undefined) ?? null;
  }
  // Assume it's a literal user UUID
  return ref;
}

/**
 * Substitute {{field.path}} placeholders in a template string with values
 * pulled from the automation context's data tree. Missing values render
 * as empty strings so partial data doesn't blow up the action.
 */
function interpolate(template: string, data: Record<string, unknown>): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, path) => {
    const v = getPath(data, String(path));
    return v == null ? '' : String(v);
  });
}

// ── Time-based scheduler ────────────────────────────────────
// Driven by an in-process interval (server.ts) and/or the manual
// /crm/automation-scheduler/run endpoint. For each active time-based
// automation it finds the entities past the threshold, claims them in the
// dedup ledger, evaluates conditions, and runs the action — exactly once per
// idle/stall/overdue episode.

const TIMED_TRIGGERS: TriggerType[] = ['lead_idle', 'deal_stalled', 'task_overdue'];

interface TimedMatch {
  entity: EntityKind;
  entity_id: string;
  row: Record<string, unknown>;
  anchor: string;             // timestamp the dedup window keys on
  extra?: Record<string, unknown>;
}

/** Atomically claim an (automation, entity, window) tuple. Returns true only
 *  for the caller that actually inserted it (others see a duplicate). */
async function claimEvent(automation_id: string, entity_id: string, window_key: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('crm_automation_event_log')
    .upsert({ automation_id, entity_id, window_key }, { onConflict: 'automation_id,entity_id,window_key', ignoreDuplicates: true })
    .select('id');
  if (error) return false; // on error, don't fire — safer than double-firing
  return (data?.length ?? 0) > 0;
}

async function findTimedEntities(a: AutomationRow, cutoffIso: string): Promise<TimedMatch[]> {
  const cutoffMs = Date.parse(cutoffIso);
  const scope = (q: any) => { let x = q.eq('org_id', a.org_id); if (a.client_id) x = x.eq('client_id', a.client_id); return x; };

  if (a.trigger_type === 'lead_idle') {
    // created_at <= cutoff is necessary (last_activity >= created); the JS
    // filter then keys on coalesce(last_activity_at, created_at) so a
    // never-touched old lead also counts as idle.
    const { data } = await scope(supabaseAdmin.from('crm_leads')
      .select('id, owner_id, status, last_activity_at, created_at, client_id, email, phone, first_name, last_name, company, score, city')
      .is('deleted_at', null)
      .in('status', ['new', 'working', 'nurturing', 'qualified'])
      .lte('created_at', cutoffIso)).limit(1000);
    return ((data ?? []) as any[])
      .filter((r) => Date.parse((r.last_activity_at ?? r.created_at) as string) <= cutoffMs)
      .map((r) => ({ entity: 'lead' as EntityKind, entity_id: r.id, row: r, anchor: String(r.last_activity_at ?? r.created_at) }));
  }

  if (a.trigger_type === 'deal_stalled') {
    const { data } = await scope(supabaseAdmin.from('crm_deals')
      .select('id, owner_id, status, updated_at, client_id, name, amount, stage_id')
      .is('deleted_at', null).eq('status', 'open').lte('updated_at', cutoffIso)).limit(1000);
    return ((data ?? []) as any[]).map((r) => ({ entity: 'deal' as EntityKind, entity_id: r.id, row: r, anchor: String(r.updated_at) }));
  }

  if (a.trigger_type === 'task_overdue') {
    const { data } = await scope(supabaseAdmin.from('crm_activities')
      .select('id, owner_id, assigned_to, type, status, due_at, lead_id, deal_id, client_id, subject')
      .eq('type', 'task').is('deleted_at', null)
      .not('status', 'in', '(done,completed,cancelled)')
      .not('due_at', 'is', null).lte('due_at', cutoffIso)).limit(1000);
    const out: TimedMatch[] = [];
    for (const t of (data ?? []) as any[]) {
      const entity: EntityKind = t.deal_id ? 'deal' : 'lead';
      const entity_id = (t.lead_id ?? t.deal_id) as string | undefined;
      if (!entity_id) continue;
      out.push({ entity, entity_id, row: { id: entity_id, owner_id: t.assigned_to ?? t.owner_id }, anchor: String(t.due_at), extra: { activity: t } });
    }
    return out;
  }
  return [];
}

export async function runScheduledAutomations(): Promise<{ checked: number; fired: number }> {
  let checked = 0, fired = 0;
  const { data: autos, error } = await supabaseAdmin.from('crm_automations')
    .select('*').eq('is_active', true).in('trigger_type', TIMED_TRIGGERS);
  if (error || !autos?.length) return { checked, fired };

  for (const a of autos as AutomationRow[]) {
    const days = Math.max(1, Number((a.trigger_config as Record<string, unknown> | null)?.days ?? 3));
    const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
    let matches: TimedMatch[] = [];
    try { matches = await findTimedEntities(a, cutoffIso); } catch { continue; }

    for (const m of matches) {
      checked++;
      try {
        if (!(await claimEvent(a.id, m.entity_id, m.anchor))) continue;
        const context: AutomationContext = {
          org_id: a.org_id, entity: m.entity, entity_id: m.entity_id,
          data: {
            [m.entity]: m.row,
            ...(m.extra ?? {}),
            client_id: a.client_id ?? (m.row as { client_id?: string | null }).client_id ?? null,
            days,
          },
        };
        if (!evaluateConditions(readConditions(a.trigger_config), context)) continue;
        await executeAction(a, context);
        fired++;
      } catch (err) {
        console.error(`[automation.scheduled] ${a.id} on ${m.entity}:${m.entity_id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    if (fired > 0) {
      await supabaseAdmin.from('crm_automations')
        .update({ run_count: (a.run_count ?? 0) + 1, last_run_at: new Date().toISOString() })
        .eq('id', a.id);
    }
  }
  return { checked, fired };
}

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
  | 'deal_lost';

export type ActionType =
  | 'create_task'
  | 'create_activity'
  | 'update_lead'
  | 'send_notification';

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
    case 'send_notification': return sendNotificationAction(cfg, context);
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

/**
 * Phase 2 automation flows — ordered execution engine.
 *
 * A "flow" (crm_flows) = a trigger + shared conditions + an ordered set of
 * steps (crm_flow_steps). Unlike Phase-1 `crm_automations` (one loose action
 * per row, all firing independently), a flow runs its steps IN ORDER.
 *
 * Scope of THIS step (Phase 2, step 2 — linear ordered execution):
 *   - `kind='action'` steps run in `position` order via the exact same
 *     executors as the Phase-1 engine (`runSingleAction`).
 *   - `kind='stop'` ends the flow.
 *   - `kind='delay'` / `kind='branch'` are parsed but NOT yet executed
 *     (steps 3–4). For now a delay is a pass-through (no wait) and a branch
 *     falls through to the next step — behaviour-parity with "run all steps",
 *     just ordered. This keeps the table shape final while the scheduler +
 *     branch evaluator land next.
 *
 * NOT wired into the live `fireForTrigger` path yet: the shared backend also
 * serves the Tata project, where these tables intentionally don't exist yet
 * (default-tenant rule), so live wiring waits until the tables are migrated
 * everywhere + verified. Until then, exercise a flow via the super-admin
 * `POST /api/v1/crm/flow-test-run` endpoint (Kinematic).
 */
import { supabaseAdmin } from '../../lib/supabase';
import {
  AutomationContext, EntityKind, TriggerType,
  runSingleAction, evaluateConditions, readConditions,
} from './automations.service';

interface FlowRow {
  id: string;
  org_id: string;
  client_id: string | null;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown> | null;
  is_active: boolean;
  run_count: number | null;
}

interface StepRow {
  id: string;
  flow_id: string;
  kind: 'action' | 'delay' | 'branch' | 'stop';
  position: number;
  action_type: string | null;
  action_config: Record<string, unknown> | null;
}

/**
 * Fire every active flow whose trigger + conditions match. Never throws —
 * same contract as `fireForTrigger`; call as `fireFlowsForTrigger(...).catch(() => {})`.
 */
export async function fireFlowsForTrigger(
  trigger_type: TriggerType,
  context: AutomationContext,
): Promise<{ fired: number; matched: number }> {
  let q = supabaseAdmin.from('crm_flows').select('*')
    .eq('org_id', context.org_id)
    .eq('trigger_type', trigger_type)
    .eq('is_active', true);

  // Same client-scoping as the Phase-1 engine: run flows that are either
  // client-agnostic (NULL) or belong to the entity's client.
  const ctxClientId = (context.data as Record<string, unknown>)?.client_id
    ?? ((context.data as Record<string, unknown>)?.[context.entity] as Record<string, unknown> | undefined)?.client_id
    ?? null;
  if (ctxClientId) q = q.or(`client_id.is.null,client_id.eq.${String(ctxClientId)}`);

  // On projects where crm_flows doesn't exist yet (Tata), this errors — we
  // return a silent no-op exactly like the Phase-1 path, never throwing.
  const { data: flows, error } = await q;
  if (error || !flows || flows.length === 0) return { fired: 0, matched: 0 };

  let fired = 0;
  for (const flow of flows as FlowRow[]) {
    try {
      if (!evaluateConditions(readConditions(flow.trigger_config), context)) continue;
      await runFlow(flow, context);
      fired++;
    } catch (err) {
      console.error(
        `[flow] ${flow.id} (${flow.name}) failed for trigger ${trigger_type}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { fired, matched: flows.length };
}

/**
 * Run a single flow against a context: execute its steps in order, record a
 * run row (audit; the delay scheduler will reuse it), bump run_count.
 */
async function runFlow(flow: FlowRow, context: AutomationContext): Promise<void> {
  const { data: stepData } = await supabaseAdmin.from('crm_flow_steps')
    .select('id, flow_id, kind, position, action_type, action_config')
    .eq('flow_id', flow.id)
    .order('position', { ascending: true });
  const steps = (stepData ?? []) as StepRow[];

  const { data: runRows } = await supabaseAdmin.from('crm_flow_runs')
    .insert({
      flow_id: flow.id,
      org_id: flow.org_id,
      entity_type: context.entity,
      entity_id: context.entity_id,
      status: 'running',
    })
    .select('id');
  const runId = (runRows?.[0]?.id as string | undefined) ?? null;

  let failed = false;
  let lastError: string | null = null;
  let lastStepId: string | null = null;

  for (const step of steps) {
    lastStepId = step.id;
    try {
      if (step.kind === 'stop') break;
      if (step.kind === 'action' && step.action_type) {
        await runSingleAction(step.action_type, step.action_config, context, `flow:${flow.id}`);
      }
      // delay / branch: not executed yet (Phase-2 steps 3–4). Linear
      // pass-through keeps ordered behaviour without waiting/branching.
    } catch (err) {
      failed = true;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[flow] step ${step.id} of flow ${flow.id} failed:`, lastError);
    }
  }

  if (runId) {
    await supabaseAdmin.from('crm_flow_runs')
      .update({
        status: failed ? 'failed' : 'done',
        error: lastError,
        current_step_id: lastStepId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', runId);
  }

  await supabaseAdmin.from('crm_flows')
    .update({ run_count: (flow.run_count ?? 0) + 1, last_run_at: new Date().toISOString() })
    .eq('id', flow.id);
}

/**
 * Manual QA (super-admin) — run one flow against a real entity, building the
 * context from the live row. Lets us verify ordered execution on Kinematic
 * before wiring flows into the live trigger path.
 */
export async function testRunFlow(
  org_id: string,
  flow_id: string,
  entity: EntityKind,
  entity_id: string,
  user_id?: string,
): Promise<{ ok: true; steps: number }> {
  const { data: fRows } = await supabaseAdmin.from('crm_flows').select('*')
    .eq('org_id', org_id).eq('id', flow_id).limit(1);
  const flow = (fRows?.[0]) as FlowRow | undefined;
  if (!flow) throw new Error('flow not found');

  const table = entity === 'deal' ? 'crm_deals'
    : entity === 'contact' ? 'crm_contacts'
    : entity === 'account' ? 'crm_accounts'
    : 'crm_leads';
  const { data: eRows } = await supabaseAdmin.from(table).select('*')
    .eq('org_id', org_id).eq('id', entity_id).limit(1);
  const row = (eRows?.[0]) as Record<string, unknown> | undefined;
  if (!row) throw new Error('entity not found');

  const context: AutomationContext = {
    org_id, user_id, entity, entity_id,
    data: { [entity]: row, client_id: (row.client_id as string | null | undefined) ?? null },
  };

  const { count } = await supabaseAdmin.from('crm_flow_steps')
    .select('id', { count: 'exact', head: true }).eq('flow_id', flow_id);
  await runFlow(flow, context);
  return { ok: true, steps: count ?? 0 };
}

/**
 * Phase 2 automation flows — ordered + time-aware + branching execution engine.
 *
 * A "flow" (crm_flows) = a trigger + shared conditions + a graph of steps
 * (crm_flow_steps). Unlike Phase-1 `crm_automations` (loose actions that all
 * fire at once), a flow walks its steps as a graph: default `next_step_id`
 * edges, plus true/false edges on branch steps. When an edge id is null the
 * engine falls through to the next step by `position` (so a plain linear flow
 * authored without explicit edges just runs top-to-bottom).
 *
 * Step kinds:
 *   - action — run an action via the SAME executors as Phase 1 (`runSingleAction`).
 *   - delay  — park the run (status='waiting' + resume_at); the scheduler
 *              (`resumeWaitingFlowRuns`) continues it once due. {amount, unit}.
 *   - branch — evaluate `branch.conditions`; follow branch_true_step_id when
 *              all pass, else branch_false_step_id.
 *   - stop   — end the flow.
 *
 * Multi-project: `supabaseAdmin` is project-aware (resolves the current project
 * per request). On a project without the tables (Tata, currently) every query
 * errors → silent no-op. NOT wired into the live `fireForTrigger` path yet.
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
  delay: { amount?: unknown; unit?: unknown } | null;
  branch: Record<string, unknown> | null;
  next_step_id: string | null;
  branch_true_step_id: string | null;
  branch_false_step_id: string | null;
}

interface FlowRunRow {
  id: string;
  flow_id: string;
  org_id: string;
  entity_type: string;
  entity_id: string;
  current_step_id: string | null;
}

const nowIso = () => new Date().toISOString();
const STEP_COLS = 'id, flow_id, kind, position, action_type, action_config, delay, branch, next_step_id, branch_true_step_id, branch_false_step_id';
const MAX_STEPS_PER_RUN = 1000; // loop guard for misconfigured edge cycles

// ── Public: fire on a trigger ───────────────────────────────

/**
 * Fire every active flow whose trigger + conditions match. Never throws (same
 * contract as `fireForTrigger`). On a project without the tables → no-op.
 */
export async function fireFlowsForTrigger(
  trigger_type: TriggerType,
  context: AutomationContext,
): Promise<{ fired: number; matched: number }> {
  let q = supabaseAdmin.from('crm_flows').select('*')
    .eq('org_id', context.org_id)
    .eq('trigger_type', trigger_type)
    .eq('is_active', true);

  const ctxClientId = (context.data as Record<string, unknown>)?.client_id
    ?? ((context.data as Record<string, unknown>)?.[context.entity] as Record<string, unknown> | undefined)?.client_id
    ?? null;
  if (ctxClientId) q = q.or(`client_id.is.null,client_id.eq.${String(ctxClientId)}`);

  const { data: flows, error } = await q;
  if (error || !flows || flows.length === 0) return { fired: 0, matched: 0 };

  let fired = 0;
  for (const flow of flows as FlowRow[]) {
    try {
      if (!evaluateConditions(readConditions(flow.trigger_config), context)) continue;
      await startFlow(flow, context);
      fired++;
    } catch (err) {
      console.error(`[flow] ${flow.id} (${flow.name}) failed for trigger ${trigger_type}:`,
        err instanceof Error ? err.message : err);
    }
  }
  return { fired, matched: flows.length };
}

// ── Execution (graph walk) ──────────────────────────────────

async function loadSteps(flowId: string): Promise<StepRow[]> {
  const { data } = await supabaseAdmin.from('crm_flow_steps')
    .select(STEP_COLS)
    .eq('flow_id', flowId)
    .order('position', { ascending: true });
  return (data ?? []) as StepRow[];
}

/** Enrol a context into a flow: create the run row, walk from the first step. */
async function startFlow(flow: FlowRow, context: AutomationContext): Promise<void> {
  const steps = await loadSteps(flow.id);
  const { data: runRows } = await supabaseAdmin.from('crm_flow_runs')
    .insert({
      flow_id: flow.id, org_id: flow.org_id,
      entity_type: context.entity, entity_id: context.entity_id,
      status: 'running',
    })
    .select('id');
  const runId = runRows?.[0]?.id as string | undefined;
  if (!runId) return;
  await executeFrom(runId, flow, context, steps, null);
  await supabaseAdmin.from('crm_flows')
    .update({ run_count: (flow.run_count ?? 0) + 1, last_run_at: nowIso() })
    .eq('id', flow.id);
}

/**
 * Walk the step graph from `startStepId` (null = the first step by position).
 * `action` runs; `branch` picks the true/false edge; `delay` parks the run and
 * returns (the scheduler resumes from the stored next step); `stop`/no-next
 * ends the run. A null edge falls through to the next step by position.
 */
async function executeFrom(
  runId: string, flow: FlowRow, context: AutomationContext, steps: StepRow[], startStepId: string | null,
): Promise<void> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const sorted = [...steps].sort((a, b) => a.position - b.position);
  const posOf = new Map(sorted.map((s, i) => [s.id, i]));
  const nextByPosition = (s: StepRow): StepRow | null => {
    const i = posOf.get(s.id);
    return i == null ? null : (sorted[i + 1] ?? null);
  };
  const edge = (s: StepRow, id: string | null): StepRow | null => (id ? (byId.get(id) ?? null) : nextByPosition(s));

  let current: StepRow | null = startStepId ? (byId.get(startStepId) ?? null) : (sorted[0] ?? null);
  let failed = false;
  let lastError: string | null = null;
  let lastStepId: string | null = null;
  let guard = 0;

  while (current && guard++ < MAX_STEPS_PER_RUN) {
    const step = current;
    lastStepId = step.id;
    try {
      if (step.kind === 'stop') { current = null; break; }

      if (step.kind === 'delay') {
        const ms = delayMs(step.delay);
        if (ms > 0) {
          const next = edge(step, step.next_step_id);
          await supabaseAdmin.from('crm_flow_runs').update({
            status: 'waiting',
            resume_at: new Date(Date.now() + ms).toISOString(),
            current_step_id: next?.id ?? null,
            updated_at: nowIso(),
          }).eq('id', runId);
          return; // pause — scheduler resumes from `next`
        }
        current = edge(step, step.next_step_id);
        continue;
      }

      if (step.kind === 'branch') {
        // branch jsonb is { conditions:[...] } — reuse the same reader/eval.
        const pass = evaluateConditions(readConditions(step.branch), context);
        current = edge(step, pass ? step.branch_true_step_id : step.branch_false_step_id);
        continue;
      }

      if (step.kind === 'action' && step.action_type) {
        await runSingleAction(step.action_type, step.action_config, context, `flow:${flow.id}`);
      }
      current = edge(step, step.next_step_id);
    } catch (err) {
      failed = true;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[flow] step ${step.id} of flow ${flow.id} failed:`, lastError);
      current = edge(step, step.next_step_id); // continue past a failed action
    }
  }

  await supabaseAdmin.from('crm_flow_runs').update({
    status: failed ? 'failed' : 'done',
    error: lastError,
    current_step_id: lastStepId,
    updated_at: nowIso(),
  }).eq('id', runId);
}

function delayMs(delay: StepRow['delay']): number {
  if (!delay || typeof delay !== 'object') return 0;
  const amount = Number((delay as { amount?: unknown }).amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = String((delay as { unit?: unknown }).unit ?? 'days');
  const mult = unit === 'minutes' ? 60_000 : unit === 'hours' ? 3_600_000 : 86_400_000;
  return amount * mult;
}

// ── Resume (delay scheduler) ────────────────────────────────

/**
 * Resume every waiting flow-run whose delay is up. Scoped to the caller's
 * project (see module header). Never throws.
 */
export async function resumeWaitingFlowRuns(): Promise<{ resumed: number }> {
  const { data: runs, error } = await supabaseAdmin.from('crm_flow_runs')
    .select('id, flow_id, org_id, entity_type, entity_id, current_step_id')
    .eq('status', 'waiting')
    .lte('resume_at', nowIso())
    .limit(500);
  if (error || !runs || runs.length === 0) return { resumed: 0 };

  let resumed = 0;
  for (const run of runs as FlowRunRow[]) {
    try { if (await resumeFlowRun(run)) resumed++; }
    catch (err) { console.error(`[flow.resume] ${run.id}:`, err instanceof Error ? err.message : err); }
  }
  return { resumed };
}

async function resumeFlowRun(run: FlowRunRow): Promise<boolean> {
  // Atomically claim — only the writer that flips waiting→running proceeds, so
  // overlapping scheduler ticks can't double-resume the same run.
  const { data: claimed } = await supabaseAdmin.from('crm_flow_runs')
    .update({ status: 'running', resume_at: null, updated_at: nowIso() })
    .eq('id', run.id).eq('status', 'waiting')
    .select('id');
  if (!claimed || claimed.length === 0) return false;

  const { data: fRows } = await supabaseAdmin.from('crm_flows').select('*').eq('id', run.flow_id).limit(1);
  const flow = fRows?.[0] as FlowRow | undefined;
  if (!flow) { await failRun(run.id, 'flow deleted'); return true; }

  const context = await buildContext(run.org_id, run.entity_type as EntityKind, run.entity_id);
  if (!context) { await failRun(run.id, 'entity no longer exists'); return true; }

  const steps = await loadSteps(flow.id);
  await executeFrom(run.id, flow, context, steps, run.current_step_id);
  return true;
}

async function failRun(runId: string, error: string): Promise<void> {
  await supabaseAdmin.from('crm_flow_runs')
    .update({ status: 'failed', error, updated_at: nowIso() })
    .eq('id', runId);
}

// ── Context builder + manual QA ─────────────────────────────

async function buildContext(
  org_id: string, entity: EntityKind, entity_id: string, user_id?: string,
): Promise<AutomationContext | null> {
  const table = entity === 'deal' ? 'crm_deals'
    : entity === 'contact' ? 'crm_contacts'
    : entity === 'account' ? 'crm_accounts'
    : 'crm_leads';
  const { data } = await supabaseAdmin.from(table).select('*')
    .eq('org_id', org_id).eq('id', entity_id).limit(1);
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    org_id, user_id, entity, entity_id,
    data: { [entity]: row, client_id: (row.client_id as string | null | undefined) ?? null },
  };
}

/**
 * Manual QA (super-admin): run one flow against a real entity. Verifies ordered
 * execution, branching, and delay parking on Kinematic before the live cutover.
 */
export async function testRunFlow(
  org_id: string, flow_id: string, entity: EntityKind, entity_id: string, user_id?: string,
): Promise<{ ok: true; steps: number }> {
  const { data: fRows } = await supabaseAdmin.from('crm_flows').select('*')
    .eq('org_id', org_id).eq('id', flow_id).limit(1);
  const flow = fRows?.[0] as FlowRow | undefined;
  if (!flow) throw new Error('flow not found');

  const context = await buildContext(org_id, entity, entity_id, user_id);
  if (!context) throw new Error('entity not found');

  const steps = await loadSteps(flow_id);
  await startFlow(flow, context);
  return { ok: true, steps: steps.length };
}

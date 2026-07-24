/**
 * Phase 2 automation flows — ordered + time-aware execution engine.
 *
 * A "flow" (crm_flows) = a trigger + shared conditions + an ordered set of
 * steps (crm_flow_steps). Unlike Phase-1 `crm_automations` (loose actions that
 * all fire at once), a flow runs its steps IN ORDER and can WAIT between them.
 *
 * Steps covered so far:
 *   - kind='action' — runs an action via the SAME executors as Phase 1
 *     (`runSingleAction`); no logic duplicated.
 *   - kind='stop'   — ends the flow.
 *   - kind='delay'  — pauses the run: writes status='waiting' + resume_at, and
 *     the step-3 scheduler (`resumeWaitingFlowRuns`) picks it up once due and
 *     continues from the next step. Config: { amount:int, unit:'minutes'|'hours'|'days' }.
 *   - kind='branch' — parsed but still pass-through (step 4).
 *
 * Multi-project: `supabaseAdmin` is project-aware (resolves the current project
 * per request). `fireFlowsForTrigger` runs inside a request, so it hits the
 * right tenant. `resumeWaitingFlowRuns` runs against whatever project the
 * caller is scoped to (the /flow-runs/resume endpoint uses the request's
 * project; the in-process interval uses the default project). On a project
 * without the tables (Tata, currently) every query errors → silent no-op.
 *
 * NOT wired into the live `fireForTrigger` path yet — see the PR notes.
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

// ── Execution ───────────────────────────────────────────────

async function loadSteps(flowId: string): Promise<StepRow[]> {
  const { data } = await supabaseAdmin.from('crm_flow_steps')
    .select('id, flow_id, kind, position, action_type, action_config, delay')
    .eq('flow_id', flowId)
    .order('position', { ascending: true });
  return (data ?? []) as StepRow[];
}

/** Enrol a context into a flow: create the run row, execute from the top. */
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
  await executeSteps(runId, flow, context, steps, 0);
  await supabaseAdmin.from('crm_flows')
    .update({ run_count: (flow.run_count ?? 0) + 1, last_run_at: nowIso() })
    .eq('id', flow.id);
}

/**
 * Execute steps from `startIdx`. On a `delay` step it parks the run
 * (status='waiting', resume_at, current_step_id = the NEXT step) and returns;
 * the scheduler resumes it. Otherwise walks to the end and marks the run done.
 */
async function executeSteps(
  runId: string, flow: FlowRow, context: AutomationContext, steps: StepRow[], startIdx: number,
): Promise<void> {
  let failed = false;
  let lastError: string | null = null;
  let lastStepId: string | null = null;

  for (let i = startIdx; i < steps.length; i++) {
    const step = steps[i];
    lastStepId = step.id;
    try {
      if (step.kind === 'stop') break;

      if (step.kind === 'delay') {
        const ms = delayMs(step.delay);
        if (ms > 0) {
          await supabaseAdmin.from('crm_flow_runs').update({
            status: 'waiting',
            resume_at: new Date(Date.now() + ms).toISOString(),
            current_step_id: steps[i + 1]?.id ?? null, // resume at the step after the delay
            updated_at: nowIso(),
          }).eq('id', runId);
          return; // pause — the scheduler continues from here
        }
        continue; // zero / invalid delay → no wait
      }

      if (step.kind === 'action' && step.action_type) {
        await runSingleAction(step.action_type, step.action_config, context, `flow:${flow.id}`);
      }
      // branch: pass-through until step 4.
    } catch (err) {
      failed = true;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[flow] step ${step.id} of flow ${flow.id} failed:`, lastError);
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
  let startIdx = steps.length; // current_step_id null → nothing left → finishes
  if (run.current_step_id) {
    const found = steps.findIndex((s) => s.id === run.current_step_id);
    startIdx = found < 0 ? steps.length : found;
  }
  await executeSteps(run.id, flow, context, steps, startIdx);
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
 * execution (and delay parking) on Kinematic before the live cutover.
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

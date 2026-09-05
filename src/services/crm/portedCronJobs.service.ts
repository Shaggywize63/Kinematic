/**
 * Cron jobs ported from Supabase Edge Functions into the backend.
 *
 * These three ran as Deno edge functions (crm-recompute-win-prob,
 * crm-send-email-queue, crm-process-automations), each invoked per-minute /
 * per-5-minutes / hourly by that project's pg_cron. When we self-host away from
 * Supabase there is no edge runtime, so the identical logic lives here and is
 * driven by an external scheduler (EventBridge) hitting /api/v1/cron/*.
 *
 * Every function operates through `supabaseAdmin`, which resolves to the CURRENT
 * project (AsyncLocalStorage — see lib/projects). The edge functions ran inside
 * a single project's context, so to preserve that the routes fan these out with
 * runWithProject() across each tenant that scheduled them (all_projects=true).
 *
 * Behaviour is a faithful port of the original edge sources — same queries,
 * same heuristics, same (stub) side effects — so production output is unchanged.
 */
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

/**
 * crm-recompute-win-prob (hourly). Refresh the AI win probability for every
 * OPEN deal: baseline = clamp(stageProb × agePenalty × engagement, 0..100),
 * where agePenalty steps down for stale deals and engagement rewards recent
 * activity. Caps at 1000 deals per run, exactly like the edge function.
 */
export async function recomputeWinProbabilities(): Promise<{ updated: number }> {
  const { data: deals } = await supabaseAdmin
    .from('crm_deals')
    .select('id, org_id, stage_id, amount, created_at, win_probability_updated_at, crm_deal_stages!inner(probability, stage_type)')
    .is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'open')
    .limit(1000);

  let updated = 0;
  for (const d of deals ?? []) {
    const deal = d as unknown as { id: string; created_at: string; crm_deal_stages: { probability: number } };
    const stageProb = Number(deal.crm_deal_stages?.probability ?? 50);
    const ageDays = (Date.now() - new Date(deal.created_at).getTime()) / 86400000;
    const agePenalty = ageDays > 90 ? 0.7 : ageDays > 60 ? 0.85 : 1.0;
    const { count: activityCount } = await supabaseAdmin
      .from('crm_activities')
      .select('id', { count: 'exact', head: true })
      .eq('deal_id', deal.id)
      .gte('completed_at', new Date(Date.now() - 30 * 86400000).toISOString());
    const engagement = Math.min(1.5, 0.7 + (activityCount ?? 0) * 0.1);
    const baseline = Math.max(0, Math.min(100, Math.round(stageProb * agePenalty * engagement)));
    const reasoning = `Stage ${stageProb}% × age ${agePenalty.toFixed(2)} × engagement ${engagement.toFixed(2)} = ${baseline}%.`;
    await supabaseAdmin
      .from('crm_deals')
      .update({
        win_probability_ai: baseline,
        win_probability_reasoning: reasoning,
        win_probability_updated_at: new Date().toISOString(),
      })
      .eq('id', deal.id);
    updated++;
  }
  return { updated };
}

/**
 * crm-send-email-queue (per minute). Drains crm_email_logs rows in status
 * 'queued'. NOTE: this is a STUB provider — it just marks each row 'sent' with a
 * synthetic provider_message_id, exactly as the edge function did. Preserved
 * verbatim so behaviour is unchanged; real delivery lives in emails.service.
 */
export async function runEmailQueue(): Promise<{ sent: number }> {
  const { data: queued } = await supabaseAdmin
    .from('crm_email_logs')
    .select('id, org_id, from_email, to_email, subject, body_html')
    .eq('status', 'queued')
    .limit(50);

  let sent = 0;
  for (const log of queued ?? []) {
    const row = log as unknown as { id: string };
    await supabaseAdmin
      .from('crm_email_logs')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_message_id: `stub-${crypto.randomUUID()}`,
      })
      .eq('id', row.id);
    sent++;
  }
  return { sent };
}

/**
 * crm-process-automations (every 5 min). Evaluates active workflow automations.
 * Supported triggers: 'lead.created', 'lead.score_threshold',
 * 'deal.stage_changed'. For each matching entity since the rule's last_run_at,
 * runs each configured action, then advances last_run_at. Per-action failures
 * are swallowed so one bad action never stalls the rule (edge-function parity).
 */
export async function runWorkflowAutomations(): Promise<{ executed: number }> {
  const { data: rules } = await supabaseAdmin
    .from('crm_workflow_automations')
    .select('*')
    .eq('is_active', true);

  let executed = 0;
  for (const rule of rules ?? []) {
    const r = rule as Record<string, unknown> & {
      id: string;
      org_id: string;
      trigger_type?: string;
      trigger_config?: { score_gte?: number } | null;
      actions?: Array<Record<string, unknown>> | null;
      last_run_at?: string | null;
    };
    const since = r.last_run_at ?? new Date(Date.now() - 10 * 60 * 1000).toISOString();
    let entities: Array<Record<string, unknown>> = [];

    if (r.trigger_type === 'lead.created') {
      const { data } = await supabaseAdmin
        .from('crm_leads')
        .select('*')
        .eq('org_id', r.org_id)
        .gte('created_at', since)
        .is('deleted_at', null);
      entities = (data ?? []) as Array<Record<string, unknown>>;
    } else if (r.trigger_type === 'lead.score_threshold') {
      const threshold = Number(r.trigger_config?.score_gte ?? 70);
      const { data } = await supabaseAdmin
        .from('crm_leads')
        .select('*')
        .eq('org_id', r.org_id)
        .gte('score', threshold)
        .gte('score_updated_at', since)
        .is('deleted_at', null);
      entities = (data ?? []) as Array<Record<string, unknown>>;
    } else if (r.trigger_type === 'deal.stage_changed') {
      const { data } = await supabaseAdmin
        .from('crm_deal_history')
        .select('*, crm_deals!inner(*)')
        .eq('org_id', r.org_id)
        .gte('changed_at', since);
      entities = (data ?? []) as Array<Record<string, unknown>>;
    }

    for (const entity of entities) {
      for (const action of r.actions ?? []) {
        try {
          await runAutomationAction(r.org_id, action, entity);
        } catch {
          /* keep going — one failed action must not stall the rule */
        }
      }
      executed++;
    }
    await supabaseAdmin
      .from('crm_workflow_automations')
      .update({ last_run_at: new Date().toISOString() })
      .eq('id', r.id);
  }
  return { executed };
}

async function runAutomationAction(
  org_id: string,
  action: Record<string, unknown>,
  entity: Record<string, unknown>,
): Promise<void> {
  const type = String(action.type ?? '');
  if (type === 'create_task') {
    await supabaseAdmin.from('crm_activities').insert({
      org_id,
      type: 'task',
      subject: String(action.subject ?? 'Auto follow-up'),
      due_at: action.due_at ?? new Date(Date.now() + 86400000).toISOString(),
      status: 'planned',
      lead_id: entity.id ?? null,
    });
  } else if (type === 'send_email_template') {
    await supabaseAdmin.from('crm_email_logs').insert({
      org_id,
      template_id: action.template_id ?? null,
      from_email: 'noreply@kinematic.app',
      to_email: String(entity.email ?? ''),
      subject: String(action.subject ?? 'Hello'),
      body_html: String(action.body_html ?? ''),
      provider: 'stub',
      status: 'queued',
      lead_id: entity.id ?? null,
    });
  } else if (type === 'set_status' && action.status) {
    await supabaseAdmin.from('crm_leads').update({ status: action.status }).eq('id', entity.id).eq('org_id', org_id);
  } else if (type === 'assign_owner' && action.owner_id) {
    await supabaseAdmin.from('crm_leads').update({ owner_id: action.owner_id }).eq('id', entity.id).eq('org_id', org_id);
  }
}

/** Small helper: log + swallow so a fan-out over projects never aborts midway. */
export async function safeRun<T>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[cron] ${label} failed: ${msg}`);
    return { error: msg };
  }
}

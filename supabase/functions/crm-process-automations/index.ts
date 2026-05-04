// Supabase Edge Function: crm-process-automations
// Evaluates active workflow automations every 5 minutes.
// Trigger types supported: 'lead.created', 'deal.stage_changed', 'lead.score_threshold'.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SHARED_SECRET = Deno.env.get('SUPABASE_EDGE_SECRET') || '';
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async (req) => {
  if (SHARED_SECRET) {
    const auth = req.headers.get('Authorization') || '';
    if (auth !== `Bearer ${SHARED_SECRET}`) return new Response('Unauthorized', { status: 401 });
  }

  const { data: rules } = await sb.from('crm_workflow_automations').select('*').eq('is_active', true);
  let executed = 0;

  for (const rule of rules ?? []) {
    const since = rule.last_run_at ?? new Date(Date.now() - 10 * 60 * 1000).toISOString();
    let entities: Array<Record<string, unknown>> = [];

    if (rule.trigger_type === 'lead.created') {
      const { data } = await sb.from('crm_leads').select('*')
        .eq('org_id', rule.org_id).gte('created_at', since).is('deleted_at', null);
      entities = data ?? [];
    } else if (rule.trigger_type === 'lead.score_threshold') {
      const threshold = Number(rule.trigger_config?.score_gte ?? 70);
      const { data } = await sb.from('crm_leads').select('*')
        .eq('org_id', rule.org_id).gte('score', threshold).gte('score_updated_at', since)
        .is('deleted_at', null);
      entities = data ?? [];
    } else if (rule.trigger_type === 'deal.stage_changed') {
      const { data } = await sb.from('crm_deal_history').select('*, crm_deals!inner(*)')
        .eq('org_id', rule.org_id).gte('changed_at', since);
      entities = data ?? [];
    }

    for (const entity of entities) {
      for (const action of rule.actions ?? []) {
        try {
          await runAction(rule.org_id, action, entity);
        } catch { /* keep going */ }
      }
      executed++;
    }
    await sb.from('crm_workflow_automations').update({ last_run_at: new Date().toISOString() }).eq('id', rule.id);
  }

  return new Response(JSON.stringify({ executed }), { headers: { 'Content-Type': 'application/json' } });
});

async function runAction(org_id: string, action: Record<string, unknown>, entity: Record<string, unknown>) {
  const type = String(action.type ?? '');
  if (type === 'create_task') {
    await sb.from('crm_activities').insert({
      org_id, type: 'task', subject: String(action.subject ?? 'Auto follow-up'),
      due_at: action.due_at ?? new Date(Date.now() + 86400000).toISOString(),
      status: 'planned',
      lead_id: entity.id ?? null,
    });
  } else if (type === 'send_email_template') {
    await sb.from('crm_email_logs').insert({
      org_id, template_id: action.template_id ?? null,
      from_email: 'noreply@kinematic.app',
      to_email: String(entity.email ?? ''),
      subject: String(action.subject ?? 'Hello'),
      body_html: String(action.body_html ?? ''),
      provider: 'stub', status: 'queued',
      lead_id: entity.id ?? null,
    });
  } else if (type === 'set_status' && action.status) {
    await sb.from('crm_leads').update({ status: action.status }).eq('id', entity.id).eq('org_id', org_id);
  } else if (type === 'assign_owner' && action.owner_id) {
    await sb.from('crm_leads').update({ owner_id: action.owner_id }).eq('id', entity.id).eq('org_id', org_id);
  }
}

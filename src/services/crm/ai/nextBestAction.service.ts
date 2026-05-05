/**
 * Next-best-action recommender. Claude Haiku, cached 6h on the deal.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';
import type { NextBestAction } from '../../../types/crm.types';

const SYSTEM_PROMPT = `You are a sales coach. Given a deal's current state, recent activity, days in stage, and win probability, recommend ONE next action.
Output JSON only:
{"action":"call"|"email"|"meeting"|"send_proposal"|"nurture"|"disqualify",
 "priority":"high"|"med"|"low",
 "reason": str (<=200 chars),
 "suggested_template_id": str|null,
 "suggested_when":"now"|"today"|"this_week"|"next_week"}`;

export async function compute(org_id: string, deal_id: string, force = false): Promise<NextBestAction | null> {
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('*')
    .eq('org_id', org_id).eq('id', deal_id).is('deleted_at', null).maybeSingle();
  if (!deal) return null;

  const cacheAgeMs = deal.next_action_updated_at ? Date.now() - new Date(deal.next_action_updated_at).getTime() : Infinity;
  if (!force && cacheAgeMs < 6 * 60 * 60 * 1000 && deal.next_action_ai) {
    return deal.next_action_ai as NextBestAction;
  }

  const { data: recent } = await supabaseAdmin.from('crm_activities')
    .select('type, subject, completed_at, status')
    .eq('org_id', org_id).eq('deal_id', deal_id).is('deleted_at', null)
    .order('completed_at', { ascending: false }).limit(5);

  const { data: stage } = await supabaseAdmin.from('crm_deal_stages').select('name, probability, stage_type')
    .eq('id', deal.stage_id).single();

  const userPayload = {
    deal: {
      name: deal.name, amount: deal.amount, currency: deal.currency,
      expected_close_date: deal.expected_close_date,
      created_at: deal.created_at, win_probability_ai: deal.win_probability_ai,
    },
    stage,
    recent_activities: recent ?? [],
  };

  let nba: NextBestAction;
  try {
    const response = await aiComplete({
      org_id,
      model: process.env.CRM_NBA_MODEL || 'claude-haiku-4-5',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 250,
    });
    const parsed = JSON.parse(extractJson(response));
    nba = {
      action: parsed.action, priority: parsed.priority, reason: String(parsed.reason ?? '').slice(0, 200),
      suggested_template_id: parsed.suggested_template_id ?? null,
      suggested_when: parsed.suggested_when ?? 'this_week',
    };
  } catch {
    nba = fallback(deal, stage, recent ?? []);
  }

  await supabaseAdmin.from('crm_deals').update({
    next_action_ai: nba, next_action_updated_at: new Date().toISOString(),
  }).eq('id', deal_id).eq('org_id', org_id);

  return nba;
}

function fallback(deal: Record<string, unknown>, stage: Record<string, unknown> | null, recent: unknown[]): NextBestAction {
  const stageType = stage?.stage_type as string | undefined;
  if (stageType === 'won' || stageType === 'lost') {
    return { action: 'nurture', priority: 'low', reason: 'Deal already closed.', suggested_template_id: null, suggested_when: 'next_week' };
  }
  if (recent.length === 0) {
    return { action: 'call', priority: 'high', reason: 'No recent activity. Reach out now.', suggested_template_id: null, suggested_when: 'today' };
  }
  return { action: 'email', priority: 'med', reason: 'Maintain momentum with a follow-up.', suggested_template_id: null, suggested_when: 'this_week' };
}

function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}

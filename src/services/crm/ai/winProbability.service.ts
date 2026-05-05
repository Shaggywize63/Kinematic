/**
 * Win-probability: heuristic baseline + Haiku-generated explanation.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';

export async function compute(org_id: string, deal_id: string): Promise<{ probability: number; reasoning: string }> {
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('*')
    .eq('org_id', org_id).eq('id', deal_id).is('deleted_at', null).maybeSingle();
  if (!deal) return { probability: 0, reasoning: 'Deal not found.' };

  const { data: stage } = await supabaseAdmin.from('crm_deal_stages').select('probability, stage_type')
    .eq('id', deal.stage_id).single();
  if (stage?.stage_type === 'won') return persist(org_id, deal_id, 100, 'Deal already won.');
  if (stage?.stage_type === 'lost') return persist(org_id, deal_id, 0, 'Deal already lost.');

  const stageProb = Number(stage?.probability ?? 50);
  const ageDays = (Date.now() - new Date(deal.created_at).getTime()) / 86400000;
  const agePenalty = ageDays > 90 ? 0.7 : ageDays > 60 ? 0.85 : 1.0;

  const { count: activityCount } = await supabaseAdmin.from('crm_activities')
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', deal_id).eq('org_id', org_id)
    .gte('completed_at', new Date(Date.now() - 30 * 86400000).toISOString());
  const engagement = Math.min(1.5, 0.7 + (activityCount ?? 0) * 0.1);

  let baseline = Math.round(stageProb * agePenalty * engagement);
  baseline = Math.max(0, Math.min(100, baseline));

  let reasoning = `Stage probability ${stageProb}% × age factor ${agePenalty.toFixed(2)} × engagement ${engagement.toFixed(2)} → ${baseline}%.`;

  try {
    const llm = await aiComplete({
      org_id,
      model: process.env.CRM_NBA_MODEL || 'claude-haiku-4-5',
      system: 'You explain win probability for a sales deal in 1-2 sentences. Be concrete. No JSON, plain text.',
      messages: [{ role: 'user', content: JSON.stringify({ deal: { name: deal.name, amount: deal.amount, age_days: Math.round(ageDays), activities_30d: activityCount }, baseline }) }],
      max_tokens: 120,
    });
    if (llm && llm.trim().length > 0) reasoning = llm.trim().slice(0, 400);
  } catch { /* keep heuristic reasoning */ }

  return persist(org_id, deal_id, baseline, reasoning);
}

async function persist(org_id: string, deal_id: string, p: number, reasoning: string) {
  await supabaseAdmin.from('crm_deals').update({
    win_probability_ai: p,
    win_probability_reasoning: reasoning,
    win_probability_updated_at: new Date().toISOString(),
  }).eq('id', deal_id).eq('org_id', org_id);
  return { probability: p, reasoning };
}

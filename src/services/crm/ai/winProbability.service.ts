/**
 * Win-probability: heuristic baseline + Haiku-generated explanation.
 *
 * In addition to a single `probability` number + `reasoning` sentence,
 * we return a structured `breakdown` so the UI can render a
 * "How is this calculated?" explainer. Each factor includes both the
 * raw value (e.g. "45 days") and the multiplier applied (e.g. 1.0), so
 * the user sees how the math arrived at the final figure — important
 * for trust when the answer is 100% or 0%.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';

export interface WinProbabilityBreakdown {
  /** Set when the stage is `won` / `lost` and the figure is locked. */
  short_circuit?: 'won' | 'lost';
  /** Human-friendly explanation for the locked case. */
  short_circuit_message?: string;
  /** Stage's configured probability (0–100). */
  stage_probability: number;
  stage_name: string | null;
  age_days: number;
  age_multiplier: number;
  age_label: string;
  activities_30d: number;
  engagement_multiplier: number;
  engagement_label: string;
  /** Single-line maths string, e.g. "50% × 1.00 × 1.20 = 60%". */
  formula_text: string;
  final_probability: number;
}

export interface WinProbabilityResult {
  probability: number;
  reasoning: string;
  breakdown: WinProbabilityBreakdown;
}

export async function compute(org_id: string, deal_id: string): Promise<WinProbabilityResult> {
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('*')
    .eq('org_id', org_id).eq('id', deal_id).is('deleted_at', null).maybeSingle();
  if (!deal) {
    return {
      probability: 0,
      reasoning: 'Deal not found.',
      breakdown: emptyBreakdown('Deal not found.'),
    };
  }

  const { data: stage } = await supabaseAdmin.from('crm_deal_stages')
    .select('name, probability, stage_type')
    .eq('id', deal.stage_id).single();

  // Won / lost stages short-circuit the heuristic. We still emit a full
  // breakdown so the UI can show "Locked at 100% because the deal is
  // already in stage X" without a separate code path.
  if (stage?.stage_type === 'won') {
    const reason = `Deal already won (stage: ${stage.name}).`;
    return persist(org_id, deal_id, 100, reason, {
      short_circuit: 'won',
      short_circuit_message: reason,
      stage_probability: 100,
      stage_name: stage.name,
      age_days: Math.round((Date.now() - new Date(deal.created_at).getTime()) / 86400000),
      age_multiplier: 1,
      age_label: 'Not applied — deal already closed.',
      activities_30d: 0,
      engagement_multiplier: 1,
      engagement_label: 'Not applied — deal already closed.',
      formula_text: 'Final stage is "Won" → probability fixed at 100%.',
      final_probability: 100,
    });
  }
  if (stage?.stage_type === 'lost') {
    const reason = `Deal already lost (stage: ${stage.name}).`;
    return persist(org_id, deal_id, 0, reason, {
      short_circuit: 'lost',
      short_circuit_message: reason,
      stage_probability: 0,
      stage_name: stage.name,
      age_days: Math.round((Date.now() - new Date(deal.created_at).getTime()) / 86400000),
      age_multiplier: 1,
      age_label: 'Not applied — deal already closed.',
      activities_30d: 0,
      engagement_multiplier: 1,
      engagement_label: 'Not applied — deal already closed.',
      formula_text: 'Final stage is "Lost" → probability fixed at 0%.',
      final_probability: 0,
    });
  }

  const stageProb = Number(stage?.probability ?? 50);
  const ageDays = Math.round((Date.now() - new Date(deal.created_at).getTime()) / 86400000);
  const agePenalty = ageDays > 90 ? 0.7 : ageDays > 60 ? 0.85 : 1.0;
  const ageLabel = ageDays > 90
    ? `Over 90 days old — heavy penalty (×0.70)`
    : ageDays > 60
      ? `Between 60–90 days — moderate penalty (×0.85)`
      : `Under 60 days — no penalty (×1.00)`;

  const { count: activityCount } = await supabaseAdmin.from('crm_activities')
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', deal_id).eq('org_id', org_id)
    .gte('completed_at', new Date(Date.now() - 30 * 86400000).toISOString());
  const actCnt = activityCount ?? 0;
  const engagement = Math.min(1.5, 0.7 + actCnt * 0.1);
  const engagementLabel = actCnt === 0
    ? 'No activities in the last 30 days (×0.70)'
    : actCnt >= 8
      ? `${actCnt} activities in last 30 days — capped at ×1.50`
      : `${actCnt} ${actCnt === 1 ? 'activity' : 'activities'} in last 30 days (×${engagement.toFixed(2)})`;

  let baseline = Math.round(stageProb * agePenalty * engagement);
  baseline = Math.max(0, Math.min(100, baseline));

  const formulaText = `${stageProb}% × ${agePenalty.toFixed(2)} (age) × ${engagement.toFixed(2)} (engagement) = ${baseline}%`;
  let reasoning = `Stage probability ${stageProb}% × age factor ${agePenalty.toFixed(2)} × engagement ${engagement.toFixed(2)} → ${baseline}%.`;

  try {
    const llm = await aiComplete({
      org_id,
      model: process.env.CRM_NBA_MODEL || 'claude-haiku-4-5-20251001',
      system: 'You explain win probability for a sales deal in 1-2 sentences. Be concrete. No JSON, plain text.',
      messages: [{ role: 'user', content: JSON.stringify({ deal: { name: deal.name, amount: deal.amount, age_days: ageDays, activities_30d: actCnt }, baseline }) }],
      max_tokens: 120,
    });
    if (llm && llm.trim().length > 0) reasoning = llm.trim().slice(0, 400);
  } catch { /* keep heuristic reasoning */ }

  return persist(org_id, deal_id, baseline, reasoning, {
    stage_probability: stageProb,
    stage_name: stage?.name ?? null,
    age_days: ageDays,
    age_multiplier: agePenalty,
    age_label: ageLabel,
    activities_30d: actCnt,
    engagement_multiplier: engagement,
    engagement_label: engagementLabel,
    formula_text: formulaText,
    final_probability: baseline,
  });
}

function emptyBreakdown(msg: string): WinProbabilityBreakdown {
  return {
    stage_probability: 0,
    stage_name: null,
    age_days: 0,
    age_multiplier: 1,
    age_label: msg,
    activities_30d: 0,
    engagement_multiplier: 1,
    engagement_label: msg,
    formula_text: msg,
    final_probability: 0,
  };
}

async function persist(
  org_id: string,
  deal_id: string,
  p: number,
  reasoning: string,
  breakdown: WinProbabilityBreakdown,
): Promise<WinProbabilityResult> {
  await supabaseAdmin.from('crm_deals').update({
    win_probability_ai: p,
    win_probability_reasoning: reasoning,
    win_probability_updated_at: new Date().toISOString(),
  }).eq('id', deal_id).eq('org_id', org_id);
  return { probability: p, reasoning, breakdown };
}

/**
 * Call Insights → CRM signal bridge.
 *
 * Turns the latest analyzed call recording for a lead (conversation_recordings.
 * insights, produced by conversationIntel.service) into bounded signals the
 * lead score, Next Best Action and win-probability engines can consume.
 *
 * MODULE GATING (important): the only source here is `conversation_recordings`,
 * and a recording exists ONLY for clients with the Call Insights
 * (`crm_conversation_intel`) module — every other tenant has zero rows, so
 * `getLatestCallInsight` returns null and the score / NBA / win-prob code paths
 * that call it are exact no-ops. That is how the linkage stays scoped to
 * Call-Insights clients without touching the shared engines' behaviour for
 * anyone else. Every read is best-effort and never throws.
 */
import { supabaseAdmin } from '../../../lib/supabase';

export interface CallInsightSignal {
  recording_id: string;
  analyzed_at: string;
  intent_stage: string | null;
  intent_score: number | null;            // 0–100, clamped
  sentiment: 'positive' | 'neutral' | 'negative';
  has_commitments: boolean;
  objection_count: number;
  risk_flag_count: number;
  next_action: string | null;
  summary: string | null;
}

function normSentiment(s: unknown): 'positive' | 'neutral' | 'negative' {
  const t = String(s ?? '').toLowerCase();
  if (/(positive|good|warm|hot|high|happy)/.test(t)) return 'positive';
  if (/(negative|poor|cold|bad|low|angry|frustrat|unhappy)/.test(t)) return 'negative';
  return 'neutral';
}

/**
 * The latest COMPLETE recording's insights for a lead, or null. Null for every
 * client without the Call Insights module (no recordings) — which is exactly
 * what keeps the lead-score / NBA / win-prob linkage scoped to those clients.
 */
export async function getLatestCallInsight(
  org_id: string,
  lead_id: string | null | undefined,
): Promise<CallInsightSignal | null> {
  if (!lead_id) return null;
  try {
    const { data } = await supabaseAdmin
      .from('conversation_recordings')
      .select('id, insights, created_at')
      .eq('org_id', org_id)
      .eq('lead_id', lead_id)
      .eq('status', 'complete')
      .not('insights', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const ins = (data as any)?.insights as Record<string, any> | undefined;
    if (!data || !ins || typeof ins !== 'object') return null;
    const rawScore = Number(ins?.intent?.score);
    return {
      recording_id: (data as any).id,
      analyzed_at: (data as any).created_at,
      intent_stage: typeof ins?.intent?.stage === 'string' ? ins.intent.stage : null,
      intent_score: Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : null,
      sentiment: normSentiment(ins?.sentiment?.overall),
      has_commitments: Array.isArray(ins?.commitments) && ins.commitments.length > 0,
      objection_count: Array.isArray(ins?.objections) ? ins.objections.length : 0,
      risk_flag_count: Array.isArray(ins?.risk_flags) ? ins.risk_flags.length : 0,
      next_action: typeof ins?.next_action === 'string' ? ins.next_action : null,
      summary: typeof ins?.summary === 'string' ? ins.summary : null,
    };
  } catch {
    return null;
  }
}

/**
 * Bounded (0–18) lead-score contribution from the latest call. Only POSITIVE
 * signals add points — a call never silently drags a lead's score down, it just
 * adds credit for a real, high-intent, positive conversation with commitments.
 */
export function callInsightScorePoints(sig: CallInsightSignal): number {
  let pts = 0;
  if (sig.intent_score != null) {
    pts += sig.intent_score >= 70 ? 12 : sig.intent_score >= 40 ? 7 : sig.intent_score >= 1 ? 3 : 0;
  }
  if (sig.sentiment === 'positive') pts += 4;
  if (sig.has_commitments) pts += 4;
  return Math.max(0, Math.min(18, pts));
}

/**
 * Win-probability multiplier (bounded 0.85–1.20) from the latest call — a strong
 * positive call lifts the deal's odds, a hostile low-intent one trims them.
 */
export function callInsightWinMultiplier(sig: CallInsightSignal): { multiplier: number; label: string } {
  let m = 1.0;
  if (sig.intent_score != null) {
    if (sig.intent_score >= 70) m += 0.15;
    else if (sig.intent_score >= 40) m += 0.07;
    else if (sig.intent_score < 20) m -= 0.1;
  }
  if (sig.sentiment === 'positive') m += 0.05;
  else if (sig.sentiment === 'negative') m -= 0.1;
  m = Math.max(0.85, Math.min(1.2, Math.round(m * 100) / 100));
  const label = `Latest call: ${sig.intent_stage ?? 'intent n/a'} (score ${sig.intent_score ?? '—'}), ${sig.sentiment} → ×${m.toFixed(2)}`;
  return { multiplier: m, label };
}

/** Compact block to drop into an NBA / LLM payload (and the methodology modal). */
export function callInsightPayload(sig: CallInsightSignal) {
  return {
    analyzed_at: sig.analyzed_at,
    intent_stage: sig.intent_stage,
    intent_score: sig.intent_score,
    sentiment: sig.sentiment,
    has_commitments: sig.has_commitments,
    objections: sig.objection_count,
    risk_flags: sig.risk_flag_count,
    next_action: sig.next_action,
    summary: sig.summary ? sig.summary.slice(0, 400) : null,
  };
}

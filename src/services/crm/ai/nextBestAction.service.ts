/**
 * Next-best-action recommender.
 *
 * Pulls deal state + recent activities + stage transition history and asks
 * Claude Haiku for both a single recommended action AND a 3–5 step closing
 * plan so reps can see *why* this is the right next move and *what comes
 * after*. Cached 6h on the deal unless `force=true`.
 *
 * The response includes a structured `methodology` object — signals
 * considered + the closing plan — which the UI renders in a
 * "How is this calculated?" explainer modal (mirrors Win Probability).
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';
import type { NextBestAction } from '../../../types/crm.types';

const SYSTEM_PROMPT = `You are a sales coach. Given a deal's current state, recent activity, stage history, days in stage, and win probability, recommend ONE immediate next action AND a step-by-step closing plan.
NEVER suggest "email" — Kinematic's customers prefer phone / WhatsApp / in-person.
The closing plan should be 3-5 concrete steps the rep should execute, in order, to move this deal to Won. Each step gets a "when" (now / today / this_week / next_week).

Output JSON only, no prose:
{
  "action": "call" | "meeting" | "send_proposal" | "nurture" | "disqualify",
  "priority": "high" | "medium" | "low",
  "reason": "1-2 sentence rationale for the immediate action (<= 220 chars)",
  "suggested_when": "now" | "today" | "this_week" | "next_week",
  "suggested_template_id": null,
  "closing_plan": [
    {"step": 1, "action": "concrete step the rep should take", "rationale": "why this step now (<= 140 chars)", "when": "now" | "today" | "this_week" | "next_week"}
  ]
}`;

type RawActivity = { type: string; subject: string | null; completed_at: string | null; status: string | null };
type RawHistory = { from_stage_id: string | null; to_stage_id: string | null; changed_at: string; time_in_previous_stage_seconds: number | null };

export async function compute(org_id: string, deal_id: string, force = false): Promise<NextBestAction | null> {
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('*')
    .eq('org_id', org_id).eq('id', deal_id).is('deleted_at', null).maybeSingle();
  if (!deal) return null;

  const cacheAgeMs = deal.next_action_updated_at ? Date.now() - new Date(deal.next_action_updated_at).getTime() : Infinity;
  if (!force && cacheAgeMs < 6 * 60 * 60 * 1000 && deal.next_action_ai) {
    return deal.next_action_ai as NextBestAction;
  }

  // Recent activities + stage info + history all inform the recommendation
  // and the methodology summary returned to the UI.
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: recent }, { data: stage }, { data: history }] = await Promise.all([
    supabaseAdmin.from('crm_activities')
      .select('type, subject, completed_at, status')
      .eq('org_id', org_id).eq('deal_id', deal_id).is('deleted_at', null)
      .gte('completed_at', since30d)
      .order('completed_at', { ascending: false }).limit(20),
    supabaseAdmin.from('crm_deal_stages').select('name, probability, stage_type')
      .eq('id', deal.stage_id).maybeSingle(),
    supabaseAdmin.from('crm_deal_history')
      .select('from_stage_id, to_stage_id, changed_at, time_in_previous_stage_seconds')
      .eq('org_id', org_id).eq('deal_id', deal_id)
      .order('changed_at', { ascending: false }).limit(15),
  ]);

  const signals = buildSignals(deal, stage as any, (recent ?? []) as RawActivity[], (history ?? []) as RawHistory[]);

  const userPayload = {
    deal: {
      name: deal.name, amount: deal.amount, currency: deal.currency,
      expected_close_date: deal.expected_close_date,
      created_at: deal.created_at,
      win_probability_ai: deal.win_probability_ai,
    },
    stage,
    signals,
    recent_activities: (recent ?? []).map((a) => ({
      type: a.type, subject: a.subject, when: a.completed_at, status: a.status,
    })),
  };

  let nba: NextBestAction;
  try {
    const response = await aiComplete({
      org_id,
      model: process.env.CRM_NBA_MODEL || 'claude-haiku-4-5-20251001',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 600,
    });
    const parsed = JSON.parse(extractJson(response));
    // Coerce slip-throughs: prompt says no email, but if the model still
    // returns it, fall back to phone (Kinematic's primary channel).
    const action = parsed.action === 'email' ? 'call' : parsed.action;
    const closingPlan = Array.isArray(parsed.closing_plan)
      ? parsed.closing_plan.slice(0, 5).map((s: any, i: number) => ({
          step: Number(s.step ?? i + 1),
          action: String(s.action ?? '').slice(0, 200),
          rationale: String(s.rationale ?? '').slice(0, 200),
          when: ['now', 'today', 'this_week', 'next_week'].includes(s.when) ? s.when : 'this_week',
        }))
      : [];

    nba = {
      action,
      priority: parsed.priority,
      reason: String(parsed.reason ?? '').slice(0, 220),
      suggested_template_id: parsed.suggested_template_id ?? null,
      suggested_when: parsed.suggested_when ?? 'this_week',
      methodology: { signals, closing_plan: closingPlan, reasoning: String(parsed.reason ?? '').slice(0, 220) },
    } as NextBestAction;
  } catch {
    nba = fallback(deal, stage as any, signals, (recent ?? []) as RawActivity[]);
  }

  await supabaseAdmin.from('crm_deals').update({
    next_action_ai: nba, next_action_updated_at: new Date().toISOString(),
  }).eq('id', deal_id).eq('org_id', org_id);

  return nba;
}

/**
 * Build the structured signals object — these are the inputs the model
 * considered AND what the UI surfaces in the "How?" modal so the rep
 * understands *why* this recommendation was made.
 */
function buildSignals(
  deal: any,
  stage: { name?: string; probability?: number; stage_type?: string } | null,
  recent: RawActivity[],
  history: RawHistory[],
) {
  const now = Date.now();
  const dealAgeDays = Math.max(0, Math.round((now - new Date(deal.created_at).getTime()) / 86_400_000));

  // Stage entry timestamp = most recent stage_changed history row, else deal.created_at.
  const stageEntry = history.find((h) => h.from_stage_id !== h.to_stage_id);
  const daysInStage = stageEntry
    ? Math.round((now - new Date(stageEntry.changed_at).getTime()) / 86_400_000)
    : dealAgeDays;

  // Activity aggregation over the 30-day window.
  const byType: Record<string, number> = {};
  let lastActivityAt: string | null = null;
  let lastActivityType: string | null = null;
  for (const a of recent) {
    byType[a.type] = (byType[a.type] ?? 0) + 1;
    if (!lastActivityAt && a.completed_at) {
      lastActivityAt = a.completed_at;
      lastActivityType = a.type;
    }
  }
  const daysSinceLastTouch = lastActivityAt
    ? Math.floor((now - new Date(lastActivityAt).getTime()) / 86_400_000)
    : null;

  return {
    stage: stage
      ? { name: stage.name ?? null, type: stage.stage_type ?? null, probability: Number(stage.probability ?? 0) }
      : null,
    days_in_stage: daysInStage,
    deal_age_days: dealAgeDays,
    win_probability: deal.win_probability_ai != null ? Number(deal.win_probability_ai) : null,
    activities_30d_total: recent.length,
    activities_30d_by_type: byType,
    last_activity_at: lastActivityAt,
    last_activity_type: lastActivityType,
    days_since_last_touch: daysSinceLastTouch,
    stage_transitions: history.filter((h) => h.from_stage_id !== h.to_stage_id).length,
  };
}

/**
 * Deterministic fallback when Claude is unavailable or returns bad JSON.
 * Builds a plausible closing plan from the signals so the UI never shows
 * an empty card — and so the methodology modal still has content.
 */
function fallback(
  deal: any,
  stage: { name?: string; probability?: number; stage_type?: string } | null,
  signals: ReturnType<typeof buildSignals>,
  recent: RawActivity[],
): NextBestAction {
  const stageType = stage?.stage_type;

  if (stageType === 'won' || stageType === 'lost') {
    return {
      action: 'nurture',
      priority: 'low',
      reason: 'Deal already closed.',
      suggested_template_id: null,
      suggested_when: 'next_week',
      methodology: {
        signals,
        closing_plan: [
          { step: 1, action: 'Send a thank-you / debrief note', rationale: 'Maintains the relationship for future opportunities.', when: 'this_week' },
        ],
        reasoning: 'Deal already closed — no further closing actions required.',
      },
    } as NextBestAction;
  }

  if (recent.length === 0) {
    return {
      action: 'call',
      priority: 'high',
      reason: 'No recent activity. Reach out today to re-engage.',
      suggested_template_id: null,
      suggested_when: 'today',
      methodology: {
        signals,
        closing_plan: [
          { step: 1, action: 'Call the primary contact to re-establish momentum', rationale: 'Zero activity in 30 days — must reconnect before deal goes cold.', when: 'today' },
          { step: 2, action: 'Send a follow-up WhatsApp summarising the call', rationale: 'Keeps the conversation alive on the channel the customer prefers.', when: 'today' },
          { step: 3, action: 'Schedule a discovery / demo meeting', rationale: 'Move the deal forward in the pipeline.', when: 'this_week' },
        ],
        reasoning: 'Heuristic: zero touches in 30 days at this stage signals deal-decay risk.',
      },
    } as NextBestAction;
  }

  return {
    action: 'call',
    priority: 'medium',
    reason: 'Maintain momentum with a follow-up.',
    suggested_template_id: null,
    suggested_when: 'this_week',
    methodology: {
      signals,
      closing_plan: [
        { step: 1, action: 'Call to confirm next milestone', rationale: 'Last touch was a ' + (signals.last_activity_type ?? 'recent') + ' — keep moving.', when: 'this_week' },
        { step: 2, action: 'Send proposal or revised pricing if applicable', rationale: 'Get something concrete in the buyer\'s hands.', when: 'this_week' },
        { step: 3, action: 'Schedule a decision-maker meeting', rationale: 'Surface objections early.', when: 'next_week' },
      ],
      reasoning: 'Heuristic fallback — AI service unavailable.',
    },
  } as NextBestAction;
}

function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}

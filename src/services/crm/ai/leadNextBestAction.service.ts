/**
 * Next-best-action recommender — leads variant.
 *
 * Mirrors src/services/crm/ai/nextBestAction.service.ts (which handles deals)
 * but pulls lead state + recent activities + recent Updates and asks Claude
 * Haiku for the single recommended action plus a 3-5 step nurture/qualify
 * plan. Cached 6h on the lead unless force=true.
 *
 * The recent free-form Updates timeline (crm_lead_updates) feeds directly
 * into the prompt — so when a rep writes "Customer asked for proposal by
 * Friday" the next NBA call sees that signal and adapts.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';

const SYSTEM_PROMPT = `You are a sales coach. Given a lead's current state, recent activity, recent free-form updates from the rep, and score, recommend ONE immediate next action AND a step-by-step qualification/nurture plan.

Constraints on every step:
- The action must be something the rep reading this can execute personally. Use imperative voice ("Call the lead", "Send a WhatsApp follow-up", "Schedule a meeting").
- NEVER reference roles or personas that aren't explicitly in the data — no "champion", "manager", "advocate", "stakeholder", "decision-maker", "executive sponsor". Refer to the lead by name or as "the lead".
- NEVER suggest "email" — Kinematic's customers prefer phone / WhatsApp / in-person.
- Only the allowed verbs: call, WhatsApp, meet, schedule, send (a doc / quote), qualify, log, follow up. Do not invent new actors.

The plan should be 3-5 concrete steps to move this lead from its current status to qualified or converted. Each step gets a "when" (now / today / this_week / next_week).

Output JSON only, no prose:
{
  "action": "call" | "meeting" | "qualify" | "nurture" | "disqualify",
  "priority": "high" | "medium" | "low",
  "reason": "1-2 sentence rationale for the immediate action (<= 220 chars)",
  "suggested_when": "now" | "today" | "this_week" | "next_week",
  "closing_plan": [
    {"step": 1, "action": "concrete step", "rationale": "why this step now (<= 140 chars)", "when": "now" | "today" | "this_week" | "next_week"}
  ]
}`;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface LeadNextBestAction {
  action: 'call' | 'meeting' | 'qualify' | 'nurture' | 'disqualify';
  priority: 'high' | 'medium' | 'low';
  reason: string;
  suggested_when: 'now' | 'today' | 'this_week' | 'next_week';
  methodology: {
    signals: Record<string, unknown>;
    closing_plan: Array<{ step: number; action: string; rationale: string; when: string }>;
    reasoning: string;
  };
}

type RawActivity = { type: string; subject: string | null; completed_at: string | null; status: string | null };
type RawUpdate = { body: string; created_at: string; author_id: string };

export async function compute(
  org_id: string,
  client_id: string | null,
  lead_id: string,
  force = false,
): Promise<LeadNextBestAction | null> {
  // Hard client isolation — a cross-client lead id resolves to null so its
  // context never reaches the model.
  let leadQ = supabaseAdmin
    .from('crm_leads')
    .select('*')
    .eq('org_id', org_id)
    .eq('id', lead_id)
    .is('deleted_at', null);
  if (client_id) leadQ = leadQ.eq('client_id', client_id);
  const { data: lead } = await leadQ.maybeSingle();
  if (!lead) return null;

  const cacheAgeMs = lead.next_action_updated_at
    ? Date.now() - new Date(lead.next_action_updated_at).getTime()
    : Infinity;
  if (!force && cacheAgeMs < CACHE_TTL_MS && lead.next_action_ai) {
    return lead.next_action_ai as LeadNextBestAction;
  }

  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: recent }, { data: updates }] = await Promise.all([
    supabaseAdmin
      .from('crm_activities')
      .select('type, subject, completed_at, status')
      .eq('org_id', org_id)
      .eq('lead_id', lead_id)
      .is('deleted_at', null)
      .gte('completed_at', since30d)
      .order('completed_at', { ascending: false })
      .limit(20),
    supabaseAdmin
      .from('crm_lead_updates')
      .select('body, created_at, author_id')
      .eq('org_id', org_id)
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const signals = buildSignals(
    lead,
    (recent ?? []) as RawActivity[],
    (updates ?? []) as RawUpdate[],
  );

  const userPayload = {
    lead: {
      name: `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || 'Unnamed',
      company: lead.company,
      title: lead.title,
      industry: lead.industry,
      status: lead.status,
      score: lead.score,
      score_grade: lead.score_grade,
      is_b2c: lead.is_b2c,
      created_at: lead.created_at,
    },
    signals,
    recent_activities: ((recent ?? []) as RawActivity[]).map((a) => ({
      type: a.type,
      subject: a.subject,
      when: a.completed_at,
      status: a.status,
    })),
    recent_updates: ((updates ?? []) as RawUpdate[]).map((u) => ({
      body: u.body,
      when: u.created_at,
    })),
  };

  let nba: LeadNextBestAction;
  try {
    const response = await aiComplete({
      org_id,
      model: process.env.CRM_LEAD_NBA_MODEL || 'claude-haiku-4-5-20251001',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 600,
    });
    const parsed = JSON.parse(extractJson(response));
    // Coerce slip-throughs (prompt says no email; if the model still
    // returns it, fall back to phone).
    const action = parsed.action === 'email' ? 'call' : parsed.action;
    const closing_plan = Array.isArray(parsed.closing_plan)
      ? parsed.closing_plan.slice(0, 5).map((s: any, i: number) => ({
          step: Number(s.step ?? i + 1),
          action: String(s.action ?? '').slice(0, 200),
          rationale: String(s.rationale ?? '').slice(0, 200),
          when: ['now', 'today', 'this_week', 'next_week'].includes(s.when)
            ? s.when
            : 'this_week',
        }))
      : [];
    nba = {
      action,
      priority: parsed.priority || 'medium',
      reason: String(parsed.reason ?? '').slice(0, 220),
      suggested_when: parsed.suggested_when ?? 'this_week',
      methodology: {
        signals,
        closing_plan,
        reasoning: String(parsed.reason ?? '').slice(0, 220),
      },
    };
  } catch {
    nba = fallback(lead, signals, (recent ?? []) as RawActivity[]);
  }

  await supabaseAdmin
    .from('crm_leads')
    .update({
      next_action_ai: nba,
      next_action_updated_at: new Date().toISOString(),
    })
    .eq('id', lead_id)
    .eq('org_id', org_id);

  return nba;
}

function buildSignals(lead: any, recent: RawActivity[], updates: RawUpdate[]) {
  const now = Date.now();
  const ageDays = Math.max(
    0,
    Math.round((now - new Date(lead.created_at).getTime()) / 86_400_000),
  );
  const byType: Record<string, number> = {};
  let lastActivityAt: string | null = null;
  for (const a of recent) {
    byType[a.type] = (byType[a.type] ?? 0) + 1;
    if (!lastActivityAt && a.completed_at) lastActivityAt = a.completed_at;
  }
  const daysSinceLastTouch = lastActivityAt
    ? Math.floor((now - new Date(lastActivityAt).getTime()) / 86_400_000)
    : null;
  const lastUpdateAt = updates[0]?.created_at ?? null;
  const daysSinceLastUpdate = lastUpdateAt
    ? Math.floor((now - new Date(lastUpdateAt).getTime()) / 86_400_000)
    : null;
  return {
    status: lead.status,
    score: lead.score,
    score_grade: lead.score_grade,
    lead_age_days: ageDays,
    activities_30d_total: recent.length,
    activities_30d_by_type: byType,
    days_since_last_touch: daysSinceLastTouch,
    updates_total: updates.length,
    days_since_last_update: daysSinceLastUpdate,
  };
}

function fallback(
  lead: any,
  signals: ReturnType<typeof buildSignals>,
  recent: RawActivity[],
): LeadNextBestAction {
  if (
    lead.status === 'converted' ||
    lead.status === 'lost' ||
    lead.status === 'unqualified'
  ) {
    return {
      action: 'nurture',
      priority: 'low',
      reason: `Lead is ${lead.status}.`,
      suggested_when: 'next_week',
      methodology: {
        signals,
        closing_plan: [
          {
            step: 1,
            action: 'Add to nurture sequence',
            rationale: 'Stay top-of-mind for re-engagement.',
            when: 'next_week',
          },
        ],
        reasoning:
          'Lead is in a terminal status — no active next step required.',
      },
    };
  }
  if (recent.length === 0) {
    return {
      action: 'call',
      priority: 'high',
      reason: 'No recent activity. Reach out today to qualify.',
      suggested_when: 'today',
      methodology: {
        signals,
        closing_plan: [
          {
            step: 1,
            action: 'Call to qualify interest',
            rationale: 'Zero touches — establish contact.',
            when: 'today',
          },
          {
            step: 2,
            action: 'Send a WhatsApp follow-up',
            rationale: "Keep the conversation on customers' preferred channel.",
            when: 'today',
          },
          {
            step: 3,
            action: 'Schedule a discovery meeting',
            rationale: 'Move from lead to qualified.',
            when: 'this_week',
          },
        ],
        reasoning: 'Heuristic: zero touches signals lead-decay risk.',
      },
    };
  }
  return {
    action: 'call',
    priority: 'medium',
    reason: 'Maintain momentum with a follow-up.',
    suggested_when: 'this_week',
    methodology: {
      signals,
      closing_plan: [
        {
          step: 1,
          action: 'Call to confirm next step',
          rationale: 'Keep the lead warm.',
          when: 'this_week',
        },
        {
          step: 2,
          action: 'Send qualifying questions via WhatsApp',
          rationale: 'Reduce time-to-qualify.',
          when: 'this_week',
        },
      ],
      reasoning: 'Heuristic fallback — AI service unavailable.',
    },
  };
}

function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}

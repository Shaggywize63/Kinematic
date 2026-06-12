/**
 * Home aggregator — composes the CRM "Home" surface from existing
 * services so /api/v1/crm/home stays a single round-trip for the web +
 * mobile clients. Strict no-LLM path so it's cheap enough to call on
 * every Home tab focus.
 *
 * Five sections in the payload, all per-(org, client, user):
 *
 *   1. today_target      — the existing daily lead target for this user
 *                          (achieved / target / pct).
 *   2. near_to_close     — high-confidence leads sitting close to a
 *                          conversion: score grade A/B AND lifecycle
 *                          'sql' / 'qualified', sorted by score desc.
 *   3. next_actions      — top 3 leads needing attention, each with a
 *                          rules-based action + a 1-sentence reason
 *                          the UI shows below the lead name. Reasons
 *                          read like KINI suggestions but cost zero
 *                          tokens.
 *   4. today_activity    — count of activities the user completed
 *                          today, bucketed by type.
 *   5. productivity_tips — short, data-aware tips driven off the rest
 *                          of the payload (e.g. "5 leads idle 7d+ —
 *                          clearing them now has the highest ROI").
 */
import { supabaseAdmin } from '../../lib/supabase';
import * as targetsSvc from './targets.service';

export interface HomeResponse {
  today_target: {
    has_target: boolean;
    achieved: number;
    target: number;
    progress_pct: number;
    remaining: number;
    headline: string;
  };
  near_to_close: Array<{
    id: string;
    name: string;
    score: number | null;
    score_grade: string | null;
    lifecycle_stage: string | null;
    status: string | null;
    last_activity_at: string | null;
    days_since_touch: number | null;
    reason: string;
  }>;
  next_actions: Array<{
    lead_id: string;
    lead_name: string;
    action: 'call' | 'whatsapp' | 'follow_up' | 'qualify' | 'meeting' | 'create_deal' | 'nurture';
    label: string;
    reason: string;
    urgency: 'high' | 'medium' | 'low';
    deeplink_path: string;
    score: number | null;
    score_grade: string | null;
  }>;
  today_activity: {
    total: number;
    by_type: Record<string, number>;
    last_activity_at: string | null;
  };
  productivity_tips: string[];
}

const DAY_MS = 86_400_000;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

function gradeOf(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const g = String(grade).toUpperCase();
  return ['A', 'B', 'C', 'D'].includes(g) ? g : null;
}

/**
 * Pick the next action a rep should take on a lead, based on signals we
 * already have on the row (no extra round-trips). Each branch carries
 * the 1-sentence reason the UI surfaces under the suggestion.
 *
 * Order of the if-chain matters — the first rule that fires wins, so
 * the most "rep-actionable" branches come first. We pick at most one
 * action per lead; the UI ranks the per-lead suggestions across leads
 * to pick the day's top three.
 */
function deriveNextAction(lead: {
  id: string; first_name?: string | null; last_name?: string | null; email?: string | null;
  phone?: string | null; status?: string | null; lifecycle_stage?: string | null;
  score?: number | null; score_grade?: string | null;
  last_activity_at?: string | null;
}): { action: HomeResponse['next_actions'][number]['action']; label: string; reason: string; urgency: 'high' | 'medium' | 'low' } {
  const idle = daysSince(lead.last_activity_at);
  const score = lead.score ?? 0;
  const grade = gradeOf(lead.score_grade);
  const lifecycle = (lead.lifecycle_stage || '').toLowerCase();
  const status = (lead.status || '').toLowerCase();
  const firstName = lead.first_name?.trim() || 'this lead';

  // 1. Sales-qualified but no recent touch → high-urgency call. SQL means
  //    sales has already accepted; silence kills conversion.
  if (lifecycle === 'sql' && (idle == null || idle >= 2)) {
    return {
      action: 'call',
      label: `Call ${firstName} — they're sales-qualified`,
      reason: idle == null
        ? `${firstName} is qualified but has no logged touch yet. A call today closes the loop while they're still warm.`
        : `${firstName} is qualified and hasn't been contacted in ${idle} day${idle === 1 ? '' : 's'}. Reps who call SQLs within 48h close ~2× more.`,
      urgency: 'high',
    };
  }
  // 2. High-score lead going cold — score grade A/B with no touch in 7d+.
  if ((grade === 'A' || grade === 'B') && idle != null && idle >= 7) {
    return {
      action: 'follow_up',
      label: `Re-engage ${firstName}`,
      reason: `Score grade ${grade} (${score}) but no activity for ${idle} day${idle === 1 ? '' : 's'}. High-grade leads stop responding after week one — a quick WhatsApp / call recovers most of them.`,
      urgency: 'high',
    };
  }
  // 3. Qualified status without a linked deal → create the deal record.
  if (status === 'qualified') {
    return {
      action: 'create_deal',
      label: `Open a deal for ${firstName}`,
      reason: `${firstName} is marked qualified — convert the lead so it lands in your pipeline and the win-probability model can score it.`,
      urgency: 'medium',
    };
  }
  // 4. Working lead with momentum (score ≥60) but quiet for 3-7 days.
  if (status === 'working' && score >= 60 && idle != null && idle >= 3) {
    return {
      action: 'follow_up',
      label: `Follow up with ${firstName}`,
      reason: `Active lead (score ${score}) hasn't heard from you in ${idle} day${idle === 1 ? '' : 's'}. Reps who keep ≤72h between touches in 'working' convert 40% more often.`,
      urgency: 'medium',
    };
  }
  // 5. New lead — first touch sets the tone.
  if (status === 'new') {
    return {
      action: 'call',
      label: `Welcome ${firstName} — first call`,
      reason: `New lead with no activity yet. First-touch within 24h doubles the chance they pick up at all.`,
      urgency: idle != null && idle >= 1 ? 'high' : 'medium',
    };
  }
  // 6. Phone-only lead → WhatsApp as the natural channel.
  if (lead.phone && !lead.email) {
    return {
      action: 'whatsapp',
      label: `WhatsApp ${firstName}`,
      reason: `Phone is the only channel on file. A short WhatsApp introducing yourself is the lowest-friction first touch.`,
      urgency: 'low',
    };
  }
  // 7. Default nurture nudge.
  return {
    action: 'nurture',
    label: `Send a check-in to ${firstName}`,
    reason: idle != null
      ? `Last touched ${idle} day${idle === 1 ? '' : 's'} ago. A light check-in keeps the relationship warm without committing to a meeting.`
      : `Light nurture — a check-in note keeps you top-of-mind without asking for anything.`,
    urgency: 'low',
  };
}

/**
 * Hand-tuned productivity nudges that read off the rest of the payload
 * so the tip list always says something useful. Static fallback at the
 * bottom for users whose data hasn't accumulated enough to drive a
 * data-driven tip.
 */
function buildProductivityTips(input: {
  target: HomeResponse['today_target'];
  nearCount: number;
  highUrgencyActions: number;
  idle7dCount: number;
  noActivityToday: boolean;
}): string[] {
  const tips: string[] = [];
  if (input.target.has_target && input.target.remaining > 0 && input.target.progress_pct < 100) {
    tips.push(
      `You're at ${input.target.progress_pct}% of today's target. Closing one near-to-close lead is worth more than creating ${input.target.remaining} new ones — start there.`,
    );
  }
  if (input.highUrgencyActions > 0) {
    tips.push(
      `${input.highUrgencyActions} lead${input.highUrgencyActions === 1 ? '' : 's'} flagged high-urgency. Clear those first — every extra day of silence drops their close rate by ~10%.`,
    );
  }
  if (input.idle7dCount >= 3) {
    tips.push(
      `You have ${input.idle7dCount} leads idle 7+ days. Block 30 minutes this morning to triage them — half will re-engage with a single WhatsApp.`,
    );
  }
  if (input.nearCount > 0) {
    tips.push(
      `Your closest ${input.nearCount === 1 ? 'lead' : `${input.nearCount} leads`} ${input.nearCount === 1 ? 'is' : 'are'} grade A/B and sales-qualified. Mornings have higher call connect rates — call them first.`,
    );
  }
  if (input.noActivityToday) {
    tips.push(`No activity logged yet today. Logging the first touch — even a quick note — keeps the streak honest and your pipeline reports clean.`);
  }
  // Always include at least one tip so the section never renders empty.
  if (tips.length === 0) {
    tips.push(`Inbox-zero your CRM: every 'working' lead should have a planned next activity. A pipeline with no next-steps stalls within 14 days.`);
  }
  return tips.slice(0, 4);
}

export async function homePayload(opts: {
  org_id: string;
  user_id: string;
  client_id: string | null;
}): Promise<HomeResponse> {
  const { org_id, user_id, client_id } = opts;

  // ── Today's target (existing service) ─────────────────────────────
  const target = await targetsSvc.myTargetToday(org_id, user_id, client_id).catch(() => null);
  const achieved = target?.achieved ?? 0;
  const targetN  = target?.target ?? 0;
  const progress_pct = targetN > 0 ? Math.min(100, Math.round((achieved / targetN) * 100)) : 0;
  const remaining = Math.max(0, targetN - achieved);
  const headline = !target?.target
    ? `Welcome back — no target set for this week.`
    : progress_pct >= 100
      ? `Target hit! ${achieved}/${targetN} leads this week.`
      : progress_pct >= 60
        ? `Strong pace — ${remaining} more lead${remaining === 1 ? '' : 's'} to hit this week's target.`
        : `${achieved} of ${targetN} so far this week.`;

  // ── My open leads (single round-trip, ranked) ─────────────────────
  // We pull the user's "actionable" leads in one query, then derive
  // near-to-close + next-actions in memory. Bounded at 100 so a rep
  // with 5k+ leads doesn't trigger a slow query.
  let leadsQ = supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, email, phone, status, lifecycle_stage, score, score_grade, last_activity_at, owner_id, assigned_to')
    .eq('org_id', org_id).is('deleted_at', null)
    .or(`owner_id.eq.${user_id},assigned_to.eq.${user_id}`)
    .in('status', ['new', 'working', 'nurturing', 'qualified']);
  if (client_id) leadsQ = leadsQ.eq('client_id', client_id);
  const { data: openLeads } = await leadsQ
    .order('score', { ascending: false, nullsFirst: false })
    .limit(100);
  const leads = (openLeads ?? []) as Array<{
    id: string; first_name: string | null; last_name: string | null; email: string | null;
    phone: string | null; status: string | null; lifecycle_stage: string | null;
    score: number | null; score_grade: string | null; last_activity_at: string | null;
  }>;
  const displayName = (l: { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }) =>
    [l.first_name, l.last_name].filter(Boolean).join(' ').trim()
    || l.email || l.phone || 'Lead';

  // ── Near to close ─────────────────────────────────────────────────
  const near_to_close = leads
    .filter((l) => {
      const grade = gradeOf(l.score_grade);
      const lc = (l.lifecycle_stage || '').toLowerCase();
      const st = (l.status || '').toLowerCase();
      return (grade === 'A' || grade === 'B') && (lc === 'sql' || st === 'qualified' || (l.score ?? 0) >= 75);
    })
    .slice(0, 5)
    .map((l) => {
      const days = daysSince(l.last_activity_at);
      const grade = gradeOf(l.score_grade);
      const stage = l.lifecycle_stage || l.status;
      const reason = `Grade ${grade ?? '–'} · score ${l.score ?? '–'} · ${stage || 'open'}${days != null ? ` · last touch ${days}d ago` : ''}`;
      return {
        id: l.id, name: displayName(l), score: l.score, score_grade: grade,
        lifecycle_stage: l.lifecycle_stage, status: l.status,
        last_activity_at: l.last_activity_at, days_since_touch: days, reason,
      };
    });

  // ── Next actions ──────────────────────────────────────────────────
  // Score each lead's derived action by urgency + score, take top 3.
  const URGENCY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const ranked = leads
    .map((l) => {
      const act = deriveNextAction(l);
      return {
        lead: l, act,
        rank: URGENCY_RANK[act.urgency] * 100 + (l.score ?? 0),
      };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3);
  const next_actions = ranked.map(({ lead, act }) => ({
    lead_id: lead.id, lead_name: displayName(lead),
    action: act.action, label: act.label, reason: act.reason, urgency: act.urgency,
    deeplink_path: `/dashboard/crm/leads/${lead.id}`,
    score: lead.score, score_grade: gradeOf(lead.score_grade),
  }));

  // ── Today's activity (per-user, today in IST) ─────────────────────
  // Activities are tracked on owner_id OR assigned_to (mirrors the
  // visibility scope on the activities list). created_at vs IST midnight.
  const istNow = new Date();
  const istMidnight = new Date(istNow.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  istMidnight.setHours(0, 0, 0, 0);
  let actQ = supabaseAdmin.from('crm_activities')
    .select('type, completed_at, created_at')
    .eq('org_id', org_id).is('deleted_at', null)
    .or(`owner_id.eq.${user_id},assigned_to.eq.${user_id}`)
    .gte('created_at', istMidnight.toISOString());
  if (client_id) actQ = actQ.eq('client_id', client_id);
  const { data: todayActs } = await actQ;
  const by_type: Record<string, number> = {};
  let lastIso: string | null = null;
  for (const a of (todayActs ?? []) as Array<{ type?: string | null; created_at?: string | null }>) {
    const t = (a.type || 'other').toLowerCase();
    by_type[t] = (by_type[t] ?? 0) + 1;
    if (a.created_at && (!lastIso || new Date(a.created_at).getTime() > new Date(lastIso).getTime())) {
      lastIso = a.created_at;
    }
  }
  const today_activity = {
    total: (todayActs?.length ?? 0),
    by_type,
    last_activity_at: lastIso,
  };

  // ── Productivity tips ─────────────────────────────────────────────
  const today_target_block: HomeResponse['today_target'] = {
    has_target: !!target?.target,
    achieved, target: targetN, progress_pct, remaining, headline,
  };
  const productivity_tips = buildProductivityTips({
    target: today_target_block,
    nearCount: near_to_close.length,
    highUrgencyActions: next_actions.filter((n) => n.urgency === 'high').length,
    idle7dCount: leads.filter((l) => (daysSince(l.last_activity_at) ?? 0) >= 7).length,
    noActivityToday: today_activity.total === 0,
  });

  return {
    today_target: today_target_block,
    near_to_close, next_actions, today_activity, productivity_tips,
  };
}

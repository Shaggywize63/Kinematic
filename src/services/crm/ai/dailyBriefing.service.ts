/**
 * Daily AI briefing — KINI's morning "here's what to focus on" for a rep.
 *
 * gatherRepContext() pulls a rep-scoped snapshot (activities due today, overdue
 * count + a few subjects, open-lead count, and the hottest leads going cold),
 * generateBriefing() turns it into 2-3 sentences via a single-shot Haiku call
 * (NOT the agentic chat loop, so it never touches the KINI monthly quota), and
 * runDailyBriefings() fans out a once-per-rep-per-day push by inserting a
 * notifications row — which the existing dispatcher delivers over FCM (Android)
 * / APNs (iOS). Dedup is the crm_daily_briefing_log unique (user_id, date).
 *
 * On any AI error the briefing degrades to a deterministic templated summary,
 * so the rep always gets a useful nudge.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';
import { logger } from '../../../lib/logger';

export interface RepContext {
  date: string;
  today: number;
  overdue: number;
  overdue_subjects: string[];
  open_leads: number;
  at_risk: Array<{ name: string; score: number; days_idle: number }>;
}

function dayBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)).toISOString();
  return { start, end };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function gatherRepContext(org_id: string, user_id: string, client_id: string | null): Promise<RepContext> {
  const { start, end } = dayBounds();

  // Pending, dated activities owned by OR assigned to the rep.
  let aq = supabaseAdmin.from('crm_activities')
    .select('subject, due_at')
    .eq('org_id', org_id)
    .is('completed_at', null)
    .not('due_at', 'is', null);
  if (UUID_RE.test(user_id)) aq = aq.or(`owner_id.eq.${user_id},assigned_to.eq.${user_id}`);
  if (client_id) aq = aq.eq('client_id', client_id);
  const acts = ((await aq.limit(200)).data ?? []) as Array<{ subject: string | null; due_at: string }>;
  const today = acts.filter((a) => a.due_at >= start && a.due_at <= end).length;
  const overdueActs = acts.filter((a) => a.due_at < start);

  // The rep's open leads + the hottest ones going cold.
  let lq = supabaseAdmin.from('crm_leads')
    .select('first_name, last_name, company, score, status, last_activity_at, created_at')
    .eq('org_id', org_id)
    .eq('owner_id', user_id)
    .not('status', 'in', '(won,lost,converted,disqualified,unqualified)');
  if (client_id) lq = lq.eq('client_id', client_id);
  const leads = ((await lq.limit(500)).data ?? []) as Array<any>;
  const nowMs = Date.now();
  const at_risk = leads
    .filter((l) => Number(l.score ?? 0) >= 60)
    .map((l) => ({
      name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.company || 'Unnamed',
      score: Number(l.score ?? 0),
      days_idle: Math.floor((nowMs - new Date(l.last_activity_at ?? l.created_at).getTime()) / 86_400_000),
    }))
    .filter((l) => l.days_idle >= 14)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    date: start.slice(0, 10),
    today,
    overdue: overdueActs.length,
    overdue_subjects: overdueActs.slice(0, 5).map((a) => a.subject || 'Untitled').filter(Boolean),
    open_leads: leads.length,
    at_risk,
  };
}

const SYSTEM = [
  'You are KINI, a CRM copilot writing a sales rep\'s short morning briefing.',
  'You are given a JSON snapshot of the rep\'s day. Write 2-3 short sentences (≤ 45 words total),',
  'specific and motivating, telling the rep what to focus on FIRST. Lead with the single highest-',
  'priority action. Use the concrete numbers, and name the top at-risk lead if there is one.',
  'Start with at most "Good morning." — no longer greeting. Plain text only: no markdown, no lists.',
].join('\n');

function templateBriefing(ctx: RepContext): string {
  const parts: string[] = [];
  if (ctx.today) parts.push(`${ctx.today} activit${ctx.today === 1 ? 'y' : 'ies'} due today`);
  if (ctx.overdue) parts.push(`${ctx.overdue} overdue`);
  if (ctx.at_risk.length) parts.push(`${ctx.at_risk.length} hot lead${ctx.at_risk.length === 1 ? '' : 's'} going cold`);
  if (!parts.length) return `Good morning. You're all caught up — ${ctx.open_leads} open leads. Pick one to push forward today.`;
  const top = ctx.at_risk[0];
  const focus = top ? ` Start with ${top.name} (score ${top.score}, idle ${top.days_idle}d).` : '';
  return `Good morning. ${parts.join(', ')}.${focus}`;
}

export async function generateBriefing(org_id: string, user_id: string, client_id: string | null): Promise<{ briefing: string; context: RepContext }> {
  const context = await gatherRepContext(org_id, user_id, client_id);
  const fallback = templateBriefing(context);
  try {
    const text = await aiComplete({
      org_id,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(context) }],
      max_tokens: 220,
    });
    const briefing = (text || '').trim();
    return { briefing: briefing || fallback, context };
  } catch (err: any) {
    logger.warn(`[daily-briefing] AI generate failed, using template: ${err?.message || err}`);
    return { briefing: fallback, context };
  }
}

/**
 * Cron / in-process entry — for every rep with something actionable by end of
 * today, claim a once-per-day slot and push a briefing. Capped per run.
 */
export async function runDailyBriefings(limit = 100): Promise<{ checked: number; sent: number }> {
  const { end } = dayBounds();
  const briefingDate = new Date().toISOString().slice(0, 10);

  // Candidate reps = people with a pending activity due by end of today.
  const { data: actRows } = await supabaseAdmin
    .from('crm_activities')
    .select('assigned_to, owner_id')
    .is('completed_at', null)
    .not('due_at', 'is', null)
    .lte('due_at', end)
    .limit(5000);
  const ids = new Set<string>();
  for (const r of (actRows ?? []) as Array<{ assigned_to: string | null; owner_id: string | null }>) {
    if (r.assigned_to) ids.add(r.assigned_to);
    if (r.owner_id) ids.add(r.owner_id);
  }
  const candidates = Array.from(ids).filter((id) => UUID_RE.test(id)).slice(0, limit);
  if (!candidates.length) return { checked: 0, sent: 0 };

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, org_id, client_id')
    .in('id', candidates);
  const userMap = new Map((users ?? []).map((u: any) => [u.id, u]));

  let sent = 0;
  for (const uid of candidates) {
    const u = userMap.get(uid);
    if (!u || !u.org_id) continue;

    // Atomic once-per-day claim — unique (user_id, briefing_date).
    const { error: claimErr } = await supabaseAdmin
      .from('crm_daily_briefing_log')
      .insert({ user_id: uid, briefing_date: briefingDate });
    if (claimErr) continue; // already briefed today (or transient) — skip

    try {
      const { briefing } = await generateBriefing(u.org_id, uid, u.client_id ?? null);
      await supabaseAdmin.from('notifications').insert({
        org_id: u.org_id,
        user_id: uid,
        title: 'Your day, prioritized',
        body: briefing,
        type: 'daily_briefing',
        data: { type: 'daily_briefing' },
      });
      sent++;
    } catch (err: any) {
      logger.warn(`[daily-briefing] ${uid} failed: ${err?.message || err}`);
    }
  }
  return { checked: candidates.length, sent };
}

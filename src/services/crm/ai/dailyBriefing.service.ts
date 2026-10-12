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
  new_today: number;
  at_risk: Array<{ name: string; score: number; days_idle: number }>;
}

function dayBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)).toISOString();
  return { start, end };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function gatherRepContext(
  org_id: string,
  user_id: string,
  client_id: string | null,
  opts?: { teamWide?: boolean },
): Promise<RepContext> {
  const { start, end } = dayBounds();
  // teamWide = a client-wide snapshot for a manager/admin who owns no leads of
  // their own (so their daily summary is the TEAM's day, not an empty one).
  const teamWide = !!opts?.teamWide;

  // Pending, dated activities. Rep view: owned by OR assigned to the rep.
  // Team view: every open dated activity in the client.
  let aq = supabaseAdmin.from('crm_activities')
    .select('subject, due_at')
    .eq('org_id', org_id)
    .is('completed_at', null)
    .not('due_at', 'is', null);
  if (!teamWide && UUID_RE.test(user_id)) aq = aq.or(`owner_id.eq.${user_id},assigned_to.eq.${user_id}`);
  if (client_id) aq = aq.eq('client_id', client_id);
  const acts = ((await aq.limit(teamWide ? 1000 : 200)).data ?? []) as Array<{ subject: string | null; due_at: string }>;
  const today = acts.filter((a) => a.due_at >= start && a.due_at <= end).length;
  const overdueActs = acts.filter((a) => a.due_at < start);

  // Open leads + the hottest ones going cold. Rep view: owned by the rep; team
  // view: the whole client's open leads.
  let lq = supabaseAdmin.from('crm_leads')
    .select('first_name, last_name, company, score, status, last_activity_at, created_at')
    .eq('org_id', org_id)
    .not('status', 'in', '(won,lost,converted,disqualified,unqualified)');
  if (!teamWide) lq = lq.eq('owner_id', user_id);
  if (client_id) lq = lq.eq('client_id', client_id);
  const leads = ((await lq.limit(teamWide ? 2000 : 500)).data ?? []) as Array<any>;
  const nowMs = Date.now();
  const new_today = leads.filter((l) => (l.created_at ?? '') >= start).length;
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
    new_today,
    at_risk,
  };
}

const SYSTEM = [
  'You are KINI, a CRM copilot writing a sales rep\'s short morning briefing.',
  'You are given a JSON snapshot of the rep\'s day. Write 2-3 short sentences (≤ 45 words total),',
  'specific and motivating, telling the rep what to focus on FIRST. Lead with the single highest-',
  'priority action. Use the concrete numbers — new leads today (new_today), open leads, activities',
  'due today and overdue — and name the top at-risk lead if there is one.',
  'Start with at most "Good morning." — no longer greeting. Plain text only: no markdown, no lists.',
].join('\n');

function templateBriefing(ctx: RepContext): string {
  const parts: string[] = [];
  if (ctx.new_today) parts.push(`${ctx.new_today} new lead${ctx.new_today === 1 ? '' : 's'} today`);
  if (ctx.today) parts.push(`${ctx.today} activit${ctx.today === 1 ? 'y' : 'ies'} due today`);
  if (ctx.overdue) parts.push(`${ctx.overdue} overdue`);
  if (ctx.at_risk.length) parts.push(`${ctx.at_risk.length} hot lead${ctx.at_risk.length === 1 ? '' : 's'} going cold`);
  if (!parts.length) return `Good morning. You're all caught up — ${ctx.open_leads} open lead${ctx.open_leads === 1 ? '' : 's'}. Pick one to push forward today.`;
  const top = ctx.at_risk[0];
  const focus = top ? ` Start with ${top.name} (score ${top.score}, idle ${top.days_idle}d).` : '';
  return `Good morning. ${ctx.open_leads} open lead${ctx.open_leads === 1 ? '' : 's'} — ${parts.join(', ')}.${focus}`;
}

// Manager/admin variant of the briefing — the whole TEAM's day rather than one
// rep's. Used for configured recipients who own no leads of their own.
const SYSTEM_TEAM = [
  'You are KINI, a CRM copilot writing a short morning briefing for a sales MANAGER / admin.',
  'You are given a JSON snapshot of the whole TEAM\'s day. Write 2-3 short sentences (≤ 45 words total),',
  'specific and useful, telling the manager where the team should focus FIRST. Use the concrete numbers —',
  'new leads today (new_today), total open leads, team activities due today and overdue — and name the top',
  'at-risk lead if there is one. Start with at most "Good morning." Plain text only: no markdown, no lists.',
].join('\n');

function templateTeamBriefing(ctx: RepContext): string {
  const parts: string[] = [];
  if (ctx.new_today) parts.push(`${ctx.new_today} new lead${ctx.new_today === 1 ? '' : 's'} today`);
  if (ctx.today) parts.push(`${ctx.today} activit${ctx.today === 1 ? 'y' : 'ies'} due today`);
  if (ctx.overdue) parts.push(`${ctx.overdue} overdue`);
  if (ctx.at_risk.length) parts.push(`${ctx.at_risk.length} hot lead${ctx.at_risk.length === 1 ? '' : 's'} going cold`);
  if (!parts.length) return `Good morning. The team is all caught up — ${ctx.open_leads} open lead${ctx.open_leads === 1 ? '' : 's'} in the pipeline.`;
  const top = ctx.at_risk[0];
  const focus = top ? ` Chase ${top.name} (score ${top.score}, idle ${top.days_idle}d).` : '';
  return `Good morning. Team pipeline: ${ctx.open_leads} open lead${ctx.open_leads === 1 ? '' : 's'} — ${parts.join(', ')}.${focus}`;
}

/** Parse a daily_briefing_recipients org_settings value into a list of user-id
 *  strings. Accepts a JSON array, a JSON string of an array, or an object with
 *  a user_ids / users / ids array. Non-UUID entries are dropped. */
function parseIdList(value: unknown): string[] {
  let v: unknown = value;
  if (typeof v === 'string') {
    const s = v.trim();
    if (UUID_RE.test(s)) return [s];
    try { v = JSON.parse(s); } catch { return []; }
  }
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
  if (v && typeof v === 'object') {
    const arr = (v as Record<string, unknown>).user_ids
      ?? (v as Record<string, unknown>).users
      ?? (v as Record<string, unknown>).ids;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
  }
  return [];
}

export async function generateBriefing(
  org_id: string,
  user_id: string,
  client_id: string | null,
  opts?: { teamWide?: boolean },
): Promise<{ briefing: string; context: RepContext }> {
  const teamWide = !!opts?.teamWide;
  const context = await gatherRepContext(org_id, user_id, client_id, { teamWide });
  const fallback = teamWide ? templateTeamBriefing(context) : templateBriefing(context);
  try {
    const text = await aiComplete({
      org_id,
      system: teamWide ? SYSTEM_TEAM : SYSTEM,
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
 * Cron / in-process entry — send every active CRM rep their morning home
 * summary (a tap opens lead-management Home), claiming a once-per-day slot per
 * rep. The audience is anyone with leads OR activity to summarise:
 *   - people with a pending activity due by end of today, AND
 *   - owners of at least one open lead
 * so a rep working only leads (no dated activity) still gets their lead summary.
 * Capped per run.
 */
export async function runDailyBriefings(limit = 500): Promise<{ checked: number; sent: number }> {
  const { end } = dayBounds();
  const briefingDate = new Date().toISOString().slice(0, 10);

  const normalIds = new Set<string>();  // own leads / have activities → personal (rep) summary
  const forcedIds = new Set<string>();  // configured recipients → always briefed

  // 1) People with a pending activity due by end of today.
  const { data: actRows } = await supabaseAdmin
    .from('crm_activities')
    .select('assigned_to, owner_id')
    .is('completed_at', null)
    .not('due_at', 'is', null)
    .lte('due_at', end)
    .limit(10000);
  for (const r of (actRows ?? []) as Array<{ assigned_to: string | null; owner_id: string | null }>) {
    if (r.assigned_to) normalIds.add(r.assigned_to);
    if (r.owner_id) normalIds.add(r.owner_id);
  }

  // 2) Owners of open leads — so a lead-only rep still gets their daily summary.
  const { data: leadRows } = await supabaseAdmin
    .from('crm_leads')
    .select('owner_id')
    .not('owner_id', 'is', null)
    .not('status', 'in', '(won,lost,converted,disqualified,unqualified)')
    .limit(20000);
  for (const r of (leadRows ?? []) as Array<{ owner_id: string | null }>) {
    if (r.owner_id) normalIds.add(r.owner_id);
  }

  // 3) Configured always-brief recipients (org_settings `daily_briefing_recipients`,
  //    a JSON array of user ids). Briefed even when they own no leads/activities —
  //    e.g. an admin who wants a daily TEAM overview. Opt-in per org: unset = no
  //    change, so other tenants are unaffected.
  try {
    const { data: cfgRows } = await supabaseAdmin
      .from('org_settings')
      .select('value')
      .eq('key', 'daily_briefing_recipients')
      .is('client_id', null);
    for (const row of (cfgRows ?? []) as Array<{ value: unknown }>) {
      for (const id of parseIdList(row.value)) forcedIds.add(id);
    }
  } catch (e: any) {
    logger.warn(`[daily-briefing] recipients config read failed: ${e?.message || e}`);
  }

  const candidates = Array.from(new Set<string>([...normalIds, ...forcedIds]))
    .filter((id) => UUID_RE.test(id))
    .slice(0, limit);
  if (!candidates.length) return { checked: 0, sent: 0 };

  // Only brief ACTIVE users (skip deactivated reps who'd otherwise get pushes).
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, org_id, client_id')
    .eq('is_active', true)
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

    // A configured recipient who owns no leads / has no activities (an admin or
    // manager) gets a TEAM-wide summary so the briefing is useful; everyone else
    // gets their personal rep summary.
    const teamWide = forcedIds.has(uid) && !normalIds.has(uid);
    try {
      const { briefing } = await generateBriefing(u.org_id, uid, u.client_id ?? null, { teamWide });
      await supabaseAdmin.from('notifications').insert({
        org_id: u.org_id,
        user_id: uid,
        title: teamWide ? 'Your team today' : 'Your day, prioritized',
        body: briefing,
        type: 'daily_briefing',
        // kind: 'crm_home' → a tap opens the lead-management Home (mission
        // control) on web / iOS / Android; the type stays 'daily_briefing'.
        data: { type: 'daily_briefing', kind: 'crm_home' },
      });
      sent++;
    } catch (err: any) {
      logger.warn(`[daily-briefing] ${uid} failed: ${err?.message || err}`);
    }
  }
  return { checked: candidates.length, sent };
}

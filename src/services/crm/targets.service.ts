/**
 * Targets service. A "target" is a goal — by default the number of leads to
 * create per day. Targets are set primarily **per hierarchy role** (the org's
 * custom org_roles, e.g. Tata Tiscon's "Consumer Champion", "Area Sales
 * Officer"): every user with that role inherits it. A per-user override and an
 * org-wide default are also supported, plus legacy per-hierarchy-level.
 *
 * Resolution for a user: per-user override > their org role > their hierarchy
 * level > org default. Tenant-aware via client_id.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

const DEFAULT_METRIC = 'leads_created';
const DEFAULT_PERIOD = 'daily';

export interface TargetRow {
  id: string;
  user_id: string | null;
  org_role_id: string | null;
  hierarchy_level_id: string | null;
  metric: string;
  period: string;
  target_value: number;
}

/**
 * The "levels" managers set targets against — the org's custom roles
 * (org_roles), which is how clients like Tata Tiscon model their hierarchy
 * (Consumer Champion, Area Sales Officer, …). Returns id + name, ordered.
 */
export async function listTargetRoles(org_id: string, client_id: string | null) {
  let q = supabaseAdmin.from('org_roles')
    .select('id, name, position')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .order('position', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  q = client_id ? q.or(`client_id.is.null,client_id.eq.${client_id}`) : q.is('client_id', null);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []).map((r: any) => ({ id: r.id as string, name: r.name as string }));
}

/** All target rows for the manager UI: default + per-role + per-level + per-user. */
export async function listTargets(org_id: string, client_id: string | null) {
  let q = supabaseAdmin.from('crm_targets')
    .select('id, user_id, org_role_id, hierarchy_level_id, metric, period, target_value')
    .eq('org_id', org_id)
    .eq('metric', DEFAULT_METRIC)
    .eq('period', DEFAULT_PERIOD);
  q = client_id ? q.eq('client_id', client_id) : q.is('client_id', null);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data ?? []) as TargetRow[];
  const isDefault = (r: TargetRow) => r.user_id === null && r.org_role_id === null && r.hierarchy_level_id === null;
  return {
    default_target: rows.find(isDefault)?.target_value ?? 0,
    // per_level is keyed by the role id (the "level" the UI sets targets for).
    per_level: rows.filter((r) => r.user_id === null && r.org_role_id !== null)
      .map((r) => ({ hierarchy_level_id: r.org_role_id as string, target_value: r.target_value })),
    per_user: rows.filter((r) => r.user_id !== null)
      .map((r) => ({ user_id: r.user_id as string, target_value: r.target_value })),
  };
}

/**
 * Upsert one target row. Exactly one scope is implied:
 *   - user_id set            → per-user override
 *   - org_role_id set         → per-role (everyone with that org role)
 *   - hierarchy_level_id set  → per-level (legacy org_hierarchy_levels)
 *   - none                   → org-wide default
 * The UI sends the role id as `hierarchy_level_id` for back-compat; we route
 * it to org_role_id here.
 */
export async function setTarget(
  org_id: string,
  client_id: string | null,
  payload: { user_id?: string | null; org_role_id?: string | null; hierarchy_level_id?: string | null; target_value: number },
  actor_id?: string,
) {
  const user_id = payload.user_id ?? null;
  // Treat an incoming hierarchy_level_id as a role id (that's what the level
  // list now returns). A genuine org_hierarchy_levels id can also be passed
  // explicitly as org_role_id=null + hierarchy_level_id, but the UI uses roles.
  const org_role_id = user_id ? null : (payload.org_role_id ?? payload.hierarchy_level_id ?? null);
  const hierarchy_level_id = null;
  const target_value = Math.max(0, Math.floor(Number(payload.target_value) || 0));

  let find = supabaseAdmin.from('crm_targets').select('id')
    .eq('org_id', org_id).eq('metric', DEFAULT_METRIC).eq('period', DEFAULT_PERIOD);
  find = client_id ? find.eq('client_id', client_id) : find.is('client_id', null);
  find = user_id ? find.eq('user_id', user_id) : find.is('user_id', null);
  find = org_role_id ? find.eq('org_role_id', org_role_id) : find.is('org_role_id', null);
  find = find.is('hierarchy_level_id', null);
  const { data: existing } = await find.maybeSingle();

  if (existing?.id) {
    const { data, error } = await supabaseAdmin.from('crm_targets')
      .update({ target_value, updated_by: actor_id ?? null, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select('*').single();
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    return data;
  }
  const { data, error } = await supabaseAdmin.from('crm_targets')
    .insert({ org_id, client_id, user_id, org_role_id, hierarchy_level_id, metric: DEFAULT_METRIC, period: DEFAULT_PERIOD, target_value, created_by: actor_id ?? null })
    .select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

/** Set the org-wide default (all scopes null). */
export async function setAllTargets(org_id: string, client_id: string | null, target_value: number, actor_id?: string) {
  return setTarget(org_id, client_id, { user_id: null, org_role_id: null, hierarchy_level_id: null, target_value }, actor_id);
}

/** Start of "today" in IST, as a UTC ISO string — leads are counted from here. */
function istDayStartUTC(): string {
  const IST_MIN = 330;
  const nowIst = new Date(Date.now() + IST_MIN * 60000);
  nowIst.setUTCHours(0, 0, 0, 0);
  return new Date(nowIst.getTime() - IST_MIN * 60000).toISOString();
}

export type LeaderboardPeriod = 'today' | 'week' | 'month';
const IST_MIN = 330;

/** Start of the leaderboard window (IST midnight today / Monday / 1st), as UTC ISO. */
function istPeriodStartUTC(period: LeaderboardPeriod): string {
  const d = new Date(Date.now() + IST_MIN * 60000);
  d.setUTCHours(0, 0, 0, 0);
  if (period === 'week') {
    const dow = d.getUTCDay();              // 0 Sun … 6 Sat
    d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7)); // back to Monday
  } else if (period === 'month') {
    d.setUTCDate(1);
  }
  return new Date(d.getTime() - IST_MIN * 60000).toISOString();
}

/** Whole IST days elapsed in the window so far (inclusive) — to scale daily targets. */
function daysInPeriod(period: LeaderboardPeriod): number {
  if (period === 'today') return 1;
  const startIst = Date.parse(istPeriodStartUTC(period)) + IST_MIN * 60000;
  const nowIst = Date.now() + IST_MIN * 60000;
  return Math.max(1, Math.floor((nowIst - startIst) / 86400000) + 1);
}

/**
 * Leaderboard analytics for the Targets module: per-user leads created in the
 * window (today / this week / this month), each user's resolved target scaled
 * by days elapsed, plus aggregate stats (top, lowest, average, % meeting
 * target). Tenant-scoped via client_id. Sorted by leads desc.
 */
export async function targetsLeaderboard(
  org_id: string,
  client_id: string | null,
  period: LeaderboardPeriod = 'today',
  // The viewer — when a non-manager (data_scope='own', e.g. a Consumer
  // Champion) opens the board, it is locked to *their own* role so they
  // only ever see peers in their tier, never the whole field force.
  viewer?: { org_role_id?: string | null; org_role_data_scope?: string | null } | null,
) {
  // 1. Users in scope (the field force for this tenant). `users` has no
  // soft-delete column — it uses is_active; exclude only explicitly-disabled
  // accounts (null/true kept). When a client is selected we scope to it; with
  // no client picked (org-wide admin view) we show the whole org.
  let uq = supabaseAdmin.from('users')
    .select('id, name, email, city, org_role_id, hierarchy_level_id, role')
    .eq('org_id', org_id).neq('is_active', false);
  if (client_id) uq = uq.eq('client_id', client_id);
  // The leaderboard is scoped to one hierarchy role (e.g. Consumer Champion),
  // configurable per client. When set, only that role's users compete. A
  // non-manager viewer is always pinned to their own role regardless of the
  // configured default.
  const roleId = (viewer?.org_role_data_scope === 'own' && viewer.org_role_id)
    ? viewer.org_role_id
    : await getLeaderboardRoleId(org_id, client_id);
  if (roleId) uq = uq.eq('org_role_id', roleId);
  const { data: uData, error: uErr } = await uq;
  if (uErr) throw new AppError(500, uErr.message, 'DB_ERROR');
  const users = (uData ?? []) as any[];

  // 2. Target rows, for resolving each user's daily target.
  const { data: tData, error: tErr } = await supabaseAdmin.from('crm_targets')
    .select('user_id, org_role_id, hierarchy_level_id, client_id, target_value')
    .eq('org_id', org_id).eq('metric', DEFAULT_METRIC).eq('period', DEFAULT_PERIOD);
  if (tErr) throw new AppError(500, tErr.message, 'DB_ERROR');
  const targetRows = (tData ?? []) as any[];

  // Same priority as myTargetToday: user > org_role > hierarchy_level > default,
  // client-specific beats org-wide.
  const dailyTarget = (u: any): number => {
    let best: any = null, bestScore = -1;
    for (const r of targetRows) {
      const clientOk = (client_id && r.client_id === client_id) || r.client_id === null;
      if (!clientOk) continue;
      const bonus = (client_id && r.client_id === client_id) ? 0.5 : 0;
      let s = -1;
      if (r.user_id === u.id) s = 4 + bonus;
      else if (r.user_id === null && r.org_role_id && r.org_role_id === u.org_role_id) s = 3 + bonus;
      else if (r.user_id === null && r.hierarchy_level_id && r.hierarchy_level_id === u.hierarchy_level_id) s = 2 + bonus;
      else if (r.user_id === null && r.org_role_id === null && r.hierarchy_level_id === null) s = 1 + bonus;
      if (s > bestScore) { bestScore = s; best = r; }
    }
    return best?.target_value ?? 0;
  };

  // 3. Leads created in the window, counted per author.
  const since = istPeriodStartUTC(period);
  let lq = supabaseAdmin.from('crm_leads')
    .select('created_by')
    .eq('org_id', org_id).is('deleted_at', null).gte('created_at', since);
  if (client_id) lq = lq.eq('client_id', client_id);
  const { data: lData, error: lErr } = await lq;
  if (lErr) throw new AppError(500, lErr.message, 'DB_ERROR');
  const counts = new Map<string, number>();
  for (const row of (lData ?? [])) {
    const by = (row as any).created_by;
    if (by) counts.set(by, (counts.get(by) ?? 0) + 1);
  }

  // 4. Build rows — keep the field force (anyone in the hierarchy, i.e. has an
  // org role or level, or a target) plus anyone who actually created a lead.
  // Showing zero-lead field staff is intentional: it's what makes "who's
  // behind / entered the least" meaningful even before any target is set.
  // Pure admins with no role, no target and no leads drop out.
  const days = daysInPeriod(period);
  // Stored targets are now weekly figures (admin enters X leads / week).
  // Pro-rate by days elapsed in the window so "today" shows the day's
  // share of the weekly goal and "month" extrapolates roughly 4.33×.
  const entries = users
    .map((u) => {
      const leads = counts.get(u.id) ?? 0;
      const target = Math.round((dailyTarget(u) / 7) * days);
      const isFieldForce = !!(u.org_role_id || u.hierarchy_level_id);
      return {
        user_id: u.id as string,
        name: (u.name || u.email || 'User') as string,
        city: (u.city ?? null) as string | null,
        leads,
        target,
        pct: target > 0 ? Math.round((leads / target) * 100) : null,
        _keep: isFieldForce || leads > 0 || target > 0,
      };
    })
    .filter((e) => e._keep)
    .map(({ _keep, ...e }) => e)
    .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name));

  // 5. Aggregate stats.
  const n = entries.length;
  const totalLeads = entries.reduce((s, e) => s + e.leads, 0);
  const withTarget = entries.filter((e) => e.target > 0);
  const meetingTarget = withTarget.filter((e) => e.leads >= e.target).length;
  const top = entries[0] ?? null;
  const bottom = n ? entries[entries.length - 1] : null;

  return {
    period,
    days,
    generated_at: new Date().toISOString(),
    stats: {
      participants: n,
      total_leads: totalLeads,
      average_leads: n ? Math.round((totalLeads / n) * 10) / 10 : 0,
      meeting_target: meetingTarget,
      target_participants: withTarget.length,
      top_performer: top ? { name: top.name, leads: top.leads } : null,
      lowest_performer: bottom ? { name: bottom.name, leads: bottom.leads } : null,
    },
    entries,
    role_id: roleId,
  };
}

/**
 * The org role the leaderboard is scoped to, for the active client. Stored in
 * crm_settings.config (per-org row): a per-client map plus an org-wide default.
 * Returns null when unset (→ leaderboard shows the whole field force).
 */
export async function getLeaderboardRoleId(org_id: string, client_id: string | null): Promise<string | null> {
  const { data } = await supabaseAdmin.from('crm_settings').select('config').eq('org_id', org_id).maybeSingle();
  const cfg = ((data?.config ?? {}) as Record<string, any>);
  const byClient = (cfg.leaderboard_role_by_client ?? {}) as Record<string, string>;
  return (client_id && byClient[client_id]) || cfg.leaderboard_role_id || null;
}

/** Set (or clear, with null) the leaderboard role for the active client. */
export async function setLeaderboardRoleId(org_id: string, client_id: string | null, role_id: string | null) {
  const { data: existing } = await supabaseAdmin.from('crm_settings').select('id, config').eq('org_id', org_id).maybeSingle();
  const cfg = ((existing?.config ?? {}) as Record<string, any>);
  const byClient = { ...((cfg.leaderboard_role_by_client ?? {}) as Record<string, string>) };
  if (client_id) {
    if (role_id) byClient[client_id] = role_id; else delete byClient[client_id];
    cfg.leaderboard_role_by_client = byClient;
  } else {
    if (role_id) cfg.leaderboard_role_id = role_id; else delete cfg.leaderboard_role_id;
  }
  if (existing?.id) {
    await supabaseAdmin.from('crm_settings').update({ config: cfg }).eq('id', existing.id);
  } else {
    await supabaseAdmin.from('crm_settings').insert({ org_id, config: cfg });
  }
  return { role_id };
}

/**
 * Resolve a single user's target for the current week + how many leads
 * they've created since the IST start of this week (Monday).
 * Priority: per-user override > their org role > their hierarchy level > org default.
 *
 * Stored target rows use period='daily' historically; we now treat them
 * as weekly figures (the admin enters "X leads per week" and we count
 * leads created since Monday). The DB period column is preserved so the
 * column remains a single source of truth — the value itself is the
 * weekly figure end-to-end.
 */
export async function myTargetToday(org_id: string, user_id: string, fe_client_id: string | null) {
  const { data: me } = await supabaseAdmin.from('users')
    .select('org_role_id, hierarchy_level_id').eq('id', user_id).maybeSingle();
  const roleId: string | null = (me as any)?.org_role_id ?? null;
  const levelId: string | null = (me as any)?.hierarchy_level_id ?? null;

  const { data, error } = await supabaseAdmin.from('crm_targets')
    .select('user_id, org_role_id, hierarchy_level_id, client_id, target_value')
    .eq('org_id', org_id).eq('metric', DEFAULT_METRIC).eq('period', DEFAULT_PERIOD);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = data ?? [];

  // Higher score wins. user(4) > org_role(3) > hierarchy_level(2) > default(1);
  // within a scope, client-specific beats org-wide.
  const score = (r: any): number => {
    const clientOk = (fe_client_id && r.client_id === fe_client_id) || r.client_id === null;
    if (!clientOk) return -1;
    const bonus = (fe_client_id && r.client_id === fe_client_id) ? 0.5 : 0;
    if (r.user_id === user_id) return 4 + bonus;
    if (r.user_id === null && r.org_role_id && r.org_role_id === roleId) return 3 + bonus;
    if (r.user_id === null && r.hierarchy_level_id && r.hierarchy_level_id === levelId) return 2 + bonus;
    if (r.user_id === null && r.org_role_id === null && r.hierarchy_level_id === null) return 1 + bonus;
    return -1;
  };
  let best: any = null; let bestScore = -1;
  for (const r of rows) { const s = score(r); if (s > bestScore) { bestScore = s; best = r; } }
  const target = best?.target_value ?? 0;

  // This-week-so-far count — IST week starts on Monday 00:00.
  const since = istPeriodStartUTC('week');
  let cq = supabaseAdmin.from('crm_leads')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', org_id).eq('created_by', user_id).is('deleted_at', null)
    .gte('created_at', since);
  if (fe_client_id) cq = cq.eq('client_id', fe_client_id);
  const { count, error: cErr } = await cq;
  if (cErr) throw new AppError(500, cErr.message, 'DB_ERROR');
  return { metric: DEFAULT_METRIC, period: 'weekly', target, achieved: count ?? 0 };
}

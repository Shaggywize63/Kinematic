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

/**
 * Resolve a single user's target for today + how many leads they've created.
 * Priority: per-user override > their org role > their hierarchy level > org default.
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

  const since = istDayStartUTC();
  let cq = supabaseAdmin.from('crm_leads')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', org_id).eq('created_by', user_id).is('deleted_at', null)
    .gte('created_at', since);
  if (fe_client_id) cq = cq.eq('client_id', fe_client_id);
  const { count, error: cErr } = await cq;
  if (cErr) throw new AppError(500, cErr.message, 'DB_ERROR');
  return { metric: DEFAULT_METRIC, period: DEFAULT_PERIOD, target, achieved: count ?? 0 };
}

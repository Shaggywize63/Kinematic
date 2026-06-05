/**
 * Targets service. A "target" is a goal — by default the number of leads to
 * create per day. Targets are set primarily **per hierarchy level** (e.g. Tata
 * Tiscon's "Consumer Champion", "Area Sales Officer"): every user at that level
 * inherits it. A per-user override and an org-wide default are also supported.
 *
 * Resolution for an FE: per-user override > their hierarchy level > org default.
 * Tenant-aware via client_id so each client gets its own targets.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

const DEFAULT_METRIC = 'leads_created';
const DEFAULT_PERIOD = 'daily';

export interface TargetRow {
  id: string;
  user_id: string | null;
  hierarchy_level_id: string | null;
  metric: string;
  period: string;
  target_value: number;
}

/** All target rows for the manager UI: org default + per-level + per-user. */
export async function listTargets(org_id: string, client_id: string | null) {
  let q = supabaseAdmin.from('crm_targets')
    .select('id, user_id, hierarchy_level_id, metric, period, target_value')
    .eq('org_id', org_id)
    .eq('metric', DEFAULT_METRIC)
    .eq('period', DEFAULT_PERIOD);
  q = client_id ? q.eq('client_id', client_id) : q.is('client_id', null);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data ?? []) as TargetRow[];
  return {
    default_target: rows.find((r) => r.user_id === null && r.hierarchy_level_id === null)?.target_value ?? 0,
    per_level: rows.filter((r) => r.user_id === null && r.hierarchy_level_id !== null)
      .map((r) => ({ hierarchy_level_id: r.hierarchy_level_id as string, target_value: r.target_value })),
    per_user: rows.filter((r) => r.user_id !== null)
      .map((r) => ({ user_id: r.user_id as string, target_value: r.target_value })),
  };
}

/**
 * Upsert one target row. Exactly one scope is implied:
 *   - user_id set            → per-user override
 *   - hierarchy_level_id set  → per-level (applies to every user at that tier)
 *   - neither                → org-wide default
 */
export async function setTarget(
  org_id: string,
  client_id: string | null,
  payload: { user_id?: string | null; hierarchy_level_id?: string | null; target_value: number },
  actor_id?: string,
) {
  const user_id = payload.user_id ?? null;
  const hierarchy_level_id = user_id ? null : (payload.hierarchy_level_id ?? null);
  const target_value = Math.max(0, Math.floor(Number(payload.target_value) || 0));

  let find = supabaseAdmin.from('crm_targets').select('id')
    .eq('org_id', org_id).eq('metric', DEFAULT_METRIC).eq('period', DEFAULT_PERIOD);
  find = client_id ? find.eq('client_id', client_id) : find.is('client_id', null);
  find = user_id ? find.eq('user_id', user_id) : find.is('user_id', null);
  find = hierarchy_level_id ? find.eq('hierarchy_level_id', hierarchy_level_id) : find.is('hierarchy_level_id', null);
  const { data: existing } = await find.maybeSingle();

  if (existing?.id) {
    const { data, error } = await supabaseAdmin.from('crm_targets')
      .update({ target_value, updated_by: actor_id ?? null, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select('*').single();
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    return data;
  }
  const { data, error } = await supabaseAdmin.from('crm_targets')
    .insert({ org_id, client_id, user_id, hierarchy_level_id, metric: DEFAULT_METRIC, period: DEFAULT_PERIOD, target_value, created_by: actor_id ?? null })
    .select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

/** Set the org-wide default (both scopes null). */
export async function setAllTargets(org_id: string, client_id: string | null, target_value: number, actor_id?: string) {
  return setTarget(org_id, client_id, { user_id: null, hierarchy_level_id: null, target_value }, actor_id);
}

/** Start of "today" in IST, as a UTC ISO string — leads are counted from here. */
function istDayStartUTC(): string {
  const IST_MIN = 330;
  const nowIst = new Date(Date.now() + IST_MIN * 60000);
  nowIst.setUTCHours(0, 0, 0, 0);
  return new Date(nowIst.getTime() - IST_MIN * 60000).toISOString();
}

/**
 * Resolve a single FE's target for today + how many leads they've created.
 * Priority: per-user override > their hierarchy level > org default > 0.
 */
export async function myTargetToday(org_id: string, user_id: string, fe_client_id: string | null) {
  // The FE's hierarchy level (so we can match a per-level target).
  const { data: me } = await supabaseAdmin.from('users')
    .select('hierarchy_level_id').eq('id', user_id).maybeSingle();
  const levelId: string | null = (me as any)?.hierarchy_level_id ?? null;

  const { data, error } = await supabaseAdmin.from('crm_targets')
    .select('user_id, hierarchy_level_id, client_id, target_value')
    .eq('org_id', org_id).eq('metric', DEFAULT_METRIC).eq('period', DEFAULT_PERIOD);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = data ?? [];

  // Higher score wins. Scope: user(3) > level(2) > org-default(1); within a
  // scope, client-specific beats org-wide.
  const score = (r: any): number => {
    const clientOk = (fe_client_id && r.client_id === fe_client_id) || r.client_id === null;
    if (!clientOk) return -1;
    const clientBonus = (fe_client_id && r.client_id === fe_client_id) ? 0.5 : 0;
    if (r.user_id === user_id) return 3 + clientBonus;
    if (r.user_id === null && r.hierarchy_level_id && r.hierarchy_level_id === levelId) return 2 + clientBonus;
    if (r.user_id === null && r.hierarchy_level_id === null) return 1 + clientBonus;
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

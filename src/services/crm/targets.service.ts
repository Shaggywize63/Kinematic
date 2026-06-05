/**
 * Targets service. A "target" is a per-field-executive goal — by default the
 * number of leads they should create per day. Managers/admins set targets
 * either per FE or the same for everyone (the "all FEs" default row, stored
 * with user_id = null). FEs read their own resolved target + today's
 * achievement for the dashboard ticker and the lead-add "1/5" badge.
 *
 * Tenant-aware: rows carry client_id so Tata Tiscon (and any client) get
 * their own targets; a null client_id row is the org-wide default.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

const DEFAULT_METRIC = 'leads_created';
const DEFAULT_PERIOD = 'daily';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface TargetRow {
  id: string;
  user_id: string | null;
  metric: string;
  period: string;
  target_value: number;
}

/** All target rows for the manager UI: the "all FEs" default + per-FE overrides. */
export async function listTargets(org_id: string, client_id: string | null) {
  let q = supabaseAdmin.from('crm_targets')
    .select('id, user_id, metric, period, target_value')
    .eq('org_id', org_id)
    .eq('metric', DEFAULT_METRIC)
    .eq('period', DEFAULT_PERIOD);
  q = client_id ? q.eq('client_id', client_id) : q.is('client_id', null);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data ?? []) as TargetRow[];
  return {
    default_target: rows.find((r) => r.user_id === null)?.target_value ?? 0,
    per_user: rows.filter((r) => r.user_id !== null)
      .map((r) => ({ user_id: r.user_id as string, target_value: r.target_value })),
  };
}

/** Upsert one target row (user_id null = the "all FEs" default). */
export async function setTarget(
  org_id: string,
  client_id: string | null,
  payload: { user_id?: string | null; target_value: number },
  actor_id?: string,
) {
  const user_id = payload.user_id ?? null;
  const target_value = Math.max(0, Math.floor(Number(payload.target_value) || 0));

  // Find existing (NULL-safe match on client_id + user_id) then update, else insert.
  let find = supabaseAdmin.from('crm_targets').select('id')
    .eq('org_id', org_id).eq('metric', DEFAULT_METRIC).eq('period', DEFAULT_PERIOD);
  find = client_id ? find.eq('client_id', client_id) : find.is('client_id', null);
  find = user_id ? find.eq('user_id', user_id) : find.is('user_id', null);
  const { data: existing } = await find.maybeSingle();

  if (existing?.id) {
    const { data, error } = await supabaseAdmin.from('crm_targets')
      .update({ target_value, updated_by: actor_id ?? null, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select('*').single();
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    return data;
  }
  const { data, error } = await supabaseAdmin.from('crm_targets')
    .insert({ org_id, client_id, user_id, metric: DEFAULT_METRIC, period: DEFAULT_PERIOD, target_value, created_by: actor_id ?? null })
    .select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

/** Set the same target for every FE (the default row). */
export async function setAllTargets(org_id: string, client_id: string | null, target_value: number, actor_id?: string) {
  return setTarget(org_id, client_id, { user_id: null, target_value }, actor_id);
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
 * Priority: their own (client-specific) > own (org) > all-FE default
 * (client) > all-FE default (org) > 0.
 */
export async function myTargetToday(org_id: string, user_id: string, fe_client_id: string | null) {
  const { data, error } = await supabaseAdmin.from('crm_targets')
    .select('user_id, client_id, target_value')
    .eq('org_id', org_id).eq('metric', DEFAULT_METRIC).eq('period', DEFAULT_PERIOD);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = data ?? [];
  const score = (r: any) => {
    const userMatch = r.user_id === user_id ? 2 : (r.user_id === null ? 1 : 0);
    if (userMatch === 0) return -1;
    const clientMatch = (fe_client_id && r.client_id === fe_client_id) ? 1 : (r.client_id === null ? 0 : -1);
    if (clientMatch < 0) return -1;
    return userMatch * 10 + clientMatch; // prefer user-specific, then client-specific
  };
  let best: any = null; let bestScore = -1;
  for (const r of rows) { const s = score(r); if (s > bestScore) { bestScore = s; best = r; } }
  const target = best?.target_value ?? 0;

  // Achievement: leads this FE created since IST midnight.
  const since = istDayStartUTC();
  let cq = supabaseAdmin.from('crm_leads')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', org_id).eq('created_by', user_id).is('deleted_at', null)
    .gte('created_at', since);
  if (fe_client_id) cq = cq.eq('client_id', fe_client_id);
  const { count, error: cErr } = await cq;
  if (cErr) throw new AppError(500, cErr.message, 'DB_ERROR');
  const achieved = count ?? 0;
  return { metric: DEFAULT_METRIC, period: DEFAULT_PERIOD, target, achieved };
}

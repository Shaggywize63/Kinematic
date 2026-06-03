/**
 * CRM analytics — reads materialized views + a few live queries for KPIs.
 * Each method accepts optional `from`/`to` ISO timestamps to scope the window;
 * defaults preserve the original "week / month / 30 day" rolling windows when
 * the caller doesn't pass anything (callers that haven't been updated keep
 * working).
 */
import { supabaseAdmin } from '../../lib/supabase';
import type { DashboardSummary } from '../../types/crm.types';

export interface DateRange { from?: string; to?: string }
export type AnalyticsUnit = 'inr' | 'weight';

function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

// Apply the multi-tenant client filter to any Supabase query builder. Hard
// isolation: when client_id is provided, returns rows where client_id matches
// exactly. When client_id is null (org-admin without a client picked), returns
// the query unchanged so org admins retain a global audit view across all
// rows in the org.
function withClient<T>(q: T, client_id: string | null): T {
  const qb = q as any;
  if (client_id) return qb.eq('client_id', client_id);
  return qb;
}

// Weight mode uses crm_v_deal_weight, a SQL view that pre-aggregates
// SUM(quantity × product.weight_kg) per deal. Old path streamed every line
// item over the wire and summed in Node — quadratic with line-item count.
// New path is a tiny LEFT JOIN that returns ONE numeric per deal.
//
// The PostgREST relation name is the view itself; we alias it to a stable
// key (`weight`) so callers can read `r.weight?.[0]?.total_kg`.
const weightJoin = ', weight:crm_v_deal_weight(total_kg)';

type WeightRow = { total_kg?: number | string | null };
type DealWithWeight = {
  amount?: number | null;
  weight?: WeightRow[] | WeightRow | null;
  // Deals capture their volume in the product-listing section, stored as
  // custom_fields.volume_kg (sum of line-item kg). This is the canonical
  // source; the crm_deal_line_items table / weight view is only populated
  // for deals created through that path.
  custom_fields?: Record<string, unknown> | null;
};

function dealWeightKg(d: DealWithWeight): number {
  // Prefer the volume captured on the deal (custom_fields.volume_kg); fall
  // back to the line-items weight view for deals that use that table.
  const cf = d.custom_fields as Record<string, unknown> | null | undefined;
  const cfVol = cf ? Number(cf.volume_kg) : NaN;
  if (Number.isFinite(cfVol) && cfVol > 0) return cfVol;
  const w = d.weight;
  const row: WeightRow | undefined = Array.isArray(w) ? w[0] : (w ?? undefined);
  return Number(row?.total_kg ?? 0);
}

// Returns the per-deal value used by every aggregation: kg in weight mode,
// rupees in inr mode. Centralised so a deal without line items consistently
// contributes 0 in weight mode (instead of falsely counting its rupee amount).
function dealValue(d: DealWithWeight, unit: AnalyticsUnit): number {
  return unit === 'weight' ? dealWeightKg(d) : Number(d.amount ?? 0);
}

// Per-user visibility scope, mirroring the leads/deals list endpoints, so the
// dashboard shows each user only their slice (assigned city + role hierarchy)
// instead of org/client-wide totals. Undefined/null fields mean "no extra
// restriction" (admins).
export interface AnalyticsScope {
  effectiveCities?: string[] | null;
  visibleOwnerIds?: string[] | null;
  selfOwnerId?: string | null;
  includeNullCity?: boolean;
}

// A UUID that never matches a real row — used to force an empty result set
// when the caller can see nothing (no cities, no visible owners).
const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Lead-visibility scope (city ∪ self ∪ null-city, then owner subtree) on a
// crm_leads query — kept identical to listLeads so analytics match the list.
export function applyLeadScope(q: any, scope?: AnalyticsScope): any {
  if (!scope) return q;
  if (scope.effectiveCities !== undefined && scope.effectiveCities !== null) {
    const orParts: string[] = [];
    if (scope.effectiveCities.length > 0) {
      const cityCsv = scope.effectiveCities.map((c) => `"${String(c).replace(/"/g, '')}"`).join(',');
      orParts.push(`city.in.(${cityCsv})`);
    }
    if (scope.selfOwnerId) orParts.push(`owner_id.eq.${scope.selfOwnerId}`);
    if (scope.includeNullCity) orParts.push('city.is.null');
    if (orParts.length === 0) orParts.push(`owner_id.eq.${NO_MATCH_UUID}`);
    q = q.or(orParts.join(','));
  }
  if (scope.visibleOwnerIds !== undefined && scope.visibleOwnerIds !== null) {
    q = q.in('owner_id', scope.visibleOwnerIds.length ? scope.visibleOwnerIds : [NO_MATCH_UUID]);
  }
  return q;
}

// Owner-subtree scope on a crm_deals query (deals carry no city, so they are
// scoped by ownership only — same as the deals list).
export function applyOwnerScope(q: any, scope?: AnalyticsScope): any {
  if (!scope) return q;
  if (scope.visibleOwnerIds !== undefined && scope.visibleOwnerIds !== null) {
    q = q.in('owner_id', scope.visibleOwnerIds.length ? scope.visibleOwnerIds : [NO_MATCH_UUID]);
  }
  return q;
}

// Owner-subtree scope on a crm_activities query (owner_id OR assigned_to).
function applyActivityScope(q: any, scope?: AnalyticsScope): any {
  if (!scope) return q;
  if (scope.visibleOwnerIds !== undefined && scope.visibleOwnerIds !== null) {
    const ids = (scope.visibleOwnerIds.length ? scope.visibleOwnerIds : [NO_MATCH_UUID]).join(',');
    q = q.or(`owner_id.in.(${ids}),assigned_to.in.(${ids})`);
  }
  return q;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Stable signature for the analytics cache key so one user's scoped result is
// never served to another. Hashed to keep the key bounded when a manager's
// subtree contains many owner ids.
export function analyticsScopeSig(scope?: AnalyticsScope): string {
  if (!scope) return 'all';
  const raw = JSON.stringify({
    c: scope.effectiveCities ?? null,
    o: scope.visibleOwnerIds ?? null,
    s: scope.selfOwnerId ?? null,
    n: scope.includeNullCity ?? null,
  });
  return require('crypto').createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function defaultWindow(range?: DateRange) {
  const fromIso = range?.from ?? new Date(Date.now() - 30 * 86400000).toISOString();
  const toIso = range?.to ?? new Date().toISOString();
  return { fromIso, toIso };
}

export async function dashboardSummary(org_id: string, range?: DateRange, client_id: string | null = null, unit: AnalyticsUnit = 'inr', scope?: AnalyticsScope): Promise<DashboardSummary> {
  const { fromIso, toIso } = defaultWindow(range);
  const fromDate = fromIso.slice(0, 10);
  const toDate = toIso.slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const lines = unit === 'weight' ? weightJoin : '';

  const [
    { count: totalLeads },
    { count: newInWindow },
    { count: convertedInWindow },
    { data: pipelineRows },
    { data: closedInWindow },
    { count: activities7d },
  ] = await Promise.all([
    withClient(applyLeadScope(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null), scope), client_id),
    withClient(applyLeadScope(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('created_at', fromIso).lte('created_at', toIso), scope), client_id),
    withClient(applyLeadScope(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).eq('status', 'converted').gte('created_at', fromIso).lte('created_at', toIso), scope), client_id),
    // Live query for open pipeline — the MV (crm_mv_pipeline_value) doesn't
    // track client_id, so reading it here would leak the org-wide totals into
    // any per-client dashboard.
    withClient(
      applyOwnerScope(supabaseAdmin.from('crm_deals')
        // Always join the weight view here (not just in weight mode) so the
        // Open Pipeline card can show total volume (kg) alongside value.
        .select(`amount, owner_id, custom_fields, crm_deal_stages!inner(name, stage_type)${weightJoin}`)
        .eq('org_id', org_id).is('deleted_at', null)
        .eq('crm_deal_stages.stage_type', 'open'), scope),
      client_id,
    ),
    withClient(applyOwnerScope(supabaseAdmin.from('crm_deals').select(`amount, owner_id, crm_deal_stages!inner(stage_type)${lines}`).eq('org_id', org_id).is('deleted_at', null).gte('actual_close_date', fromDate).lte('actual_close_date', toDate), scope), client_id),
    withClient(applyActivityScope(supabaseAdmin.from('crm_activities').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('created_at', sevenDaysAgo), scope), client_id),
  ]);

  // Aggregate live open-pipeline rows. Each row is one deal. In weight mode
  // the "value" carried in every aggregation is kg derived from line items
  // instead of rupees.
  let open_deal_value = 0;
  let open_deal_volume = 0;
  let open_deals = 0;
  const stageMap = new Map<string, { count: number; value: number }>();
  const ownerMap = new Map<string, { count: number; value: number }>();
  for (const r of (pipelineRows ?? []) as unknown as Array<DealWithWeight & { owner_id?: string | null; crm_deal_stages: { name: string } }>) {
    const v = dealValue(r, unit);
    open_deal_value += v;
    // Volume is always the kg from the weight view, regardless of unit mode.
    open_deal_volume += dealWeightKg(r);
    open_deals += 1;
    const stageName = r.crm_deal_stages?.name ?? 'Unknown';
    const s = stageMap.get(stageName) ?? { count: 0, value: 0 };
    s.count += 1;
    s.value += v;
    stageMap.set(stageName, s);
    const ownerKey = r.owner_id ?? 'unassigned';
    const o = ownerMap.get(ownerKey) ?? { count: 0, value: 0 };
    o.count += 1;
    o.value += v;
    ownerMap.set(ownerKey, o);
  }
  const by_stage = Array.from(stageMap.entries()).map(([stage, v]) => ({ stage, count: v.count, value: v.value }));
  const by_owner = Array.from(ownerMap.entries()).map(([owner, v]) => ({ owner, count: v.count, value: v.value }));

  // Won / lost in window
  let won_revenue = 0, wonCount = 0, lostCount = 0;
  for (const r of (closedInWindow ?? []) as unknown as Array<DealWithWeight & { crm_deal_stages: { stage_type: string } | null }>) {
    const t = r.crm_deal_stages?.stage_type;
    if (t === 'won') { won_revenue += dealValue(r, unit); wonCount++; }
    if (t === 'lost') { lostCount++; }
  }
  const win_rate_30d = wonCount + lostCount > 0 ? wonCount / (wonCount + lostCount) : 0;
  const avg_deal_size = wonCount > 0 ? won_revenue / wonCount : 0;

  // Avg sales cycle (days from created_at → actual_close_date) for won deals in window
  const { data: cycleRows } = await withClient(applyOwnerScope(supabaseAdmin.from('crm_deals')
    .select('created_at, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).is('deleted_at', null).eq('crm_deal_stages.stage_type', 'won').not('actual_close_date', 'is', null)
    .gte('actual_close_date', fromDate).lte('actual_close_date', toDate), scope), client_id)
    .limit(200);
  const cycles = (cycleRows ?? []).map(r => (new Date(r.actual_close_date!).getTime() - new Date(r.created_at).getTime()) / 86400000);
  const avg_sales_cycle_days = cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : 0;

  // Pipeline velocity = (open_opps × avg_deal_size × win_rate) / cycle_days
  const pipeline_velocity = avg_sales_cycle_days > 0
    ? Math.round((open_deals * avg_deal_size * win_rate_30d) / avg_sales_cycle_days)
    : 0;

  const conversion_rate = (newInWindow ?? 0) > 0 ? (convertedInWindow ?? 0) / (newInWindow ?? 1) : 0;

  return {
    total_leads: totalLeads ?? 0,
    new_leads_30d: newInWindow ?? 0,
    open_deals,
    open_deal_value,
    open_deal_volume,
    won_deals_30d: wonCount,
    won_revenue_30d: won_revenue,
    win_rate_30d,
    avg_deal_size,
    avg_sales_cycle_days,
    pipeline_velocity,
    activities_7d: activities7d ?? 0,
    conversion_rate,
    by_stage,
    by_owner,
  };
}

export async function pipelineValue(org_id: string, pipeline_id?: string, client_id: string | null = null, unit: AnalyticsUnit = 'inr', scope?: AnalyticsScope) {
  // Live query — the MV (crm_mv_pipeline_value) doesn't track client_id, so it
  // cannot be filtered per client. Aggregate from crm_deals directly.
  const lines = unit === 'weight' ? weightJoin : '';
  let q = supabaseAdmin.from('crm_deals')
    .select(`amount, pipeline_id, crm_deal_stages!inner(name, stage_type, position)${lines}`)
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'open');
  if (pipeline_id) q = q.eq('pipeline_id', pipeline_id);
  q = withClient(q, client_id);
  q = applyOwnerScope(q, scope);
  const { data } = await q;
  const map = new Map<string, { stage: string; value: number; count: number; position: number }>();
  for (const d of (data ?? []) as unknown as Array<DealWithWeight & { crm_deal_stages: { name: string; position: number } }>) {
    const s = d.crm_deal_stages.name;
    const e = map.get(s) ?? { stage: s, value: 0, count: 0, position: d.crm_deal_stages.position ?? 0 };
    e.value += dealValue(d, unit);
    e.count += 1;
    map.set(s, e);
  }
  return Array.from(map.values()).sort((a, b) => a.position - b.position).map(({ stage, value, count }) => ({ stage, value, count }));
}

export async function funnel(org_id: string, days = 30, range?: DateRange, client_id: string | null = null, scope?: AnalyticsScope) {
  // Live query — the MV (crm_mv_funnel_daily) doesn't track client_id.
  // Aggregate from crm_leads grouped by status within the window.
  const fromIso = range?.from ?? new Date(Date.now() - days * 86400000).toISOString();
  const toIso = range?.to ?? new Date().toISOString();
  let q = supabaseAdmin.from('crm_leads').select('status')
    .eq('org_id', org_id).is('deleted_at', null)
    .gte('created_at', fromIso).lte('created_at', toIso);
  q = withClient(q, client_id);
  q = applyLeadScope(q, scope);
  const { data } = await q;
  let n_new = 0, n_qual = 0, n_conv = 0;
  for (const r of (data ?? []) as Array<{ status: string }>) {
    n_new += 1;
    if (r.status === 'qualified' || r.status === 'converted') n_qual += 1;
    if (r.status === 'converted') n_conv += 1;
  }
  return [
    { stage: 'New', count: n_new, value: 0 },
    { stage: 'Qualified', count: n_qual, value: 0 },
    { stage: 'Converted', count: n_conv, value: 0 },
  ];
}

export async function winRate(org_id: string, by: 'rep' | 'source' | 'stage', range?: DateRange, client_id: string | null = null, scope?: AnalyticsScope) {
  if (by === 'source') {
    // Live query — the MV (crm_mv_lead_source_roi) doesn't track client_id.
    let lq = supabaseAdmin.from('crm_leads')
      .select('status, source_id, crm_lead_sources(name)')
      .eq('org_id', org_id).is('deleted_at', null);
    lq = withClient(lq, client_id);
    lq = applyLeadScope(lq, scope);
    const { data } = await lq;
    const map = new Map<string, { won: number; total: number }>();
    for (const r of (data ?? []) as unknown as Array<{ status: string; crm_lead_sources?: { name?: string } | null }>) {
      const name = r.crm_lead_sources?.name ?? 'Unspecified';
      const e = map.get(name) ?? { won: 0, total: 0 };
      e.total += 1;
      if (r.status === 'converted') e.won += 1;
      map.set(name, e);
    }
    return Array.from(map.entries()).map(([bucket, v]) => ({
      bucket, won: v.won, lost: Math.max(0, v.total - v.won),
      rate: v.total > 0 ? v.won / v.total : 0,
    }));
  }
  let q = supabaseAdmin.from('crm_deals')
    .select('amount, owner_id, stage_id, created_at, crm_deal_stages!inner(name, stage_type)')
    .eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  q = applyOwnerScope(q, scope);
  if (range?.from) q = q.gte('created_at', range.from);
  if (range?.to) q = q.lte('created_at', range.to);
  const { data: deals } = await q;
  const map = new Map<string, { won: number; lost: number }>();
  for (const d of (deals ?? []) as unknown as Array<{ amount: number; owner_id?: string; stage_id: string; crm_deal_stages: { name: string; stage_type: string } }>) {
    const key = by === 'rep' ? (d.owner_id ?? 'unassigned') : d.crm_deal_stages.name;
    const e = map.get(key) ?? { won: 0, lost: 0 };
    if (d.crm_deal_stages.stage_type === 'won') e.won += 1;
    if (d.crm_deal_stages.stage_type === 'lost') e.lost += 1;
    map.set(key, e);
  }
  return Array.from(map.entries()).map(([bucket, v]) => ({
    bucket,
    won: v.won,
    lost: v.lost,
    rate: v.won + v.lost > 0 ? v.won / (v.won + v.lost) : 0,
  }));
}

export async function salesCycle(org_id: string, range?: DateRange, client_id: string | null = null) {
  let q = supabaseAdmin.from('crm_deals')
    .select('created_at, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).is('deleted_at', null).eq('crm_deal_stages.stage_type', 'won').not('actual_close_date', 'is', null);
  q = withClient(q, client_id);
  if (range?.from) q = q.gte('actual_close_date', range.from.slice(0, 10));
  if (range?.to) q = q.lte('actual_close_date', range.to.slice(0, 10));
  const { data } = await q.limit(500);
  const buckets = new Map<string, number[]>();
  for (const d of (data ?? []) as unknown as Array<{ created_at: string; actual_close_date: string }>) {
    const month = d.actual_close_date.slice(0, 7);
    const days = (new Date(d.actual_close_date).getTime() - new Date(d.created_at).getTime()) / 86400000;
    const arr = buckets.get(month) ?? [];
    arr.push(days);
    buckets.set(month, arr);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, days]) => ({ month, avg_days: Math.round(days.reduce((a, b) => a + b, 0) / days.length) }));
}

export async function forecast(org_id: string, period: 'month' | 'quarter' = 'quarter', range?: DateRange, client_id: string | null = null, unit: AnalyticsUnit = 'inr', scope?: AnalyticsScope) {
  let cutoff: string;
  let fromCutoff: string | null = null;
  if (range?.to) cutoff = range.to.slice(0, 10);
  else {
    const horizonDays = period === 'month' ? 30 : 90;
    cutoff = new Date(Date.now() + horizonDays * 86400000).toISOString().slice(0, 10);
  }
  if (range?.from) fromCutoff = range.from.slice(0, 10);

  const lines = unit === 'weight' ? weightJoin : '';

  // Open pipeline expected to close in horizon (probability-weighted vs total)
  let openQ = supabaseAdmin.from('crm_deals')
    .select(`amount, probability, expected_close_date, crm_deal_stages!inner(probability, stage_type)${lines}`)
    .eq('org_id', org_id).is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'open')
    .lte('expected_close_date', cutoff).not('expected_close_date', 'is', null);
  openQ = withClient(openQ, client_id);
  openQ = applyOwnerScope(openQ, scope);
  if (fromCutoff) openQ = openQ.gte('expected_close_date', fromCutoff);

  // Already-closed-won amounts in the same horizon (so the chart can plot a "closed" line)
  let wonQ = supabaseAdmin.from('crm_deals')
    .select(`amount, actual_close_date, crm_deal_stages!inner(stage_type)${lines}`)
    .eq('org_id', org_id).is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'won')
    .not('actual_close_date', 'is', null)
    .lte('actual_close_date', cutoff);
  wonQ = withClient(wonQ, client_id);
  wonQ = applyOwnerScope(wonQ, scope);
  if (fromCutoff) wonQ = wonQ.gte('actual_close_date', fromCutoff);

  const [{ data: openData }, { data: wonData }] = await Promise.all([openQ, wonQ]);

  const buckets = new Map<string, { committed: number; pipeline: number; closed: number }>();
  for (const d of (openData ?? []) as unknown as Array<DealWithWeight & { probability?: number; expected_close_date: string; crm_deal_stages: { probability: number } }>) {
    const month = d.expected_close_date.slice(0, 7);
    const p = d.probability ?? d.crm_deal_stages.probability ?? 50;
    const v = dealValue(d, unit);
    const e = buckets.get(month) ?? { committed: 0, pipeline: 0, closed: 0 };
    e.committed += v * p / 100;
    e.pipeline += v;
    buckets.set(month, e);
  }
  for (const d of (wonData ?? []) as unknown as Array<DealWithWeight & { actual_close_date: string }>) {
    const month = d.actual_close_date.slice(0, 7);
    const e = buckets.get(month) ?? { committed: 0, pipeline: 0, closed: 0 };
    e.closed += dealValue(d, unit);
    buckets.set(month, e);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => ({
      period,
      committed: Math.round(v.committed),
      best_case: Math.round(v.pipeline),
      pipeline: Math.round(v.pipeline),
      closed: Math.round(v.closed),
    }));
}

export async function activityHeatmap(org_id: string, client_id: string | null = null) {
  // Last 31 days × 24 hours. Returns full grid (744 rows incl. zeros) so the
  // frontend can render a date-by-hour heatmap without gap-filling.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 30);
  const { data } = await withClient(
    supabaseAdmin
      .from('crm_activities')
      .select('created_at')
      .eq('org_id', org_id)
      .is('deleted_at', null)
      .gte('created_at', since.toISOString()),
    client_id,
  );

  const counts = new Map<string, number>();
  for (const a of data ?? []) {
    const dt = new Date((a as any).created_at);
    const date = dt.toISOString().slice(0, 10);
    const hour = dt.getUTCHours();
    const key = `${date}|${hour}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const result: Array<{ date: string; hour: number; count: number }> = [];
  for (let i = 0; i < 31; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      result.push({ date, hour: h, count: counts.get(`${date}|${h}`) ?? 0 });
    }
  }
  return result;
}

export async function leadSourceRoi(org_id: string, client_id: string | null = null) {
  // Live query — the MV (crm_mv_lead_source_roi) doesn't track client_id.
  // Pull leads + their source name + cost-per-lead and any converted-deal amount.
  let lq = supabaseAdmin.from('crm_leads')
    .select('status, converted_deal_id, crm_lead_sources(name, cost_per_lead)')
    .eq('org_id', org_id).is('deleted_at', null);
  lq = withClient(lq, client_id);
  const { data: leads } = await lq;
  const dealIds = (leads ?? [])
    .map((l: any) => l.converted_deal_id)
    .filter((id: string | null) => !!id) as string[];
  let dealsById = new Map<string, number>();
  if (dealIds.length) {
    const { data: deals } = await supabaseAdmin.from('crm_deals')
      .select('id, amount, crm_deal_stages!inner(stage_type)')
      .in('id', dealIds).is('deleted_at', null).eq('crm_deal_stages.stage_type', 'won');
    for (const d of (deals ?? []) as unknown as Array<{ id: string; amount: number }>) {
      dealsById.set(d.id, Number(d.amount ?? 0));
    }
  }
  const map = new Map<string, { source: string; leads: number; deals: number; revenue: number; cost: number }>();
  for (const l of (leads ?? []) as unknown as Array<{ status: string; converted_deal_id: string | null; crm_lead_sources?: { name?: string; cost_per_lead?: number } | null }>) {
    const name = l.crm_lead_sources?.name ?? 'Unspecified';
    const cpl = Number(l.crm_lead_sources?.cost_per_lead ?? 0);
    const e = map.get(name) ?? { source: name, leads: 0, deals: 0, revenue: 0, cost: 0 };
    e.leads += 1;
    e.cost += cpl;
    if (l.converted_deal_id && dealsById.has(l.converted_deal_id)) {
      e.deals += 1;
      e.revenue += dealsById.get(l.converted_deal_id)!;
    }
    map.set(name, e);
  }
  return Array.from(map.values()).map((e) => ({
    ...e,
    roi: e.cost > 0 ? (e.revenue - e.cost) / e.cost : (e.revenue > 0 ? 1 : 0),
  }));
}

export async function leadScoreDistribution(org_id: string, range?: DateRange, client_id: string | null = null, scope?: AnalyticsScope) {
  let q = supabaseAdmin.from('crm_leads').select('score').eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  q = applyLeadScope(q, scope);
  if (range?.from) q = q.gte('created_at', range.from);
  if (range?.to) q = q.lte('created_at', range.to);
  const { data } = await q;
  const buckets = [0,10,20,30,40,50,60,70,80,90].map(lo => ({ bucket: `${lo}-${lo+9}`, count: 0, grade: gradeFor(lo) }));
  for (const r of data ?? []) {
    const s = Math.max(0, Math.min(99, Number(r.score)));
    buckets[Math.floor(s / 10)].count++;
  }
  return buckets;
}

// One-shot dashboard query — replaces 6 frontend round-trips with one. Each
// sub-query already runs against indexed tables / materialized views, so this
// just collapses the network overhead into a single response.
//
// `unit` swaps every monetary aggregation (open pipeline, won revenue, avg
// deal size, pipeline-by-stage, forecast) from rupees to kg derived from
// line items × product weight. Counts, dates, win-rate, and lead-score
// distribution stay the same.
export async function dashboardComplete(
  org_id: string,
  range?: DateRange,
  client_id: string | null = null,
  unit: AnalyticsUnit = 'inr',
  scope?: AnalyticsScope,
) {
  const [summary, funnelData, pipelineValueData, winRateData, forecastData, scoreDist] = await Promise.all([
    dashboardSummary(org_id, range, client_id, unit, scope),
    funnel(org_id, 30, range, client_id, scope),
    pipelineValue(org_id, undefined, client_id, unit, scope),
    winRate(org_id, 'rep', range, client_id, scope),
    forecast(org_id, 'quarter', range, client_id, unit, scope),
    leadScoreDistribution(org_id, range, client_id, scope),
  ]);
  return {
    summary,
    funnel: funnelData,
    pipelineValue: pipelineValueData,
    winRate: winRateData,
    forecast: forecastData,
    leadScoreDistribution: scoreDist,
    unit,
  };
}

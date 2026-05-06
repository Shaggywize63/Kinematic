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

function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

// Apply the multi-tenant client filter to any Supabase query builder. When
// client_id is provided, returns rows where client_id IS NULL OR = client_id
// (org-level defaults remain visible alongside the active client's records).
// When client_id is null, returns only org-level rows (NULL).
function withClient<T>(q: T, client_id: string | null): T {
  const qb = q as any;
  if (client_id) return qb.or(`client_id.is.null,client_id.eq.${client_id}`);
  return qb.is('client_id', null);
}

function defaultWindow(range?: DateRange) {
  const fromIso = range?.from ?? new Date(Date.now() - 30 * 86400000).toISOString();
  const toIso = range?.to ?? new Date().toISOString();
  return { fromIso, toIso };
}

export async function dashboardSummary(org_id: string, range?: DateRange, client_id: string | null = null): Promise<DashboardSummary> {
  const { fromIso, toIso } = defaultWindow(range);
  const fromDate = fromIso.slice(0, 10);
  const toDate = toIso.slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [
    { count: totalLeads },
    { count: newInWindow },
    { count: convertedInWindow },
    { data: pipelineRows },
    { data: closedInWindow },
    { count: activities7d },
  ] = await Promise.all([
    withClient(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null), client_id),
    withClient(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('created_at', fromIso).lte('created_at', toIso), client_id),
    withClient(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).eq('status', 'converted').gte('created_at', fromIso).lte('created_at', toIso), client_id),
    supabaseAdmin.from('crm_mv_pipeline_value').select('stage_name, total_amount, weighted_amount, deal_count, owner_id').eq('org_id', org_id),
    withClient(supabaseAdmin.from('crm_deals').select('amount, owner_id, crm_deal_stages!inner(stage_type)').eq('org_id', org_id).gte('actual_close_date', fromDate).lte('actual_close_date', toDate), client_id),
    withClient(supabaseAdmin.from('crm_activities').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('created_at', sevenDaysAgo), client_id),
  ]);

  const open_deal_value = (pipelineRows ?? []).reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
  const open_deals = (pipelineRows ?? []).reduce((s, r) => s + Number(r.deal_count ?? 0), 0);

  // by_stage / by_owner rollups from the pipeline-value MV
  const stageMap = new Map<string, { count: number; value: number }>();
  const ownerMap = new Map<string, { count: number; value: number }>();
  for (const r of (pipelineRows ?? []) as Array<{ stage_name: string; total_amount: number; deal_count: number; owner_id?: string | null }>) {
    const s = stageMap.get(r.stage_name) ?? { count: 0, value: 0 };
    s.count += Number(r.deal_count ?? 0);
    s.value += Number(r.total_amount ?? 0);
    stageMap.set(r.stage_name, s);
    const ownerKey = r.owner_id ?? 'unassigned';
    const o = ownerMap.get(ownerKey) ?? { count: 0, value: 0 };
    o.count += Number(r.deal_count ?? 0);
    o.value += Number(r.total_amount ?? 0);
    ownerMap.set(ownerKey, o);
  }
  const by_stage = Array.from(stageMap.entries()).map(([stage, v]) => ({ stage, count: v.count, value: v.value }));
  const by_owner = Array.from(ownerMap.entries()).map(([owner, v]) => ({ owner, count: v.count, value: v.value }));

  // Won / lost in window
  let won_revenue = 0, wonCount = 0, lostCount = 0;
  for (const r of (closedInWindow ?? []) as unknown as Array<{ amount: number; crm_deal_stages: { stage_type: string } | null }>) {
    const t = r.crm_deal_stages?.stage_type;
    if (t === 'won') { won_revenue += Number(r.amount); wonCount++; }
    if (t === 'lost') { lostCount++; }
  }
  const win_rate_30d = wonCount + lostCount > 0 ? wonCount / (wonCount + lostCount) : 0;
  const avg_deal_size = wonCount > 0 ? won_revenue / wonCount : 0;

  // Avg sales cycle (days from created_at → actual_close_date) for won deals in window
  const { data: cycleRows } = await withClient(supabaseAdmin.from('crm_deals')
    .select('created_at, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).eq('crm_deal_stages.stage_type', 'won').not('actual_close_date', 'is', null)
    .gte('actual_close_date', fromDate).lte('actual_close_date', toDate), client_id)
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

export async function pipelineValue(org_id: string, pipeline_id?: string) {
  let q = supabaseAdmin.from('crm_mv_pipeline_value')
    .select('stage_name, total_amount, deal_count, stage_id, pipeline_id')
    .eq('org_id', org_id);
  if (pipeline_id) q = q.eq('pipeline_id', pipeline_id);
  const { data } = await q;
  // Collapse rows that share a stage_name (the MV groups by stage+owner)
  const map = new Map<string, { value: number; count: number }>();
  for (const r of (data ?? []) as Array<{ stage_name: string; total_amount: number; deal_count: number }>) {
    const e = map.get(r.stage_name) ?? { value: 0, count: 0 };
    e.value += Number(r.total_amount ?? 0);
    e.count += Number(r.deal_count ?? 0);
    map.set(r.stage_name, e);
  }
  return Array.from(map.entries()).map(([stage, v]) => ({ stage, value: v.value, count: v.count }));
}

export async function funnel(org_id: string, days = 30, range?: DateRange) {
  let since: string;
  if (range?.from) since = range.from.slice(0, 10);
  else since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let q = supabaseAdmin.from('crm_mv_funnel_daily').select('new_leads, qualified_leads, converted_leads, unqualified_leads').eq('org_id', org_id).gte('day', since);
  if (range?.to) q = q.lte('day', range.to.slice(0, 10));
  const { data } = await q;
  const totals = { new: 0, qualified: 0, converted: 0, unqualified: 0 };
  for (const r of (data ?? []) as Array<{ new_leads: number; qualified_leads: number; converted_leads: number; unqualified_leads: number }>) {
    totals.new += Number(r.new_leads ?? 0);
    totals.qualified += Number(r.qualified_leads ?? 0);
    totals.converted += Number(r.converted_leads ?? 0);
    totals.unqualified += Number(r.unqualified_leads ?? 0);
  }
  return [
    { stage: 'New', count: totals.new, value: 0 },
    { stage: 'Qualified', count: totals.qualified, value: 0 },
    { stage: 'Converted', count: totals.converted, value: 0 },
  ];
}

export async function winRate(org_id: string, by: 'rep' | 'source' | 'stage', range?: DateRange, client_id: string | null = null) {
  if (by === 'source') {
    const { data } = await supabaseAdmin.from('crm_mv_lead_source_roi').select('source_name, lead_count, converted_count').eq('org_id', org_id);
    return (data ?? []).map((r: any) => {
      const won = Number(r.converted_count ?? 0);
      const total = Number(r.lead_count ?? 0);
      const lost = Math.max(0, total - won);
      return {
        bucket: r.source_name ?? 'Unspecified',
        won,
        lost,
        rate: won + lost > 0 ? won / (won + lost) : 0,
      };
    });
  }
  let q = supabaseAdmin.from('crm_deals')
    .select('amount, owner_id, stage_id, created_at, crm_deal_stages!inner(name, stage_type)')
    .eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
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
    .eq('org_id', org_id).eq('crm_deal_stages.stage_type', 'won').not('actual_close_date', 'is', null);
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

export async function forecast(org_id: string, period: 'month' | 'quarter' = 'quarter', range?: DateRange, client_id: string | null = null) {
  let cutoff: string;
  let fromCutoff: string | null = null;
  if (range?.to) cutoff = range.to.slice(0, 10);
  else {
    const horizonDays = period === 'month' ? 30 : 90;
    cutoff = new Date(Date.now() + horizonDays * 86400000).toISOString().slice(0, 10);
  }
  if (range?.from) fromCutoff = range.from.slice(0, 10);

  // Open pipeline expected to close in horizon (probability-weighted vs total)
  let openQ = supabaseAdmin.from('crm_deals')
    .select('amount, probability, expected_close_date, crm_deal_stages!inner(probability, stage_type)')
    .eq('org_id', org_id).is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'open')
    .lte('expected_close_date', cutoff).not('expected_close_date', 'is', null);
  openQ = withClient(openQ, client_id);
  if (fromCutoff) openQ = openQ.gte('expected_close_date', fromCutoff);

  // Already-closed-won amounts in the same horizon (so the chart can plot a "closed" line)
  let wonQ = supabaseAdmin.from('crm_deals')
    .select('amount, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'won')
    .not('actual_close_date', 'is', null)
    .lte('actual_close_date', cutoff);
  wonQ = withClient(wonQ, client_id);
  if (fromCutoff) wonQ = wonQ.gte('actual_close_date', fromCutoff);

  const [{ data: openData }, { data: wonData }] = await Promise.all([openQ, wonQ]);

  const buckets = new Map<string, { committed: number; pipeline: number; closed: number }>();
  for (const d of (openData ?? []) as unknown as Array<{ amount: number; probability?: number; expected_close_date: string; crm_deal_stages: { probability: number } }>) {
    const month = d.expected_close_date.slice(0, 7);
    const p = d.probability ?? d.crm_deal_stages.probability ?? 50;
    const e = buckets.get(month) ?? { committed: 0, pipeline: 0, closed: 0 };
    e.committed += Number(d.amount) * p / 100;
    e.pipeline += Number(d.amount);
    buckets.set(month, e);
  }
  for (const d of (wonData ?? []) as unknown as Array<{ amount: number; actual_close_date: string }>) {
    const month = d.actual_close_date.slice(0, 7);
    const e = buckets.get(month) ?? { committed: 0, pipeline: 0, closed: 0 };
    e.closed += Number(d.amount);
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

export async function leadSourceRoi(org_id: string) {
  const { data } = await supabaseAdmin
    .from('crm_mv_lead_source_roi')
    .select('*')
    .eq('org_id', org_id);

  // Transform raw MV columns to the canonical SourceROIRow shape the frontend expects.
  return (data ?? []).map((r: any) => {
    const revenue = Number(r.revenue_won ?? 0);
    const cost = Number(r.total_cost ?? 0);
    const leads = Number(r.lead_count ?? 0);
    const deals = Number(r.converted_count ?? 0);
    const roi = cost > 0 ? (revenue - cost) / cost : (revenue > 0 ? 1 : 0);
    return {
      source: r.source_name ?? 'Unspecified',
      leads,
      deals,
      revenue,
      cost,
      roi,
    };
  });
}

export async function leadScoreDistribution(org_id: string, range?: DateRange, client_id: string | null = null) {
  let q = supabaseAdmin.from('crm_leads').select('score').eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
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
export async function dashboardComplete(
  org_id: string,
  range?: DateRange,
  client_id: string | null = null,
) {
  const [summary, funnelData, pipelineValueData, winRateData, forecastData, scoreDist] = await Promise.all([
    dashboardSummary(org_id, range, client_id),
    funnel(org_id, 30, range),
    pipelineValue(org_id),
    winRate(org_id, 'rep', range, client_id),
    forecast(org_id, 'quarter', range, client_id),
    leadScoreDistribution(org_id, range, client_id),
  ]);
  return {
    summary,
    funnel: funnelData,
    pipelineValue: pipelineValueData,
    winRate: winRateData,
    forecast: forecastData,
    leadScoreDistribution: scoreDist,
  };
}

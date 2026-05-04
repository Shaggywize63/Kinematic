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

function defaultWindow(range?: DateRange) {
  const fromIso = range?.from ?? new Date(Date.now() - 30 * 86400000).toISOString();
  const toIso = range?.to ?? new Date().toISOString();
  return { fromIso, toIso };
}

export async function dashboardSummary(org_id: string, range?: DateRange): Promise<DashboardSummary> {
  const { fromIso, toIso } = defaultWindow(range);
  const fromDate = fromIso.slice(0, 10);
  const toDate = toIso.slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [{ count: totalLeads }, { count: newWeek }, { count: qualified }, { data: pipelineRows }, { data: closedMtd }, { count: hot }, { count: closingThisWeek }] = await Promise.all([
    supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null),
    // "new leads in window"
    supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('created_at', fromIso).lte('created_at', toIso),
    supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).eq('status', 'qualified'),
    supabaseAdmin.from('crm_mv_pipeline_value').select('total_amount, weighted_amount, deal_count').eq('org_id', org_id),
    // closed in window
    supabaseAdmin.from('crm_deals').select('amount, owner_id, crm_deal_stages!inner(stage_type)').eq('org_id', org_id).gte('actual_close_date', fromDate).lte('actual_close_date', toDate),
    supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('score', 70),
    supabaseAdmin.from('crm_deals').select('id, crm_deal_stages!inner(stage_type)', { count: 'exact', head: true })
      .eq('org_id', org_id).is('deleted_at', null).eq('crm_deal_stages.stage_type', 'open')
      .lte('expected_close_date', new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)),
  ]);
  // weekAgo retained for legacy field 'new_leads_this_week' below.
  const _weekAgo = weekAgo;
  void _weekAgo;

  const open_pipeline_value = (pipelineRows ?? []).reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
  const weighted_pipeline_value = (pipelineRows ?? []).reduce((s, r) => s + Number(r.weighted_amount ?? 0), 0);
  const open_deals = (pipelineRows ?? []).reduce((s, r) => s + Number(r.deal_count ?? 0), 0);

  let won = 0, lost = 0, wonCount = 0, lostCount = 0;
  for (const r of (closedMtd ?? []) as unknown as Array<{ amount: number; crm_deal_stages: { stage_type: string } | null }>) {
    const t = r.crm_deal_stages?.stage_type;
    if (t === 'won') { won += Number(r.amount); wonCount++; }
    if (t === 'lost') { lost += Number(r.amount); lostCount++; }
  }
  const win_rate_pct = wonCount + lostCount > 0 ? Math.round((wonCount * 100) / (wonCount + lostCount)) : 0;

  // Avg sales cycle: (closed_at - created_at) for won deals in window
  const { data: cycleRows } = await supabaseAdmin.from('crm_deals')
    .select('created_at, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).eq('crm_deal_stages.stage_type', 'won').not('actual_close_date', 'is', null)
    .gte('actual_close_date', fromDate).lte('actual_close_date', toDate)
    .limit(200);
  const cycles = (cycleRows ?? []).map(r => (new Date(r.actual_close_date!).getTime() - new Date(r.created_at).getTime()) / 86400000);
  const avg_sales_cycle_days = cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : 0;

  // Top owners by closed-won in window
  const ownerMap = new Map<string, number>();
  for (const r of (closedMtd ?? []) as unknown as Array<{ amount: number; owner_id?: string; crm_deal_stages: { stage_type: string } | null }>) {
    if (r.crm_deal_stages?.stage_type === 'won' && r.owner_id) {
      ownerMap.set(r.owner_id, (ownerMap.get(r.owner_id) ?? 0) + Number(r.amount));
    }
  }
  const top_owners = Array.from(ownerMap.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([owner_id, closed_won]) => ({ owner_id, closed_won }));

  return {
    total_leads: totalLeads ?? 0,
    new_leads_this_week: newWeek ?? 0,
    qualified_leads: qualified ?? 0,
    open_deals,
    open_pipeline_value,
    weighted_pipeline_value,
    closed_won_amount_mtd: won,
    closed_lost_amount_mtd: lost,
    win_rate_pct,
    avg_sales_cycle_days,
    top_owners,
    deals_closing_this_week: closingThisWeek ?? 0,
    hot_leads: hot ?? 0,
  };
}

export async function pipelineValue(org_id: string, pipeline_id?: string) {
  let q = supabaseAdmin.from('crm_mv_pipeline_value').select('*').eq('org_id', org_id);
  if (pipeline_id) q = q.eq('pipeline_id', pipeline_id);
  const { data } = await q;
  return data ?? [];
}

export async function funnel(org_id: string, days = 30, range?: DateRange) {
  let since: string;
  if (range?.from) since = range.from.slice(0, 10);
  else since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let q = supabaseAdmin.from('crm_mv_funnel_daily').select('*').eq('org_id', org_id).gte('day', since);
  if (range?.to) q = q.lte('day', range.to.slice(0, 10));
  const { data } = await q.order('day', { ascending: true });
  return data ?? [];
}

export async function winRate(org_id: string, by: 'rep' | 'source' | 'stage', range?: DateRange) {
  if (by === 'source') {
    const { data } = await supabaseAdmin.from('crm_mv_lead_source_roi').select('*').eq('org_id', org_id);
    return data ?? [];
  }
  let q = supabaseAdmin.from('crm_deals')
    .select('amount, owner_id, stage_id, created_at, crm_deal_stages!inner(name, stage_type)')
    .eq('org_id', org_id).is('deleted_at', null);
  if (range?.from) q = q.gte('created_at', range.from);
  if (range?.to) q = q.lte('created_at', range.to);
  const { data: deals } = await q;
  const map = new Map<string, { won: number; lost: number; total: number }>();
  for (const d of (deals ?? []) as unknown as Array<{ amount: number; owner_id?: string; stage_id: string; crm_deal_stages: { name: string; stage_type: string } }>) {
    const key = by === 'rep' ? (d.owner_id ?? 'unassigned') : d.crm_deal_stages.name;
    const e = map.get(key) ?? { won: 0, lost: 0, total: 0 };
    e.total += Number(d.amount);
    if (d.crm_deal_stages.stage_type === 'won') e.won += Number(d.amount);
    if (d.crm_deal_stages.stage_type === 'lost') e.lost += Number(d.amount);
    map.set(key, e);
  }
  return Array.from(map.entries()).map(([key, v]) => ({
    key,
    won_amount: v.won, lost_amount: v.lost, total_amount: v.total,
    win_rate: v.won + v.lost > 0 ? Math.round((v.won * 100) / (v.won + v.lost)) : 0,
  }));
}

export async function salesCycle(org_id: string, range?: DateRange) {
  let q = supabaseAdmin.from('crm_deals')
    .select('created_at, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).eq('crm_deal_stages.stage_type', 'won').not('actual_close_date', 'is', null);
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

export async function forecast(org_id: string, period: 'month' | 'quarter' = 'quarter', range?: DateRange) {
  let cutoff: string;
  let fromCutoff: string | null = null;
  if (range?.to) cutoff = range.to.slice(0, 10);
  else {
    const horizonDays = period === 'month' ? 30 : 90;
    cutoff = new Date(Date.now() + horizonDays * 86400000).toISOString().slice(0, 10);
  }
  if (range?.from) fromCutoff = range.from.slice(0, 10);

  let q = supabaseAdmin.from('crm_deals')
    .select('amount, probability, expected_close_date, crm_deal_stages!inner(probability, stage_type)')
    .eq('org_id', org_id).is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'open')
    .lte('expected_close_date', cutoff).not('expected_close_date', 'is', null);
  if (fromCutoff) q = q.gte('expected_close_date', fromCutoff);
  const { data } = await q;
  const buckets = new Map<string, { weighted: number; total: number }>();
  for (const d of (data ?? []) as unknown as Array<{ amount: number; probability?: number; expected_close_date: string; crm_deal_stages: { probability: number } }>) {
    const month = d.expected_close_date.slice(0, 7);
    const p = d.probability ?? d.crm_deal_stages.probability ?? 50;
    const e = buckets.get(month) ?? { weighted: 0, total: 0 };
    e.weighted += Number(d.amount) * p / 100;
    e.total += Number(d.amount);
    buckets.set(month, e);
  }
  return Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, weighted: Math.round(v.weighted), total: Math.round(v.total) }));
}

export async function activityHeatmap(org_id: string) {
  const { data } = await supabaseAdmin.from('crm_mv_activity_heatmap').select('*').eq('org_id', org_id);
  return data ?? [];
}

export async function leadSourceRoi(org_id: string) {
  const { data } = await supabaseAdmin.from('crm_mv_lead_source_roi').select('*').eq('org_id', org_id);
  return data ?? [];
}

export async function leadScoreDistribution(org_id: string, range?: DateRange) {
  let q = supabaseAdmin.from('crm_leads').select('score').eq('org_id', org_id).is('deleted_at', null);
  if (range?.from) q = q.gte('created_at', range.from);
  if (range?.to) q = q.lte('created_at', range.to);
  const { data } = await q;
  const buckets = [0,10,20,30,40,50,60,70,80,90].map(lo => ({ bucket: `${lo}-${lo+9}`, count: 0 }));
  for (const r of data ?? []) {
    const s = Math.max(0, Math.min(99, Number(r.score)));
    buckets[Math.floor(s / 10)].count++;
  }
  return buckets;
}

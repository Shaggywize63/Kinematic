import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest } from '../../utils';

export const dashboardSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { from, to } = req.query as Record<string, string>;

  const [leads, deals, activities, contacts] = await Promise.all([
    supabaseAdmin.from('crm_leads').select('id,status,score', { count: 'exact' })
      .eq('org_id', org_id).is('deleted_at', null),
    supabaseAdmin.from('crm_deals').select('id,status,amount,stage_id', { count: 'exact' })
      .eq('org_id', org_id).is('deleted_at', null),
    supabaseAdmin.from('crm_activities').select('id,type,status', { count: 'exact' })
      .eq('org_id', org_id).is('deleted_at', null),
    supabaseAdmin.from('crm_contacts').select('id', { count: 'exact' })
      .eq('org_id', org_id).is('deleted_at', null),
  ]);

  const leadsData = leads.data || [];
  const dealsData = deals.data || [];

  const openDeals = dealsData.filter((d) => d.status === 'open');
  const wonDeals = dealsData.filter((d) => d.status === 'won');
  const pipelineValue = openDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
  const closedRevenue = wonDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
  const winRate = dealsData.length > 0
    ? Math.round((wonDeals.length / dealsData.filter((d) => d.status !== 'open').length) * 100) || 0
    : 0;
  const avgScore = leadsData.length > 0
    ? Math.round(leadsData.reduce((sum, l) => sum + (l.score || 0), 0) / leadsData.length)
    : 0;

  return ok(res, {
    total_leads: leads.count || 0,
    new_leads: leadsData.filter((l) => l.status === 'new').length,
    qualified_leads: leadsData.filter((l) => l.status === 'qualified').length,
    converted_leads: leadsData.filter((l) => l.status === 'converted').length,
    total_deals: deals.count || 0,
    open_deals: openDeals.length,
    won_deals: wonDeals.length,
    lost_deals: dealsData.filter((d) => d.status === 'lost').length,
    pipeline_value: pipelineValue,
    closed_revenue: closedRevenue,
    win_rate: winRate,
    avg_lead_score: avgScore,
    total_contacts: contacts.count || 0,
    total_activities: activities.count || 0,
    overdue_tasks: (activities.data || []).filter((a) => a.type === 'task' && a.status === 'open').length,
  });
});

export const pipelineValue = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin
    .from('crm_deals')
    .select('stage_id, stage:crm_deal_stages(name,position), amount, status')
    .eq('org_id', org_id).eq('status', 'open').is('deleted_at', null);
  if (error) return badRequest(res, error.message);

  const byStage: Record<string, { stage: string; value: number; count: number }> = {};
  for (const d of data || []) {
    const stageName = (d.stage as any)?.name || 'Unknown';
    if (!byStage[stageName]) byStage[stageName] = { stage: stageName, value: 0, count: 0 };
    byStage[stageName].value += d.amount || 0;
    byStage[stageName].count += 1;
  }
  return ok(res, Object.values(byStage));
});

export const funnel = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_leads').select('status')
    .eq('org_id', org_id).is('deleted_at', null);
  if (error) return badRequest(res, error.message);

  const counts: Record<string, number> = {};
  for (const l of data || []) counts[l.status] = (counts[l.status] || 0) + 1;
  const order = ['new', 'working', 'qualified', 'converted', 'unqualified'];
  return ok(res, order.map((s) => ({ stage: s, count: counts[s] || 0 })));
});

export const winRate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const by = (req.query.by as string) || 'rep';
  const { data, error } = await supabaseAdmin.from('crm_deals').select('status,owner_id,stage_id,amount')
    .eq('org_id', org_id).is('deleted_at', null).neq('status', 'open');
  if (error) return badRequest(res, error.message);

  const grouped: Record<string, { won: number; lost: number; total: number; revenue: number }> = {};
  for (const d of data || []) {
    const key = d.owner_id || 'unassigned';
    if (!grouped[key]) grouped[key] = { won: 0, lost: 0, total: 0, revenue: 0 };
    grouped[key].total += 1;
    if (d.status === 'won') { grouped[key].won += 1; grouped[key].revenue += d.amount || 0; }
    else grouped[key].lost += 1;
  }
  return ok(res, Object.entries(grouped).map(([key, v]) => ({
    name: key, won: v.won, lost: v.lost, total: v.total,
    win_rate: v.total > 0 ? Math.round((v.won / v.total) * 100) : 0,
    revenue: v.revenue,
  })));
});

export const salesCycle = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deal_history').select('from_stage_id,to_stage_id,created_at,deal_id')
    .eq('org_id', org_id).order('created_at');
  if (error) return badRequest(res, error.message);
  // Return stage names with placeholder days
  return ok(res, []);
});

export const forecast = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_deals')
    .select('amount,probability,expected_close_date,status')
    .eq('org_id', org_id).eq('status', 'open').is('deleted_at', null).not('expected_close_date', 'is', null);
  if (error) return badRequest(res, error.message);

  const byMonth: Record<string, { month: string; weighted_value: number; total_value: number; deal_count: number }> = {};
  for (const d of data || []) {
    const month = d.expected_close_date?.substring(0, 7) || 'Unknown';
    if (!byMonth[month]) byMonth[month] = { month, weighted_value: 0, total_value: 0, deal_count: 0 };
    byMonth[month].total_value += d.amount || 0;
    byMonth[month].weighted_value += (d.amount || 0) * ((d.probability || 50) / 100);
    byMonth[month].deal_count += 1;
  }
  return ok(res, Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)));
});

export const activityHeatmap = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_activities').select('created_at,type')
    .eq('org_id', org_id).is('deleted_at', null)
    .gte('created_at', new Date(Date.now() - 90 * 864e5).toISOString());
  if (error) return badRequest(res, error.message);

  const counts: Record<string, number> = {};
  for (const a of data || []) {
    const d = new Date(a.created_at);
    const key = `${d.getDay()}-${d.getHours()}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return ok(res, Object.entries(counts).map(([k, v]) => {
    const [day, hour] = k.split('-').map(Number);
    return { day, hour, count: v };
  }));
});

export const leadSourceRoi = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_leads')
    .select('source_id, source:crm_lead_sources(name), is_converted')
    .eq('org_id', org_id).is('deleted_at', null);
  if (error) return badRequest(res, error.message);

  const bySource: Record<string, { name: string; leads: number; converted: number }> = {};
  for (const l of data || []) {
    const key = l.source_id || 'none';
    const name = (l.source as any)?.name || 'Unknown';
    if (!bySource[key]) bySource[key] = { name, leads: 0, converted: 0 };
    bySource[key].leads += 1;
    if (l.is_converted) bySource[key].converted += 1;
  }
  return ok(res, Object.values(bySource).map((s) => ({
    ...s, conversion_rate: s.leads > 0 ? Math.round((s.converted / s.leads) * 100) : 0,
  })));
});

export const leadScoreDistribution = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_leads')
    .select('score_grade').eq('org_id', org_id).is('deleted_at', null);
  if (error) return badRequest(res, error.message);
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const l of data || []) counts[l.score_grade || 'D'] = (counts[l.score_grade || 'D'] || 0) + 1;
  return ok(res, Object.entries(counts).map(([grade, count]) => ({ grade, count })));
});

export const byState = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data, error } = await supabaseAdmin.from('crm_leads').select('state')
    .eq('org_id', org_id).is('deleted_at', null).not('state', 'is', null);
  if (error) return badRequest(res, error.message);
  const counts: Record<string, number> = {};
  for (const l of data || []) counts[l.state] = (counts[l.state] || 0) + 1;
  return ok(res, Object.entries(counts).map(([state, count]) => ({ state, count })));
});

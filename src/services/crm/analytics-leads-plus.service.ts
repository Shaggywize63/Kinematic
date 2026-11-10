/**
 * Lead Management "plus" analytics — the extra Lead Analytics widgets and the
 * report pages behind them (source performance, follow-up compliance, owner
 * workload & SLA, stage velocity, activity mix, conversion time, weighted
 * pipeline, deal size, win-rate trend, call connect trend, lead recycling).
 *
 * Every function follows the neighbouring analytics exactly:
 *   - org scoping (`org_id`) and soft-delete (`deleted_at is null`);
 *   - the optional client scope (`client_id`);
 *   - the caller's per-request AnalyticsScope (city / owner subtree / own-only):
 *     leads via applyLeadScope, deals via applyOwnerScope, activities via
 *     applyActivityScope, so the numbers line up with the leads list;
 *   - no PostgREST embeds (they fail silently on a stale schema cache): stage,
 *     source, user and history rows are fetched separately and joined here;
 *   - id lists are batched with `chunk()` so request URLs stay short;
 *   - sparse data never errors: an org with nothing gets empty rows and zeros.
 *
 * Only columns that the existing analytics already read are used. Metrics that
 * would need data we do not capture are deliberately absent.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { chunk } from '../../lib/chunk';
import {
  applyActivityScope,
  applyLeadScope,
  applyOwnerScope,
  resolveSourceNames,
  type AnalyticsScope,
} from './analytics.service';
import {
  DAY_MS,
  DAY_BUCKETS,
  DEAL_SIZE_BANDS,
  NEGATIVE_LEAD_STATUSES,
  activityBucket,
  assertUuid,
  avg,
  callOutcome,
  dayBucket,
  dealSizeBand,
  intParam,
  median,
  mondayOf,
  monthKey,
  pct,
  percentile,
  resolveWindow,
  round1,
} from './analytics-plus.helpers';

export interface PlusRange { from?: string; to?: string }

/* eslint-disable @typescript-eslint/no-explicit-any */
function withClient<T>(q: T, client_id: string | null): T {
  const qb = q as any;
  return client_id ? qb.eq('client_id', client_id) : qb;
}

function leadsQuery(org_id: string, client_id: string | null, cols: string, scope?: AnalyticsScope) {
  let q: any = supabaseAdmin.from('crm_leads').select(cols).eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  return applyLeadScope(q, scope);
}

function dealsQuery(org_id: string, client_id: string | null, cols: string, scope?: AnalyticsScope) {
  let q: any = supabaseAdmin.from('crm_deals').select(cols).eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  return applyOwnerScope(q, scope);
}

function activitiesQuery(org_id: string, client_id: string | null, cols: string, scope?: AnalyticsScope) {
  let q: any = supabaseAdmin.from('crm_activities').select(cols).eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  return applyActivityScope(q, scope);
}

/** user id -> display name, one batched lookup per 200 ids. */
async function ownerNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(ids.filter((i): i is string => !!i)));
  const out = new Map<string, string>();
  for (const part of chunk(uniq, 200)) {
    const { data } = await supabaseAdmin.from('users').select('id, name, email').in('id', part);
    for (const u of (data ?? []) as Array<{ id: string; name?: string | null; email?: string | null }>) {
      out.set(u.id, u.name?.trim() || u.email?.trim() || 'User');
    }
  }
  return out;
}
const nameOf = (names: Map<string, string>, id: string | null) => (id ? names.get(id) ?? 'User' : 'Unassigned');

/** map.get(key), creating it with `make()` on first use. */
function slot<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) { v = make(); map.set(key, v); }
  return v;
}

interface StageRow { id: string; name: string; position: number; stage_type: string; probability: number; pipeline_id: string }
async function loadStages(org_id: string, pipeline_id?: string): Promise<StageRow[]> {
  let q: any = supabaseAdmin.from('crm_deal_stages').select('id, name, position, stage_type, probability, pipeline_id').eq('org_id', org_id);
  if (pipeline_id) q = q.eq('pipeline_id', pipeline_id);
  const { data } = await q.order('position', { ascending: true });
  return ((data ?? []) as any[]).map((s) => ({
    id: s.id, name: s.name ?? 'Stage', position: Number(s.position ?? 0), stage_type: s.stage_type ?? 'open',
    probability: Number(s.probability ?? 0), pipeline_id: s.pipeline_id,
  }));
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Lead source performance
// ═════════════════════════════════════════════════════════════════════════
export interface SourcePerformanceRow {
  source_id: string | null;
  source: string;
  leads: number;
  qualified: number;          // qualified + converted (same basis as the funnel)
  converted: number;
  lost: number;
  unqualified: number;
  open: number;
  qualified_pct: number | null;
  conversion_pct: number | null;
  share_of_leads_pct: number | null;
  avg_days_to_convert: number | null;
  avg_score: number | null;
  won_value: number;
  revenue_per_lead: number | null;
  cost_per_lead: number;
  total_cost: number;
  cost_per_converted: number | null;
}

/** Leads CREATED in the window, grouped by source, with how far each source got. */
export async function sourcePerformance(org_id: string, client_id: string | null, range?: PlusRange, scope?: AnalyticsScope) {
  const w = resolveWindow(range, 90);
  const { data } = await leadsQuery(org_id, client_id, 'source_id, status, created_at, converted_at, converted_deal_id, score', scope)
    .gte('created_at', w.fromIso).lte('created_at', w.toIso).range(0, 99999);
  const leads = (data ?? []) as Array<{
    source_id: string | null; status: string | null; created_at: string; converted_at: string | null;
    converted_deal_id: string | null; score: number | null;
  }>;

  const srcNames = await resolveSourceNames(leads.map((l) => l.source_id));

  // Won value: the amount of the won deal each converted lead produced (same rule as Lead Source ROI).
  const dealIds = Array.from(new Set(leads.map((l) => l.converted_deal_id).filter((x): x is string => !!x)));
  const wonAmount = new Map<string, number>();
  if (dealIds.length) {
    const stages = await loadStages(org_id);
    const wonStageIds = new Set(stages.filter((s) => s.stage_type === 'won').map((s) => s.id));
    for (const part of chunk(dealIds, 200)) {
      const { data: deals } = await supabaseAdmin.from('crm_deals').select('id, amount, stage_id')
        .eq('org_id', org_id).is('deleted_at', null).in('id', part);
      for (const d of (deals ?? []) as Array<{ id: string; amount: number | null; stage_id: string | null }>) {
        if (d.stage_id && wonStageIds.has(d.stage_id)) wonAmount.set(d.id, Number(d.amount ?? 0));
      }
    }
  }

  type Acc = {
    source_id: string | null; source: string; cpl: number; leads: number; qualified: number; converted: number; lost: number;
    unqualified: number; open: number; days: number[]; score: number[]; won_value: number;
  };
  const map = new Map<string, Acc>();
  const blank = (id: string | null, name: string, cpl: number): Acc =>
    ({ source_id: id, source: name, cpl, leads: 0, qualified: 0, converted: 0, lost: 0, unqualified: 0, open: 0, days: [], score: [], won_value: 0 });
  for (const l of leads) {
    const key = l.source_id ?? 'none';
    const src = l.source_id ? srcNames.get(l.source_id) : undefined;
    const a = map.get(key) ?? blank(l.source_id, src?.name?.trim() || 'Unspecified', Number(src?.cost_per_lead ?? 0));
    const st = String(l.status ?? '').toLowerCase();
    a.leads++;
    if (st === 'qualified' || st === 'converted') a.qualified++;
    if (st === 'converted') {
      a.converted++;
      if (l.converted_at) {
        const days = (Date.parse(l.converted_at) - Date.parse(l.created_at)) / DAY_MS;
        if (Number.isFinite(days) && days >= 0) a.days.push(days);
      }
      if (l.converted_deal_id && wonAmount.has(l.converted_deal_id)) a.won_value += wonAmount.get(l.converted_deal_id)!;
    } else if (st === 'lost') a.lost++;
    else if (st === 'unqualified') a.unqualified++;
    else a.open++;
    if (typeof l.score === 'number' && Number.isFinite(l.score)) a.score.push(l.score);
    map.set(key, a);
  }

  const total = leads.length;
  const toRow = (a: Acc): SourcePerformanceRow => {
    const totalCost = a.leads * a.cpl;
    return {
      source_id: a.source_id, source: a.source, leads: a.leads, qualified: a.qualified, converted: a.converted,
      lost: a.lost, unqualified: a.unqualified, open: a.open,
      qualified_pct: pct(a.qualified, a.leads), conversion_pct: pct(a.converted, a.leads),
      share_of_leads_pct: pct(a.leads, total),
      avg_days_to_convert: a.days.length ? round1(avg(a.days)!) : null,
      avg_score: a.score.length ? round1(avg(a.score)!) : null,
      won_value: Math.round(a.won_value),
      revenue_per_lead: a.leads > 0 ? Math.round(a.won_value / a.leads) : null,
      cost_per_lead: a.cpl, total_cost: Math.round(totalCost),
      cost_per_converted: a.converted > 0 && totalCost > 0 ? Math.round(totalCost / a.converted) : null,
    };
  };
  const rows = Array.from(map.values()).map(toRow).sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source));

  const sum = <K extends keyof SourcePerformanceRow>(k: K) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const allDays = Array.from(map.values()).flatMap((a) => a.days);
  const allScore = Array.from(map.values()).flatMap((a) => a.score);
  const totalCost = sum('total_cost');
  const converted = sum('converted');
  const totals: SourcePerformanceRow = {
    source_id: null, source: 'All sources', leads: total, qualified: sum('qualified'), converted, lost: sum('lost'),
    unqualified: sum('unqualified'), open: sum('open'),
    qualified_pct: pct(sum('qualified'), total), conversion_pct: pct(converted, total), share_of_leads_pct: total ? 100 : null,
    avg_days_to_convert: allDays.length ? round1(avg(allDays)!) : null,
    avg_score: allScore.length ? round1(avg(allScore)!) : null,
    won_value: sum('won_value'), revenue_per_lead: total > 0 ? Math.round(sum('won_value') / total) : null,
    cost_per_lead: total > 0 ? Math.round(totalCost / total) : 0, total_cost: totalCost,
    cost_per_converted: converted > 0 && totalCost > 0 ? Math.round(totalCost / converted) : null,
  };
  return { rows, totals, from: w.fromIso, to: w.toIso };
}

// ═════════════════════════════════════════════════════════════════════════
// 2. Follow-up compliance
// ═════════════════════════════════════════════════════════════════════════
export interface FollowupRow {
  owner_id: string | null;
  owner: string;
  due: number;
  on_time: number;
  late: number;
  overdue: number;
  upcoming: number;
  done_untimed: number;
  compliance_pct: number | null;
  avg_days_late: number | null;
  avg_days_overdue: number | null;
}

/**
 * Scheduled activities (anything with a due time) whose due time falls in the
 * window, split by what happened to them. Cancelled ones are ignored.
 *   on time  = completed at or before the due time
 *   late     = completed after the due time
 *   overdue  = not completed and the due time has passed
 *   upcoming = not completed and still in the future
 * Compliance % = on time / (on time + late + overdue). Items marked done with
 * no completion time are shown separately and left out of the %.
 */
export async function followupCompliance(org_id: string, client_id: string | null, range?: PlusRange, scope?: AnalyticsScope, nowMs = Date.now()) {
  const w = resolveWindow(range, 30, nowMs);
  const { data } = await activitiesQuery(org_id, client_id, 'owner_id, assigned_to, due_at, completed_at, status', scope)
    .not('due_at', 'is', null).gte('due_at', w.fromIso).lte('due_at', w.toIso).range(0, 99999);
  const acts = ((data ?? []) as Array<{ owner_id: string | null; assigned_to: string | null; due_at: string; completed_at: string | null; status: string | null }>)
    .filter((a) => String(a.status ?? '').toLowerCase() !== 'cancelled');

  type Acc = { on_time: number; late: number; overdue: number; upcoming: number; done_untimed: number; lateDays: number[]; overdueDays: number[] };
  const blank = (): Acc => ({ on_time: 0, late: 0, overdue: 0, upcoming: 0, done_untimed: 0, lateDays: [], overdueDays: [] });
  const byOwner = new Map<string, Acc>();
  const byWeek = new Map<string, Acc>();
  const total = blank();

  const classify = (a: (typeof acts)[number]): 'on_time' | 'late' | 'overdue' | 'upcoming' | 'done_untimed' => {
    const due = Date.parse(a.due_at);
    const st = String(a.status ?? '').toLowerCase();
    if (a.completed_at) return Date.parse(a.completed_at) <= due ? 'on_time' : 'late';
    if (st === 'done' || st === 'completed') return 'done_untimed';
    return due < nowMs ? 'overdue' : 'upcoming';
  };
  const bump = (acc: Acc, kind: ReturnType<typeof classify>, a: (typeof acts)[number]) => {
    acc[kind]++;
    const due = Date.parse(a.due_at);
    if (kind === 'late') acc.lateDays.push((Date.parse(a.completed_at!) - due) / DAY_MS);
    if (kind === 'overdue') acc.overdueDays.push((nowMs - due) / DAY_MS);
  };

  for (const a of acts) {
    const kind = classify(a);
    bump(slot(byOwner, a.assigned_to || a.owner_id || 'none', blank), kind, a);
    bump(total, kind, a);
    bump(slot(byWeek, mondayOf(Date.parse(a.due_at)), blank), kind, a);
  }

  const dueOf = (x: Acc) => x.on_time + x.late + x.overdue + x.upcoming + x.done_untimed;
  const compliance = (x: Acc) => pct(x.on_time, x.on_time + x.late + x.overdue);
  const names = await ownerNames(Array.from(byOwner.keys()).filter((k) => k !== 'none'));
  const toRow = (id: string | null, x: Acc): FollowupRow => ({
    owner_id: id, owner: id ? nameOf(names, id) : 'Unassigned',
    due: dueOf(x), on_time: x.on_time, late: x.late, overdue: x.overdue, upcoming: x.upcoming, done_untimed: x.done_untimed,
    compliance_pct: compliance(x),
    avg_days_late: x.lateDays.length ? round1(avg(x.lateDays)!) : null,
    avg_days_overdue: x.overdueDays.length ? round1(avg(x.overdueDays)!) : null,
  });
  const rows = Array.from(byOwner.entries()).map(([id, x]) => toRow(id === 'none' ? null : id, x))
    .sort((a, b) => b.due - a.due || a.owner.localeCompare(b.owner));
  const trend = Array.from(byWeek.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([week, x]) => ({
    week, due: dueOf(x), on_time: x.on_time, late: x.late, overdue: x.overdue, upcoming: x.upcoming, compliance_pct: compliance(x),
  }));
  return { rows, totals: { ...toRow(null, total), owner: 'Everyone' }, trend, from: w.fromIso, to: w.toIso };
}

// ═════════════════════════════════════════════════════════════════════════
// 3. Owner workload & response SLA
// ═════════════════════════════════════════════════════════════════════════
export interface WorkloadRow {
  owner_id: string | null;
  owner: string;
  open_leads: number;
  share_of_open_pct: number | null;
  new_leads: number;
  never_touched: number;
  idle_7d: number;
  idle_14d: number;
  idle_30d: number;
  avg_open_age_days: number | null;
  overdue_followups: number;
  first_touch_leads: number;
  median_first_touch_minutes: number | null;
  sla_breach_pct: number | null;
}

/**
 * Per owner: how much is on their plate (open leads, idle ones, overdue
 * follow-ups) and how fast new leads got a first touch. This is workload and
 * responsiveness, not a score: compare owners with similar territories.
 *   idle Nd = open leads whose last activity (or creation, if never touched) is N+ days ago.
 *   first touch = minutes from lead creation to the first activity on it, for leads created in the window.
 */
export async function ownerWorkload(org_id: string, client_id: string | null, range?: PlusRange, slaMinutes?: unknown, scope?: AnalyticsScope, nowMs = Date.now()) {
  const sla = intParam(slaMinutes, 'sla_minutes', 60, 1, 10_080);
  const w = resolveWindow(range, 30, nowMs);

  const [openRes, newRes, overdueRes] = await Promise.all([
    leadsQuery(org_id, client_id, 'owner_id, status, created_at, last_activity_at', scope)
      .not('status', 'in', '(converted,lost,unqualified)').range(0, 99999),
    leadsQuery(org_id, client_id, 'id, owner_id, created_at', scope)
      .gte('created_at', w.fromIso).lte('created_at', w.toIso).range(0, 99999),
    activitiesQuery(org_id, client_id, 'owner_id, assigned_to', scope)
      .in('status', ['open', 'planned', 'in_progress']).is('completed_at', null)
      .not('due_at', 'is', null).lt('due_at', new Date(nowMs).toISOString()).range(0, 99999),
  ]);
  const openLeads = (openRes.data ?? []) as Array<{ owner_id: string | null; status: string; created_at: string; last_activity_at: string | null }>;
  const newLeads = (newRes.data ?? []) as Array<{ id: string; owner_id: string | null; created_at: string }>;
  const overdue = (overdueRes.data ?? []) as Array<{ owner_id: string | null; assigned_to: string | null }>;

  // First touch: every activity logged on a lead since the window opened, earliest first.
  const firstTouch = new Map<string, number>();
  if (newLeads.length) {
    const { data: acts } = await withClient(
      supabaseAdmin.from('crm_activities').select('lead_id, created_at').eq('org_id', org_id).is('deleted_at', null)
        .not('lead_id', 'is', null).gte('created_at', w.fromIso).order('created_at', { ascending: true }),
      client_id,
    ).range(0, 99999);
    for (const a of (acts ?? []) as Array<{ lead_id: string; created_at: string }>) {
      if (!firstTouch.has(a.lead_id)) firstTouch.set(a.lead_id, Date.parse(a.created_at));
    }
  }

  type Acc = {
    open: number; new_leads: number; never: number; i7: number; i14: number; i30: number; ages: number[]; overdue: number;
    touchMinutes: number[]; breaches: number;
  };
  const blank = (): Acc => ({ open: 0, new_leads: 0, never: 0, i7: 0, i14: 0, i30: 0, ages: [], overdue: 0, touchMinutes: [], breaches: 0 });
  const byOwner = new Map<string, Acc>();
  const get = (id: string | null) => slot(byOwner, id ?? 'none', blank);

  for (const l of openLeads) {
    const a = get(l.owner_id);
    a.open++;
    if (!l.last_activity_at) a.never++;
    const idle = (nowMs - Date.parse(l.last_activity_at ?? l.created_at)) / DAY_MS;
    if (idle >= 7) a.i7++;
    if (idle >= 14) a.i14++;
    if (idle >= 30) a.i30++;
    const age = (nowMs - Date.parse(l.created_at)) / DAY_MS;
    if (Number.isFinite(age)) a.ages.push(Math.max(0, age));
  }
  for (const l of newLeads) {
    const a = get(l.owner_id);
    a.new_leads++;
    const t = firstTouch.get(l.id);
    if (t != null) {
      const minutes = (t - Date.parse(l.created_at)) / 60_000;
      if (minutes >= 0) { a.touchMinutes.push(minutes); if (minutes > sla) a.breaches++; }
    }
  }
  for (const o of overdue) get(o.assigned_to || o.owner_id).overdue++;

  const totalOpen = openLeads.length;
  const names = await ownerNames(Array.from(byOwner.keys()).filter((k) => k !== 'none'));
  const toRow = (id: string | null, x: Acc, label?: string): WorkloadRow => ({
    owner_id: id, owner: label ?? (id ? nameOf(names, id) : 'Unassigned'),
    open_leads: x.open, share_of_open_pct: pct(x.open, totalOpen), new_leads: x.new_leads, never_touched: x.never,
    idle_7d: x.i7, idle_14d: x.i14, idle_30d: x.i30,
    avg_open_age_days: x.ages.length ? round1(avg(x.ages)!) : null,
    overdue_followups: x.overdue, first_touch_leads: x.touchMinutes.length,
    median_first_touch_minutes: x.touchMinutes.length ? Math.round(median(x.touchMinutes)!) : null,
    sla_breach_pct: pct(x.breaches, x.touchMinutes.length),
  });
  const rows = Array.from(byOwner.entries()).map(([id, x]) => toRow(id === 'none' ? null : id, x))
    .sort((a, b) => b.open_leads - a.open_leads || a.owner.localeCompare(b.owner));

  const all = blank();
  for (const x of byOwner.values()) {
    all.open += x.open; all.new_leads += x.new_leads; all.never += x.never; all.i7 += x.i7; all.i14 += x.i14; all.i30 += x.i30;
    all.ages.push(...x.ages); all.overdue += x.overdue; all.touchMinutes.push(...x.touchMinutes); all.breaches += x.breaches;
  }
  return { rows, totals: toRow(null, all, 'Everyone'), sla_minutes: sla, from: w.fromIso, to: w.toIso };
}

// ═════════════════════════════════════════════════════════════════════════
// 4. Stage velocity (days spent in each pipeline stage)
// ═════════════════════════════════════════════════════════════════════════
export interface StageVelocityRow {
  stage_id: string;
  stage: string;
  position: number;
  stage_type: string;
  deals_entered: number;
  completed_stays: number;
  avg_days: number | null;
  median_days: number | null;
  max_days: number | null;
  current_deals: number;
  current_value: number;
  avg_current_age_days: number | null;
  slow_current_deals: number;
}

/**
 * How long deals sit in each stage, from the deal stage-change history.
 *   completed stay = the time between entering a stage and leaving it;
 *   current age    = how long an open deal has been in its present stage;
 *   slow           = current age more than twice the stage's average completed stay
 *                    (a heuristic, only flagged once the stage has 3+ completed stays).
 * A deal with no history is treated as having sat in its current stage since it was created.
 */
export async function stageVelocity(org_id: string, client_id: string | null, pipelineParam: unknown, scope?: AnalyticsScope, nowMs = Date.now()) {
  const requested = assertUuid(pipelineParam, 'pipeline_id');
  const { data: pls } = await supabaseAdmin.from('crm_pipelines').select('id, name, is_default').eq('org_id', org_id);
  const pipelines = ((pls ?? []) as Array<{ id: string; name: string; is_default: boolean | null }>)
    .map((p) => ({ id: p.id, name: p.name, is_default: !!p.is_default }));
  const chosen = requested ?? (pipelines.find((p) => p.is_default) ?? pipelines[0])?.id;
  if (!chosen) return { pipeline_id: null as string | null, pipelines, rows: [] as StageVelocityRow[], totals: { open_deals: 0, open_value: 0, typical_days_through_open_stages: null as number | null } };

  const stages = await loadStages(org_id, chosen);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const { data: dealData } = await dealsQuery(org_id, client_id, 'id, stage_id, amount, created_at', scope).eq('pipeline_id', chosen).range(0, 99999);
  const deals = (dealData ?? []) as Array<{ id: string; stage_id: string | null; amount: number | null; created_at: string }>;

  const hist = new Map<string, Array<{ from: string | null; to: string | null; at: number }>>();
  for (const part of chunk(deals.map((d) => d.id), 200)) {
    const { data: h } = await supabaseAdmin.from('crm_deal_history').select('deal_id, from_stage_id, to_stage_id, created_at')
      .eq('org_id', org_id).in('deal_id', part).order('created_at', { ascending: true });
    for (const r of (h ?? []) as Array<{ deal_id: string; from_stage_id: string | null; to_stage_id: string | null; created_at: string }>) {
      if (!r.to_stage_id) continue; // status-only change, not a stage move
      const arr = hist.get(r.deal_id) ?? [];
      arr.push({ from: r.from_stage_id, to: r.to_stage_id, at: Date.parse(r.created_at) });
      hist.set(r.deal_id, arr);
    }
  }

  type Acc = { dealIds: Set<string>; stays: number[]; current: number; currentValue: number; ages: number[] };
  const acc = new Map<string, Acc>(stages.map((s) => [s.id, { dealIds: new Set(), stays: [], current: 0, currentValue: 0, ages: [] }]));

  for (const d of deals) {
    const moves = (hist.get(d.id) ?? []).sort((a, b) => a.at - b.at);
    const created = Date.parse(d.created_at);
    let stage: string | null = moves.length ? moves[0].from : d.stage_id;
    let since = created;
    for (const m of moves) {
      if (stage && acc.has(stage)) {
        const days = (m.at - since) / DAY_MS;
        acc.get(stage)!.dealIds.add(d.id);
        if (Number.isFinite(days) && days >= 0) acc.get(stage)!.stays.push(days);
      }
      stage = m.to; since = m.at;
    }
    // Trust the deal's own current stage if the history disagrees with it.
    if (d.stage_id && stage !== d.stage_id) { stage = d.stage_id; since = moves.length ? moves[moves.length - 1].at : created; }
    if (stage && acc.has(stage)) {
      const a = acc.get(stage)!;
      a.dealIds.add(d.id);
      if (stageById.get(stage)?.stage_type === 'open') {
        a.current++; a.currentValue += Number(d.amount ?? 0);
        const age = (nowMs - since) / DAY_MS;
        if (Number.isFinite(age) && age >= 0) a.ages.push(age);
      }
    }
  }

  const rows: StageVelocityRow[] = stages.map((s) => {
    const a = acc.get(s.id)!;
    const avgDays = a.stays.length ? avg(a.stays)! : null;
    const slow = avgDays != null && a.stays.length >= 3 ? a.ages.filter((x) => x > avgDays * 2).length : 0;
    return {
      stage_id: s.id, stage: s.name, position: s.position, stage_type: s.stage_type,
      deals_entered: a.dealIds.size, completed_stays: a.stays.length,
      avg_days: avgDays == null ? null : round1(avgDays),
      median_days: a.stays.length ? round1(median(a.stays)!) : null,
      max_days: a.stays.length ? round1(Math.max(...a.stays)) : null,
      current_deals: a.current, current_value: Math.round(a.currentValue),
      avg_current_age_days: a.ages.length ? round1(avg(a.ages)!) : null,
      slow_current_deals: slow,
    };
  });
  const openRows = rows.filter((r) => r.stage_type === 'open');
  const withAvg = openRows.filter((r) => r.avg_days != null);
  return {
    pipeline_id: chosen, pipelines, rows,
    totals: {
      open_deals: openRows.reduce((s, r) => s + r.current_deals, 0),
      open_value: openRows.reduce((s, r) => s + r.current_value, 0),
      typical_days_through_open_stages: withAvg.length ? round1(withAvg.reduce((s, r) => s + (r.avg_days as number), 0)) : null,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 5. Activity mix
// ═════════════════════════════════════════════════════════════════════════
export interface ActivityMixRow {
  owner_id: string | null;
  owner: string;
  total: number;
  calls: number;
  emails: number;
  meetings: number;
  site_visits: number;
  tasks: number;
  notes: number;
  messages: number;
  other: number;
  completed: number;
  completion_pct: number | null;
  calls_with_outcome: number;
  calls_connected: number;
  connect_rate_pct: number | null;
  active_days: number;
  avg_per_active_day: number | null;
}

/**
 * Activities LOGGED in the window (by created time), per person (assigned user, else owner).
 *   completed = has a completion time. Connect rate = connected calls / calls with a recorded
 *   outcome ("Connected..." dispositions); calls with no outcome are left out of the rate.
 *   active days = distinct days on which the person logged anything.
 */
export async function activityMix(org_id: string, client_id: string | null, range?: PlusRange, scope?: AnalyticsScope) {
  const w = resolveWindow(range, 30);
  const { data } = await activitiesQuery(org_id, client_id, 'owner_id, assigned_to, type, completed_at, outcome, created_at', scope)
    .gte('created_at', w.fromIso).lte('created_at', w.toIso).range(0, 99999);
  const acts = (data ?? []) as Array<{ owner_id: string | null; assigned_to: string | null; type: string | null; completed_at: string | null; outcome: string | null; created_at: string }>;

  const KEYS = ['call', 'email', 'meeting', 'site_visit', 'task', 'note', 'message', 'other'] as const;
  type Acc = { by: Record<(typeof KEYS)[number], number>; total: number; completed: number; withOutcome: number; connected: number; days: Set<string> };
  const blank = (): Acc => ({ by: { call: 0, email: 0, meeting: 0, site_visit: 0, task: 0, note: 0, message: 0, other: 0 }, total: 0, completed: 0, withOutcome: 0, connected: 0, days: new Set() });
  const byOwner = new Map<string, Acc>();
  const byType: Record<string, number> = {};
  const byWeek = new Map<string, { total: number; calls: number; completed: number }>();
  const all = blank();

  for (const a of acts) {
    const owner = a.assigned_to || a.owner_id || 'none';
    const kind = activityBucket(a.type);
    const day = a.created_at.slice(0, 10);
    for (const acc of [slot(byOwner, owner, blank), all]) {
      acc.total++; acc.by[kind]++; acc.days.add(day);
      if (a.completed_at) acc.completed++;
      if (kind === 'call') {
        const o = callOutcome(a.outcome);
        if (o !== 'none') acc.withOutcome++;
        if (o === 'connected') acc.connected++;
      }
    }
    byType[kind] = (byType[kind] ?? 0) + 1;
    const wk = mondayOf(Date.parse(a.created_at));
    const e = byWeek.get(wk) ?? { total: 0, calls: 0, completed: 0 };
    e.total++; if (kind === 'call') e.calls++; if (a.completed_at) e.completed++;
    byWeek.set(wk, e);
  }

  const names = await ownerNames(Array.from(byOwner.keys()).filter((k) => k !== 'none'));
  const toRow = (id: string | null, x: Acc, label?: string): ActivityMixRow => ({
    owner_id: id, owner: label ?? (id ? nameOf(names, id) : 'Unassigned'),
    total: x.total, calls: x.by.call, emails: x.by.email, meetings: x.by.meeting, site_visits: x.by.site_visit, tasks: x.by.task,
    notes: x.by.note, messages: x.by.message, other: x.by.other,
    completed: x.completed, completion_pct: pct(x.completed, x.total),
    calls_with_outcome: x.withOutcome, calls_connected: x.connected, connect_rate_pct: pct(x.connected, x.withOutcome),
    active_days: x.days.size, avg_per_active_day: x.days.size ? round1(x.total / x.days.size) : null,
  });
  const rows = Array.from(byOwner.entries()).map(([id, x]) => toRow(id === 'none' ? null : id, x))
    .sort((a, b) => b.total - a.total || a.owner.localeCompare(b.owner));
  const LABEL: Record<string, string> = { call: 'Calls', email: 'Emails', meeting: 'Meetings', site_visit: 'Site visits', task: 'Tasks', note: 'Notes', message: 'SMS / WhatsApp', other: 'Other' };
  const by_type = KEYS.filter((k) => byType[k]).map((k) => ({ type: LABEL[k], count: byType[k] })).sort((a, b) => b.count - a.count);
  const by_week = Array.from(byWeek.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v }));
  return { rows, totals: toRow(null, all, 'Everyone'), by_type, by_week, from: w.fromIso, to: w.toIso };
}

// ═════════════════════════════════════════════════════════════════════════
// 6. Lead conversion time
// ═════════════════════════════════════════════════════════════════════════
export interface ConversionTimeGroup { key: string; label: string; converted: number; avg_days: number | null; median_days: number | null }

/**
 * Leads CONVERTED in the window: whole days from lead creation to conversion.
 * Buckets, an overall average / median / 90th percentile, and the same split by
 * owner, source and conversion month.
 */
export async function conversionTime(org_id: string, client_id: string | null, range?: PlusRange, scope?: AnalyticsScope) {
  const w = resolveWindow(range, 90);
  const { data } = await leadsQuery(org_id, client_id, 'owner_id, source_id, created_at, converted_at', scope)
    .eq('status', 'converted').not('converted_at', 'is', null)
    .gte('converted_at', w.fromIso).lte('converted_at', w.toIso).range(0, 99999);
  const leads = ((data ?? []) as Array<{ owner_id: string | null; source_id: string | null; created_at: string; converted_at: string }>)
    .map((l) => ({ ...l, days: (Date.parse(l.converted_at) - Date.parse(l.created_at)) / DAY_MS }))
    .filter((l) => Number.isFinite(l.days) && l.days >= 0);

  const counts = new Map(DAY_BUCKETS.map((b) => [b.bucket, 0]));
  for (const l of leads) counts.set(dayBucket(l.days), (counts.get(dayBucket(l.days)) ?? 0) + 1);
  const buckets = DAY_BUCKETS.map((b) => ({ bucket: b.bucket, count: counts.get(b.bucket) ?? 0 }));

  const all = leads.map((l) => l.days);
  const totals = {
    converted: leads.length,
    avg_days: all.length ? round1(avg(all)!) : null,
    median_days: all.length ? round1(median(all)!) : null,
    p90_days: all.length ? round1(percentile(all, 90)!) : null,
    fastest_days: all.length ? round1(Math.min(...all)) : null,
    slowest_days: all.length ? round1(Math.max(...all)) : null,
  };

  const group = (keyOf: (l: (typeof leads)[number]) => string): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const l of leads) slot(m, keyOf(l), () => [] as number[]).push(l.days);
    return m;
  };
  const toGroups = (m: Map<string, number[]>, label: (k: string) => string): ConversionTimeGroup[] =>
    Array.from(m.entries()).map(([key, d]) => ({ key, label: label(key), converted: d.length, avg_days: round1(avg(d)!), median_days: round1(median(d)!) }))
      .sort((a, b) => b.converted - a.converted || a.label.localeCompare(b.label));

  const ownerMap = group((l) => l.owner_id ?? 'none');
  const sourceMap = group((l) => l.source_id ?? 'none');
  const [names, srcNames] = await Promise.all([
    ownerNames(Array.from(ownerMap.keys()).filter((k) => k !== 'none')),
    resolveSourceNames(Array.from(sourceMap.keys()).filter((k) => k !== 'none')),
  ]);
  const by_owner = toGroups(ownerMap, (k) => (k === 'none' ? 'Unassigned' : nameOf(names, k)));
  const by_source = toGroups(sourceMap, (k) => (k === 'none' ? 'Unspecified' : srcNames.get(k)?.name?.trim() || 'Unspecified'));
  const by_month = toGroups(group((l) => monthKey(l.converted_at)), (k) => k).sort((a, b) => a.key.localeCompare(b.key));
  return { totals, buckets, by_owner, by_source, by_month, from: w.fromIso, to: w.toIso };
}

// ═════════════════════════════════════════════════════════════════════════
// 7. Weighted pipeline
// ═════════════════════════════════════════════════════════════════════════
export interface WeightedPipelineRow {
  stage_id: string;
  stage: string;
  position: number;
  deals: number;
  value: number;
  weighted_value: number;
  avg_deal_size: number | null;
  avg_age_days: number | null;
  past_close_date: number;
}

/**
 * Open deals by stage. Weighted value = amount x probability, using the deal's
 * own probability when it is above 0, otherwise its stage's probability. An
 * estimate of expected revenue, not a commitment. "Past close date" counts open
 * deals whose expected close date has already gone by.
 */
export async function weightedPipeline(org_id: string, client_id: string | null, pipelineParam: unknown, scope?: AnalyticsScope, nowMs = Date.now()) {
  const pipeline_id = assertUuid(pipelineParam, 'pipeline_id');
  const stages = await loadStages(org_id, pipeline_id);
  const open = stages.filter((s) => s.stage_type === 'open');
  if (!open.length) return { rows: [] as WeightedPipelineRow[], totals: { deals: 0, value: 0, weighted_value: 0, weighted_pct_of_value: null as number | null, past_close_date: 0, past_close_value: 0 } };
  const stageById = new Map(open.map((s) => [s.id, s]));

  let q = dealsQuery(org_id, client_id, 'amount, probability, stage_id, created_at, expected_close_date', scope).in('stage_id', open.map((s) => s.id));
  if (pipeline_id) q = q.eq('pipeline_id', pipeline_id);
  const { data } = await q.range(0, 99999);
  const deals = (data ?? []) as Array<{ amount: number | null; probability: number | null; stage_id: string; created_at: string; expected_close_date: string | null }>;
  const today = new Date(nowMs).toISOString().slice(0, 10);

  type Acc = { deals: number; value: number; weighted: number; ages: number[]; past: number; pastValue: number };
  const byStage = new Map<string, Acc>(open.map((s) => [s.id, { deals: 0, value: 0, weighted: 0, ages: [], past: 0, pastValue: 0 }]));
  for (const d of deals) {
    const s = stageById.get(d.stage_id);
    if (!s) continue;
    const a = byStage.get(s.id)!;
    const amount = Number(d.amount ?? 0);
    const p = d.probability != null && Number(d.probability) > 0 ? Number(d.probability) : s.probability;
    a.deals++; a.value += amount; a.weighted += (amount * p) / 100;
    const age = (nowMs - Date.parse(d.created_at)) / DAY_MS;
    if (Number.isFinite(age)) a.ages.push(Math.max(0, age));
    if (d.expected_close_date && d.expected_close_date.slice(0, 10) < today) { a.past++; a.pastValue += amount; }
  }
  const rows: WeightedPipelineRow[] = open.map((s) => {
    const a = byStage.get(s.id)!;
    return {
      stage_id: s.id, stage: s.name, position: s.position, deals: a.deals, value: Math.round(a.value),
      weighted_value: Math.round(a.weighted), avg_deal_size: a.deals ? Math.round(a.value / a.deals) : null,
      avg_age_days: a.ages.length ? round1(avg(a.ages)!) : null, past_close_date: a.past,
    };
  });
  // The same stage name can exist in several pipelines; fold those together for the all-pipelines view.
  const folded = new Map<string, WeightedPipelineRow>();
  for (const r of rows) {
    const prev = folded.get(r.stage);
    if (!prev) { folded.set(r.stage, { ...r }); continue; }
    const deals2 = prev.deals + r.deals;
    folded.set(r.stage, {
      ...prev, deals: deals2, value: prev.value + r.value, weighted_value: prev.weighted_value + r.weighted_value,
      avg_deal_size: deals2 ? Math.round((prev.value + r.value) / deals2) : null,
      avg_age_days: prev.avg_age_days == null ? r.avg_age_days : r.avg_age_days == null ? prev.avg_age_days
        : round1((prev.avg_age_days * prev.deals + r.avg_age_days * r.deals) / Math.max(1, deals2)),
      past_close_date: prev.past_close_date + r.past_close_date,
    });
  }
  const out = Array.from(folded.values()).sort((a, b) => a.position - b.position);
  const value = out.reduce((s, r) => s + r.value, 0);
  const weighted = out.reduce((s, r) => s + r.weighted_value, 0);
  const past = Array.from(byStage.values());
  return {
    rows: out,
    totals: {
      deals: out.reduce((s, r) => s + r.deals, 0), value, weighted_value: weighted,
      weighted_pct_of_value: pct(weighted, value),
      past_close_date: out.reduce((s, r) => s + r.past_close_date, 0),
      past_close_value: Math.round(past.reduce((s, a) => s + a.pastValue, 0)),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 8. Deal size distribution
// ═════════════════════════════════════════════════════════════════════════
export interface DealSizeRow { bucket: string; deals: number; won: number; lost: number; open: number; value: number; win_rate_pct: number | null }

/** Deals CREATED in the window by amount band (INR), split by outcome. Win rate = won / (won + lost). */
export async function dealSizeDistribution(org_id: string, client_id: string | null, range?: PlusRange, scope?: AnalyticsScope) {
  const w = resolveWindow(range, 180);
  const stages = await loadStages(org_id);
  const typeOf = new Map(stages.map((s) => [s.id, s.stage_type]));
  const { data } = await dealsQuery(org_id, client_id, 'amount, stage_id, created_at', scope)
    .gte('created_at', w.fromIso).lte('created_at', w.toIso).range(0, 99999);
  const deals = (data ?? []) as Array<{ amount: number | null; stage_id: string | null }>;

  const acc = new Map(DEAL_SIZE_BANDS.map((b) => [b.bucket, { deals: 0, won: 0, lost: 0, open: 0, value: 0 }]));
  const amounts: number[] = [];
  for (const d of deals) {
    const amount = Number(d.amount ?? 0);
    const a = acc.get(dealSizeBand(amount))!;
    a.deals++; a.value += amount > 0 ? amount : 0;
    const t = d.stage_id ? typeOf.get(d.stage_id) : 'open';
    if (t === 'won') a.won++; else if (t === 'lost') a.lost++; else a.open++;
    if (amount > 0) amounts.push(amount);
  }
  const rows: DealSizeRow[] = DEAL_SIZE_BANDS.map((b) => {
    const a = acc.get(b.bucket)!;
    return { bucket: b.bucket, deals: a.deals, won: a.won, lost: a.lost, open: a.open, value: Math.round(a.value), win_rate_pct: pct(a.won, a.won + a.lost) };
  }).filter((r, i) => i > 0 || r.deals > 0); // hide the "No amount" band when empty
  return {
    rows,
    totals: {
      deals: deals.length, with_amount: amounts.length,
      avg_amount: amounts.length ? Math.round(avg(amounts)!) : null,
      median_amount: amounts.length ? Math.round(median(amounts)!) : null,
      largest_amount: amounts.length ? Math.round(Math.max(...amounts)) : null,
    },
    from: w.fromIso, to: w.toIso,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 9. Win-rate trend
// ═════════════════════════════════════════════════════════════════════════
export interface WinRateTrendRow { month: string; won: number; lost: number; closed: number; win_rate_pct: number | null; won_value: number; lost_value: number }

/**
 * Deals closed per month over the last N months. A deal counts in the month of
 * its actual close date (falling back to its last update when none is set).
 * Win rate = won / (won + lost).
 */
export async function winRateTrend(org_id: string, client_id: string | null, monthsParam: unknown, scope?: AnalyticsScope, nowMs = Date.now()) {
  const months = intParam(monthsParam, 'months', 6, 1, 24);
  const now = new Date(nowMs);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const stages = await loadStages(org_id);
  const typeOf = new Map(stages.map((s) => [s.id, s.stage_type]));
  const closedIds = stages.filter((s) => s.stage_type === 'won' || s.stage_type === 'lost').map((s) => s.id);
  const keys: string[] = [];
  for (let i = 0; i < months; i++) keys.push(new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  const acc = new Map(keys.map((k) => [k, { won: 0, lost: 0, wonValue: 0, lostValue: 0 }]));
  if (closedIds.length) {
    const { data } = await dealsQuery(org_id, client_id, 'amount, stage_id, actual_close_date, updated_at', scope)
      .in('stage_id', closedIds).gte('updated_at', since.toISOString()).range(0, 99999);
    for (const d of (data ?? []) as Array<{ amount: number | null; stage_id: string; actual_close_date: string | null; updated_at: string }>) {
      const when = d.actual_close_date ?? d.updated_at;
      const a = acc.get(monthKey(when));
      if (!a) continue;
      const amount = Number(d.amount ?? 0);
      if (typeOf.get(d.stage_id) === 'won') { a.won++; a.wonValue += amount; } else { a.lost++; a.lostValue += amount; }
    }
  }
  const rows: WinRateTrendRow[] = keys.map((month) => {
    const a = acc.get(month)!;
    return { month, won: a.won, lost: a.lost, closed: a.won + a.lost, win_rate_pct: pct(a.won, a.won + a.lost), won_value: Math.round(a.wonValue), lost_value: Math.round(a.lostValue) };
  });
  const won = rows.reduce((s, r) => s + r.won, 0);
  const lost = rows.reduce((s, r) => s + r.lost, 0);
  return { rows, totals: { won, lost, closed: won + lost, win_rate_pct: pct(won, won + lost) }, months };
}

// ═════════════════════════════════════════════════════════════════════════
// 10. Call connect trend
// ═════════════════════════════════════════════════════════════════════════
export interface CallTrendRow { week: string; calls: number; with_outcome: number; connected: number; connect_rate_pct: number | null }

/**
 * Calls logged per week over the last N weeks. Connect rate = calls whose
 * outcome starts with "Connected" / calls with a recorded outcome. Needs reps
 * to record a call outcome; calls with none are counted in `calls` only.
 */
export async function callConnectTrend(org_id: string, client_id: string | null, weeksParam: unknown, scope?: AnalyticsScope, nowMs = Date.now()) {
  const weeks = intParam(weeksParam, 'weeks', 8, 1, 26);
  const thisMonday = Date.parse(`${mondayOf(nowMs)}T00:00:00.000Z`);
  const sinceMs = thisMonday - (weeks - 1) * 7 * DAY_MS;
  const keys: string[] = [];
  for (let i = 0; i < weeks; i++) keys.push(new Date(sinceMs + i * 7 * DAY_MS).toISOString().slice(0, 10));
  const acc = new Map(keys.map((k) => [k, { calls: 0, withOutcome: 0, connected: 0 }]));
  const { data } = await activitiesQuery(org_id, client_id, 'type, outcome, created_at', scope)
    .eq('type', 'call').gte('created_at', new Date(sinceMs).toISOString()).range(0, 99999);
  for (const a of (data ?? []) as Array<{ outcome: string | null; created_at: string }>) {
    const e = acc.get(mondayOf(Date.parse(a.created_at)));
    if (!e) continue;
    e.calls++;
    const o = callOutcome(a.outcome);
    if (o !== 'none') e.withOutcome++;
    if (o === 'connected') e.connected++;
  }
  const rows: CallTrendRow[] = keys.map((week) => {
    const e = acc.get(week)!;
    return { week, calls: e.calls, with_outcome: e.withOutcome, connected: e.connected, connect_rate_pct: pct(e.connected, e.withOutcome) };
  });
  const calls = rows.reduce((s, r) => s + r.calls, 0);
  const withOutcome = rows.reduce((s, r) => s + r.with_outcome, 0);
  const connected = rows.reduce((s, r) => s + r.connected, 0);
  return { rows, totals: { calls, with_outcome: withOutcome, connected, connect_rate_pct: pct(connected, withOutcome) }, weeks };
}

// ═════════════════════════════════════════════════════════════════════════
// 11. Lead recycling (closed leads that were reopened)
// ═════════════════════════════════════════════════════════════════════════
export interface RecyclingRow { month: string; moved_to_lost: number; reopened: number }

/**
 * From the lead status history, per month over the last N months:
 *   moved to lost = status changed to Lost or Unqualified;
 *   reopened      = status changed from Lost / Unqualified back to an open status.
 * Only leads visible to the caller are counted. "Converted after reopen" is the
 * number of distinct reopened leads that are Converted today.
 */
export async function leadRecycling(org_id: string, client_id: string | null, monthsParam: unknown, scope?: AnalyticsScope, nowMs = Date.now()) {
  const months = intParam(monthsParam, 'months', 6, 1, 24);
  const now = new Date(nowMs);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const keys: string[] = [];
  for (let i = 0; i < months; i++) keys.push(new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  const empty = { rows: keys.map((month) => ({ month, moved_to_lost: 0, reopened: 0 })), totals: { moved_to_lost: 0, reopened: 0, distinct_leads_reopened: 0, converted_after_reopen: 0 }, months };

  const { data } = await supabaseAdmin.from('crm_lead_history').select('lead_id, old_value, new_value, changed_at')
    .eq('org_id', org_id).eq('field', 'status').gte('changed_at', since.toISOString()).range(0, 99999);
  const hist = (data ?? []) as Array<{ lead_id: string; old_value: unknown; new_value: unknown; changed_at: string }>;
  if (!hist.length) return empty;

  // Keep only the leads this caller may see (and learn which are Converted today).
  const visible = new Map<string, string>();
  for (const part of chunk(Array.from(new Set(hist.map((h) => h.lead_id))), 200)) {
    const { data: ls } = await leadsQuery(org_id, client_id, 'id, status', scope).in('id', part);
    for (const l of (ls ?? []) as Array<{ id: string; status: string }>) visible.set(l.id, String(l.status ?? '').toLowerCase());
  }

  const neg = NEGATIVE_LEAD_STATUSES as readonly string[];
  const norm = (v: unknown) => String(typeof v === 'string' ? v : '').toLowerCase();
  const acc = new Map(keys.map((k) => [k, { lost: 0, reopened: 0 }]));
  const reopenedLeads = new Set<string>();
  for (const h of hist) {
    if (!visible.has(h.lead_id)) continue;
    const a = acc.get(monthKey(h.changed_at));
    if (!a) continue;
    const from = norm(h.old_value);
    const to = norm(h.new_value);
    if (neg.includes(to) && !neg.includes(from)) a.lost++;
    if (neg.includes(from) && to && !neg.includes(to) && to !== 'converted') { a.reopened++; reopenedLeads.add(h.lead_id); }
  }
  const rows: RecyclingRow[] = keys.map((month) => ({ month, moved_to_lost: acc.get(month)!.lost, reopened: acc.get(month)!.reopened }));
  return {
    rows,
    totals: {
      moved_to_lost: rows.reduce((s, r) => s + r.moved_to_lost, 0),
      reopened: rows.reduce((s, r) => s + r.reopened, 0),
      distinct_leads_reopened: reopenedLeads.size,
      converted_after_reopen: Array.from(reopenedLeads).filter((id) => visible.get(id) === 'converted').length,
    },
    months,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

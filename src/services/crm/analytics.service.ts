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
  // Precedence order so the dashboard's weight tiles surface a real
  // number regardless of which deal-creation path the rep used:
  //   1. custom_fields.volume_kg  — written on convert from line-items.
  //   2. crm_deal_line_items view — older line-item flow.
  //   3. custom_fields.product_lines — new ProductLinesSection flow,
  //      sums qty × unit-factor (1 kg / 1000 tonne) across rows. This
  //      catches deals converted from leads that captured products via
  //      the Tata "Products of Interest" picker but never got line
  //      items written.
  const cf = d.custom_fields as Record<string, unknown> | null | undefined;
  const cfVol = cf ? Number(cf.volume_kg) : NaN;
  if (Number.isFinite(cfVol) && cfVol > 0) return cfVol;
  const w = d.weight;
  const row: WeightRow | undefined = Array.isArray(w) ? w[0] : (w ?? undefined);
  const fromView = Number(row?.total_kg ?? 0);
  if (fromView > 0) return fromView;
  const lines = cf?.product_lines;
  if (Array.isArray(lines)) {
    let total = 0;
    for (const l of lines as Array<Record<string, unknown>>) {
      const qty = Number(l.quantity ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const u = String(l.measuring_unit ?? '').trim().toLowerCase();
      total += qty * (u === 'tonne' ? 1000 : 1);
    }
    if (total > 0) return total;
  }
  return 0;
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
  /** When true (Consumer Champions), skip city broadening and only expose the
   *  caller's own leads — mirrors the ownOnly flag in listLeadsWithCount. */
  ownOnly?: boolean;
}

// A UUID that never matches a real row — used to force an empty result set
// when the caller can see nothing (no cities, no visible owners).
const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Lead-visibility scope on a crm_leads query — kept IDENTICAL to
// listLeadsWithCount so analytics totals match the leads list exactly.
//
// The whole thing must be ONE PostgREST `.or()`. The previous version
// emitted the city terms as one `.or()` and the owner-subtree as a
// separate `.in()`, which PostgREST AND-s together. For a team manager
// (who carries BOTH an assigned-city set AND a hierarchy subtree) that
// meant "leads in my cities AND owned by my team" — a strict subset that
// collapsed to near-zero, so every analytics report rendered blank even
// though the leads list (correctly OR-ing the two) showed ~1.8k rows.
export function applyLeadScope(q: any, scope?: AnalyticsScope): any {
  if (!scope) return q;
  const hasCityScope = scope.effectiveCities !== undefined && scope.effectiveCities !== null;
  const hasOwnerScope = scope.visibleOwnerIds !== undefined && scope.visibleOwnerIds !== null;

  // Frontline own-only (data_scope='own' champion): just self, plus the
  // subtree when present. No city broadening.
  if (scope.ownOnly) {
    const orParts: string[] = [];
    if (scope.selfOwnerId) orParts.push(`owner_id.eq.${scope.selfOwnerId}`);
    if (hasOwnerScope && scope.visibleOwnerIds!.length > 0) {
      orParts.push(`owner_id.in.(${scope.visibleOwnerIds!.join(',')})`);
    }
    return q.or(orParts.length ? orParts.join(',') : `owner_id.eq.${NO_MATCH_UUID}`);
  }

  // Everyone else: city ∪ self ∪ subtree (∪ null-city only when there is
  // no owner subtree), combined into a SINGLE OR — mirrors the leads list.
  if (hasCityScope || hasOwnerScope) {
    const orParts: string[] = [];
    if (hasCityScope && scope.effectiveCities!.length > 0) {
      const cityCsv = scope.effectiveCities!.map((c) => `"${String(c).replace(/"/g, '')}"`).join(',');
      orParts.push(`city.in.(${cityCsv})`);
    }
    if (scope.selfOwnerId) orParts.push(`owner_id.eq.${scope.selfOwnerId}`);
    if (hasOwnerScope && scope.visibleOwnerIds!.length > 0) {
      orParts.push(`owner_id.in.(${scope.visibleOwnerIds!.join(',')})`);
    }
    // Null-city leads only broaden in when there's no owner subtree (admin /
    // data_scope='all'); under a subtree they're already covered by the
    // owner term, and OR-ing every city-less lead would leak other regions.
    if (scope.includeNullCity && !hasOwnerScope) orParts.push('city.is.null');
    q = q.or(orParts.length ? orParts.join(',') : `owner_id.eq.${NO_MATCH_UUID}`);
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
  const lines = unit === 'weight' ? weightJoin : '';

  const [
    { count: totalLeads },
    { count: newInWindow },
    { count: convertedInWindow },
    { data: pipelineRows },
    { data: closedInWindow },
    { count: activities7d },
    // Sum of the rep's lead-side estimates — Champions surface this as
    // the "Total Estimates Raised" tile. Pulls only the custom_fields
    // jsonb so we can extract `estimated_amount` (or, falling back,
    // sum product_lines[*].estimated_amount when the basket total
    // wasn't cached on the lead).
    { data: estimateRows },
    { data: estimateDealRows },
  ] = await Promise.all([
    withClient(applyLeadScope(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null), scope), client_id),
    withClient(applyLeadScope(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('created_at', fromIso).lte('created_at', toIso), scope), client_id),
    withClient(applyLeadScope(supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).eq('status', 'converted').gte('created_at', fromIso).lte('created_at', toIso), scope), client_id),
    // Live query for open pipeline — the MV (crm_mv_pipeline_value) doesn't
    // track client_id, so reading it here would leak the org-wide totals into
    // any per-client dashboard.
    // .range(0, 99999) lifts the row cap on deal queries that feed
    // headline numbers; without it, open pipeline + closed-in-window
    // both silently capped at 1000 deals.
    withClient(
      applyOwnerScope(supabaseAdmin.from('crm_deals')
        // Always join the weight view here (not just in weight mode) so the
        // Open Pipeline card can show total volume (kg) alongside value.
        .select(`amount, owner_id, custom_fields, crm_deal_stages!inner(name, stage_type)${weightJoin}`)
        .eq('org_id', org_id).is('deleted_at', null)
        .eq('crm_deal_stages.stage_type', 'open')
        .range(0, 99999), scope),
      client_id,
    ),
    withClient(applyOwnerScope(supabaseAdmin.from('crm_deals').select(`amount, owner_id, crm_deal_stages!inner(stage_type)${lines}`).eq('org_id', org_id).is('deleted_at', null).gte('actual_close_date', fromDate).lte('actual_close_date', toDate).range(0, 99999), scope), client_id),
    // Activities tile honors the picked date range (`activities_7d`
    // legacy field name; the value is now whatever the from/to window
    // resolves to). Without this every preset on the dashboard
    // returned the same hardcoded 7-day figure even when the rep
    // picked Today / Yesterday / This month.
    withClient(applyActivityScope(supabaseAdmin.from('crm_activities').select('id', { count: 'exact', head: true }).eq('org_id', org_id).is('deleted_at', null).gte('created_at', fromIso).lte('created_at', toIso), scope), client_id),
    // .range(0, 99999) lifts PostgREST's default 1000-row cap so the
    // estimates tile counts every lead in the window. Window is applied
    // via lead.created_at so the Reports date-range filter actually
    // affects this tile (it used to be lifetime regardless of range).
    withClient(applyLeadScope(supabaseAdmin.from('crm_leads').select('custom_fields').eq('org_id', org_id).is('deleted_at', null).gte('created_at', fromIso).lte('created_at', toIso).range(0, 99999), scope), client_id),
    // Every deal the rep has touched within the window — open / won /
    // lost. Used by the Champion "Total Estimates Raised" tile so the
    // headline ₹ figure reflects the current window's pipeline. Window
    // applied via deal.created_at; 100k-row lift same as above.
    withClient(applyOwnerScope(supabaseAdmin.from('crm_deals').select('amount, lead_id').eq('org_id', org_id).is('deleted_at', null).gte('created_at', fromIso).lte('created_at', toIso).range(0, 99999), scope), client_id),
  ]);

  // Aggregate per-lead estimated_amount. Prefer the cached scalar the
  // create / convert paths stamp onto custom_fields.estimated_amount;
  // fall back to summing the rich product_lines basket when the cache
  // is missing (older leads / out-of-band edits). Money values come
  // back as either numbers or numeric strings depending on the path
  // that wrote them, so both are coerced.
  let estimates_raised = 0;
  for (const row of (estimateRows ?? []) as Array<{ custom_fields?: Record<string, unknown> | null }>) {
    const cf = row.custom_fields ?? {};
    const cached = typeof cf.estimated_amount === 'number'
      ? cf.estimated_amount
      : typeof cf.estimated_amount === 'string'
        ? Number(cf.estimated_amount) || 0
        : 0;
    if (cached > 0) { estimates_raised += cached; continue; }
    const lines = Array.isArray(cf.product_lines) ? (cf.product_lines as Array<Record<string, unknown>>) : [];
    for (const l of lines) {
      const ea = typeof l.estimated_amount === 'number'
        ? l.estimated_amount
        : typeof l.estimated_amount === 'string'
          ? Number(l.estimated_amount) || 0
          : 0;
      if (ea > 0) estimates_raised += ea;
    }
  }
  // Plus every ₹ the rep has committed to a deal (open / won / lost).
  // Deals are where the firmed-up numbers live for reps who skipped
  // the product_lines basket on the lead form, so without this the
  // Champion tile read close to ₹0 even for active pipelines.
  for (const d of (estimateDealRows ?? []) as Array<{ amount?: number | string | null }>) {
    const amt = typeof d.amount === 'number'
      ? d.amount
      : typeof d.amount === 'string'
        ? Number(d.amount) || 0
        : 0;
    if (amt > 0) estimates_raised += amt;
  }
  estimates_raised = Math.round(estimates_raised);

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

  // Leads grouped by acquisition source — drives the "Leads by Source"
  // chart on the dashboard. Same window as the headline numbers so the
  // chart stays coherent with the date-range filter. Mobile reads this
  // as `summary.bySource`; before this it was always empty because the
  // response didn't carry the key at all.
  const sourceMap = new Map<string, { count: number; value: number }>();
  const { data: sourceLeads } = await withClient(applyLeadScope(
    supabaseAdmin.from('crm_leads')
      .select('source_id, crm_lead_sources(name)')
      .eq('org_id', org_id).is('deleted_at', null)
      .gte('created_at', fromIso).lte('created_at', toIso)
      .range(0, 99999),
    scope), client_id);
  for (const r of (sourceLeads ?? []) as Array<{ source_id?: string | null; crm_lead_sources?: { name?: string } | null }>) {
    const name = r.crm_lead_sources?.name ?? 'Unspecified';
    const s = sourceMap.get(name) ?? { count: 0, value: 0 };
    s.count += 1;
    sourceMap.set(name, s);
  }
  const by_source = Array.from(sourceMap.entries())
    .map(([source, v]) => ({ source, stage: source, name: source, count: v.count, value: v.value }))
    .sort((a, b) => b.count - a.count);

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
    estimates_raised,
    by_stage,
    by_owner,
    by_source,
  };
}

export async function pipelineValue(org_id: string, pipeline_id?: string, client_id: string | null = null, unit: AnalyticsUnit = 'inr', scope?: AnalyticsScope) {
  // Live query — the MV (crm_mv_pipeline_value) doesn't track client_id, so it
  // cannot be filtered per client. Aggregate from crm_deals directly.
  const lines = unit === 'weight' ? weightJoin : '';
  // .range(0, 99999) lifts the 1000-row cap so pipeline value
  // reflects every open deal, not just the first 1000.
  let q = supabaseAdmin.from('crm_deals')
    .select(`amount, pipeline_id, crm_deal_stages!inner(name, stage_type, position)${lines}`)
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'open')
    .range(0, 99999);
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
  // Use 3 parallel head:true counts instead of selecting rows: the
  // previous .select('status') silently capped at PostgREST's default
  // 1000 rows, so for any tenant with >1k leads in the window the
  // funnel was showing wrong numbers. Counts are exact and unbounded.
  const fromIso = range?.from ?? new Date(Date.now() - days * 86400000).toISOString();
  const toIso = range?.to ?? new Date().toISOString();
  const base = () => {
    let q = supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true })
      .eq('org_id', org_id).is('deleted_at', null)
      .gte('created_at', fromIso).lte('created_at', toIso);
    q = withClient(q, client_id);
    q = applyLeadScope(q, scope);
    return q;
  };
  const [r_new, r_qual, r_conv] = await Promise.all([
    base(),
    base().in('status', ['qualified', 'converted']),
    base().eq('status', 'converted'),
  ]);
  return [
    { stage: 'New', count: r_new.count ?? 0, value: 0 },
    { stage: 'Qualified', count: r_qual.count ?? 0, value: 0 },
    { stage: 'Converted', count: r_conv.count ?? 0, value: 0 },
  ];
}

export async function winRate(org_id: string, by: 'rep' | 'source' | 'stage', range?: DateRange, client_id: string | null = null, scope?: AnalyticsScope) {
  if (by === 'source') {
    // Live query — the MV (crm_mv_lead_source_roi) doesn't track client_id.
    // .range(0, 99999) lifts PostgREST's 1000-row cap; without it
    // win rate is wrong for any tenant with >1k leads.
    let lq = supabaseAdmin.from('crm_leads')
      .select('status, source_id, crm_lead_sources(name)')
      .eq('org_id', org_id).is('deleted_at', null)
      .range(0, 99999);
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
  // .range(0, 99999) lifts the row cap so win-rate covers every deal,
  // not just the first 1000 PostgREST would otherwise return.
  let q = supabaseAdmin.from('crm_deals')
    .select('amount, owner_id, stage_id, created_at, crm_deal_stages!inner(name, stage_type)')
    .eq('org_id', org_id).is('deleted_at', null)
    .range(0, 99999);
  q = withClient(q, client_id);
  q = applyOwnerScope(q, scope);
  if (range?.from) q = q.gte('created_at', range.from);
  if (range?.to) q = q.lte('created_at', range.to);
  const { data: deals } = await q;
  // Resolve owner UUIDs → display names in one batched lookup before the
  // bucket loop. Without this, `by='rep'` returned raw uuids (the FE
  // showed "a1b2c3…" instead of "Ravi Kumar"). Stage labels come from
  // the embedded crm_deal_stages join, so no extra resolution needed
  // for `by='stage'`.
  let ownerNameById = new Map<string, string>();
  if (by === 'rep') {
    const ownerIds = Array.from(new Set(
      ((deals ?? []) as unknown as Array<{ owner_id?: string | null }>)
        .map((d) => d.owner_id)
        .filter((id): id is string => !!id)
    ));
    if (ownerIds.length) {
      const { data: users } = await supabaseAdmin.from('users')
        .select('id, name, email').in('id', ownerIds);
      for (const u of (users ?? []) as Array<{ id: string; name?: string; email?: string }>) {
        ownerNameById.set(u.id, u.name || u.email || 'User');
      }
    }
  }
  const map = new Map<string, { won: number; lost: number }>();
  for (const d of (deals ?? []) as unknown as Array<{ amount: number; owner_id?: string; stage_id: string; crm_deal_stages: { name: string; stage_type: string } }>) {
    const key = by === 'rep'
      ? (d.owner_id ? (ownerNameById.get(d.owner_id) ?? 'Unknown') : 'Unassigned')
      : d.crm_deal_stages.name;
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

// ─── Team Performance ─────────────────────────────────────────────
//
// Per-rep aggregate KPIs for the caller's hierarchy subtree. Drives
// the "Team Wise" report a Consumer Champion Manager / Area Sales
// Manager opens to see how their direct + transitive reports are doing
// in one place — won volume, conversion rate, lead ageing, and new
// leads this period.
//
// One round trip per dataset: deals (won/lost), leads (new), open leads
// (ageing). Grouped client-side by owner. User names resolved in a
// single batched lookup. Returns a `total` row at the front so the UI
// can render it as a sticky header.

export interface TeamPerformanceRow {
  user_id: string | null;
  name: string;
  // ── Lead funnel
  total_leads_owned: number;
  new_leads_today: number;
  new_leads_week: number;
  new_leads_month: number;
  new_leads_period: number;
  qualified_count: number;
  converted_count: number;
  unqualified_count: number;
  lost_leads_count: number;
  qualified_rate: number;            // qualified / total_leads_owned
  converted_rate: number;            // converted / total_leads_owned
  // ── Deal performance
  won_count: number;
  won_value: number;
  lost_count: number;
  open_count: number;
  open_pipeline_value: number;
  conversion_rate: number;           // won / (won + lost) — deals
  avg_deal_size: number;             // won_value / won_count
  avg_sales_cycle_days: number;      // avg (actual_close_date - created_at) for won deals
  // ── Operational health
  avg_ageing_days: number;           // mean age of open leads (days)
  oldest_open_lead_days: number;     // max age of open leads (days)
  activities_completed_period: number;
  activities_total_period: number;
  last_activity_at: string | null;   // ISO; most recent owned/assigned activity
  // ── Quality
  avg_lead_score: number;
}

export async function teamPerformance(
  org_id: string,
  range?: DateRange,
  client_id: string | null = null,
  scope?: AnalyticsScope,
): Promise<{ total: TeamPerformanceRow; rows: TeamPerformanceRow[] }> {
  // ── Resolve hierarchy subtree up-front. Same pattern as teamDaily.
  const subtree = scope?.visibleOwnerIds ?? null;
  let userQ = supabaseAdmin.from('users')
    .select('id, name, full_name, email')
    .eq('org_id', org_id);
  if (client_id) userQ = userQ.eq('client_id', client_id);
  if (subtree && subtree.length > 0) userQ = userQ.in('id', subtree);
  else if (subtree && subtree.length === 0) {
    return { total: blankRow('Total'), rows: [] };
  }
  const { data: users } = await userQ;
  const userIds = ((users ?? []) as Array<{ id: string }>).map((u) => u.id);

  // Window boundaries (used by period rollups regardless of `range`).
  const now = new Date();
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const day = todayStart.getUTCDay() || 7;
  const weekStart = new Date(todayStart); weekStart.setUTCDate(weekStart.getUTCDate() - (day - 1));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rangeFrom = range?.from ? new Date(range.from).toISOString() : null;
  const rangeTo   = range?.to   ? new Date(range.to).toISOString()   : null;

  // ── 1) All leads for the subtree (lifetime). We post-filter for
  //    period counts client-side to avoid 5 separate queries.
  // .range(0, 99999) lifts the row cap so team-performance counts every
  // lead/deal/activity, not just the first 1000.
  let leadQ = supabaseAdmin.from('crm_leads')
    .select('owner_id, status, created_at, score, converted_at')
    .eq('org_id', org_id).is('deleted_at', null)
    .range(0, 99999);
  leadQ = withClient(leadQ, client_id);
  leadQ = applyLeadScope(leadQ, scope);
  const { data: leads } = await leadQ;

  // ── 2) All deals for the subtree (open + closed). Period-bound for
  //    won/lost; lifetime for open pipeline.
  let dealQ = supabaseAdmin.from('crm_deals')
    .select('owner_id, amount, status, created_at, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).is('deleted_at', null)
    .range(0, 99999);
  dealQ = withClient(dealQ, client_id);
  dealQ = applyOwnerScope(dealQ, scope);
  const { data: deals } = await dealQ;

  // ── 3) Activities in window (period scoped if range, else lifetime).
  let actQ = supabaseAdmin.from('crm_activities')
    .select('owner_id, assigned_to, completed_at, activity_date, created_at')
    .eq('org_id', org_id).is('deleted_at', null)
    .range(0, 99999);
  actQ = withClient(actQ, client_id);
  actQ = applyActivityScope(actQ, scope);
  if (rangeFrom) actQ = actQ.gte('created_at', rangeFrom);
  if (rangeTo)   actQ = actQ.lte('created_at', rangeTo);
  const { data: acts } = await actQ;

  // Latest activity timestamp per owner — lifetime (drives the "last
  // touched" signal on the card, regardless of date range).
  let lastActQ = supabaseAdmin.from('crm_activities')
    .select('owner_id, assigned_to, activity_date, completed_at, created_at')
    .eq('org_id', org_id).is('deleted_at', null);
  lastActQ = withClient(lastActQ, client_id);
  lastActQ = applyActivityScope(lastActQ, scope);
  lastActQ = lastActQ.order('created_at', { ascending: false }).limit(2000);
  const { data: latestActs } = await lastActQ;

  // ── Aggregate per-owner. Initialise from the users list so an idle
  //    rep still gets a row of zeros.
  type Acc = ReturnType<typeof blankAcc>;
  const byOwner = new Map<string, Acc>();
  for (const u of (users ?? []) as Array<{ id: string }>) byOwner.set(u.id, blankAcc());

  // Leads.
  for (const l of (leads ?? []) as Array<{
    owner_id: string | null; status: string | null; created_at: string;
    score: number | null; converted_at: string | null;
  }>) {
    if (!l.owner_id || !byOwner.has(l.owner_id)) continue;
    const a = byOwner.get(l.owner_id)!;
    a.total_leads_owned += 1;
    if (typeof l.score === 'number' && Number.isFinite(l.score)) {
      a.score_sum += l.score; a.score_n += 1;
    }
    const created = new Date(l.created_at);
    const status = l.status ?? '';
    if (status === 'qualified')   a.qualified_count   += 1;
    if (status === 'converted')   a.converted_count   += 1;
    if (status === 'unqualified') a.unqualified_count += 1;
    if (status === 'lost')        a.lost_leads_count  += 1;
    const isOpen = !['converted', 'unqualified', 'lost'].includes(status);
    if (isOpen) {
      const ageDays = Math.max(0, (now.getTime() - created.getTime()) / 86_400_000);
      a.open_lead_age_sum += ageDays; a.open_lead_age_n += 1;
      if (ageDays > a.oldest_open_lead_days) a.oldest_open_lead_days = ageDays;
    }
    if (created >= todayStart)  a.new_leads_today += 1;
    if (created >= weekStart)   a.new_leads_week  += 1;
    if (created >= monthStart)  a.new_leads_month += 1;
    if ((!rangeFrom || created >= new Date(rangeFrom)) &&
        (!rangeTo   || created <= new Date(rangeTo))) {
      a.new_leads_period += 1;
    }
  }

  // Deals.
  for (const d of (deals ?? []) as unknown as Array<{
    owner_id: string | null; amount: number | null; status: string | null;
    created_at: string; actual_close_date: string | null;
    crm_deal_stages: { stage_type: string };
  }>) {
    if (!d.owner_id || !byOwner.has(d.owner_id)) continue;
    const a = byOwner.get(d.owner_id)!;
    const stageType = d.crm_deal_stages?.stage_type ?? '';
    const amount = Number(d.amount ?? 0);
    if (stageType === 'won') {
      // Period-bound when range is supplied; else lifetime.
      const matchesRange =
        (!rangeFrom || (d.actual_close_date ? new Date(d.actual_close_date) >= new Date(rangeFrom) : false)) &&
        (!rangeTo   || (d.actual_close_date ? new Date(d.actual_close_date) <= new Date(rangeTo)   : false));
      if (rangeFrom || rangeTo) {
        if (matchesRange) {
          a.won_count += 1; a.won_value += amount;
          if (d.actual_close_date) {
            const cycle = (new Date(d.actual_close_date).getTime() - new Date(d.created_at).getTime()) / 86_400_000;
            if (Number.isFinite(cycle) && cycle >= 0) { a.cycle_sum += cycle; a.cycle_n += 1; }
          }
        }
      } else {
        a.won_count += 1; a.won_value += amount;
        if (d.actual_close_date) {
          const cycle = (new Date(d.actual_close_date).getTime() - new Date(d.created_at).getTime()) / 86_400_000;
          if (Number.isFinite(cycle) && cycle >= 0) { a.cycle_sum += cycle; a.cycle_n += 1; }
        }
      }
    } else if (stageType === 'lost') {
      a.lost_count += 1;
    } else {
      // Open / pipeline.
      a.open_count += 1;
      a.open_pipeline_value += amount;
    }
  }

  // Activities — completed + total counts in the period.
  for (const act of (acts ?? []) as Array<{
    owner_id: string | null; assigned_to: string | null; completed_at: string | null;
  }>) {
    const owner = act.assigned_to || act.owner_id;
    if (!owner || !byOwner.has(owner)) continue;
    const a = byOwner.get(owner)!;
    a.activities_total_period += 1;
    // Use completed_at (the authoritative completion signal) rather than
    // the status field, which may lag or be absent on older rows.
    if (act.completed_at) a.activities_completed_period += 1;
  }

  // Latest activity per owner (lifetime).
  const lastTouchByOwner = new Map<string, string>();
  for (const act of (latestActs ?? []) as Array<{
    owner_id: string | null; assigned_to: string | null;
    activity_date: string | null; completed_at: string | null; created_at: string;
  }>) {
    const owner = act.assigned_to || act.owner_id;
    if (!owner || !byOwner.has(owner)) continue;
    if (lastTouchByOwner.has(owner)) continue;
    const ts = act.completed_at || act.activity_date || act.created_at;
    if (ts) lastTouchByOwner.set(owner, ts);
  }

  const nameById = new Map<string, string>();
  for (const u of (users ?? []) as Array<{ id: string; name?: string | null; full_name?: string | null; email?: string | null }>) {
    nameById.set(u.id, u.name?.trim() || u.full_name?.trim() || u.email?.trim() || 'User');
  }

  const rowFromAgg = (id: string | null, name: string, a: Acc): TeamPerformanceRow => ({
    user_id: id,
    name,
    total_leads_owned: a.total_leads_owned,
    new_leads_today:   a.new_leads_today,
    new_leads_week:    a.new_leads_week,
    new_leads_month:   a.new_leads_month,
    new_leads_period:  a.new_leads_period,
    qualified_count:   a.qualified_count,
    converted_count:   a.converted_count,
    unqualified_count: a.unqualified_count,
    lost_leads_count:  a.lost_leads_count,
    qualified_rate:    a.total_leads_owned > 0 ? a.qualified_count / a.total_leads_owned : 0,
    converted_rate:    a.total_leads_owned > 0 ? a.converted_count / a.total_leads_owned : 0,
    won_count:           a.won_count,
    won_value:           a.won_value,
    lost_count:          a.lost_count,
    open_count:          a.open_count,
    open_pipeline_value: a.open_pipeline_value,
    conversion_rate:     (a.won_count + a.lost_count) > 0 ? a.won_count / (a.won_count + a.lost_count) : 0,
    avg_deal_size:       a.won_count > 0 ? a.won_value / a.won_count : 0,
    avg_sales_cycle_days: a.cycle_n > 0 ? a.cycle_sum / a.cycle_n : 0,
    avg_ageing_days:     a.open_lead_age_n > 0 ? a.open_lead_age_sum / a.open_lead_age_n : 0,
    oldest_open_lead_days: a.oldest_open_lead_days,
    activities_completed_period: a.activities_completed_period,
    activities_total_period:     a.activities_total_period,
    last_activity_at:    id ? (lastTouchByOwner.get(id) ?? null) : null,
    avg_lead_score:      a.score_n > 0 ? a.score_sum / a.score_n : 0,
  });

  const rows: TeamPerformanceRow[] = [];
  for (const [id, agg] of byOwner.entries()) {
    rows.push(rowFromAgg(id, nameById.get(id) ?? 'User', agg));
  }
  rows.sort((a, b) => b.won_value - a.won_value || b.won_count - a.won_count || a.name.localeCompare(b.name));

  // Total = sum-of-rows (re-derived ratios at the aggregate, not the mean of per-rep ratios).
  const tot = blankAcc();
  for (const a of byOwner.values()) {
    tot.total_leads_owned += a.total_leads_owned;
    tot.new_leads_today   += a.new_leads_today;
    tot.new_leads_week    += a.new_leads_week;
    tot.new_leads_month   += a.new_leads_month;
    tot.new_leads_period  += a.new_leads_period;
    tot.qualified_count   += a.qualified_count;
    tot.converted_count   += a.converted_count;
    tot.unqualified_count += a.unqualified_count;
    tot.lost_leads_count  += a.lost_leads_count;
    tot.won_count         += a.won_count;
    tot.won_value         += a.won_value;
    tot.lost_count        += a.lost_count;
    tot.open_count        += a.open_count;
    tot.open_pipeline_value += a.open_pipeline_value;
    tot.activities_completed_period += a.activities_completed_period;
    tot.activities_total_period     += a.activities_total_period;
    tot.cycle_sum        += a.cycle_sum;        tot.cycle_n        += a.cycle_n;
    tot.open_lead_age_sum += a.open_lead_age_sum; tot.open_lead_age_n += a.open_lead_age_n;
    tot.score_sum        += a.score_sum;        tot.score_n        += a.score_n;
    if (a.oldest_open_lead_days > tot.oldest_open_lead_days) tot.oldest_open_lead_days = a.oldest_open_lead_days;
  }
  const total = rowFromAgg(null, 'Total', tot);
  return { total, rows };
}

// blank accumulator + blank row helpers
function blankAcc() {
  return {
    total_leads_owned: 0,
    new_leads_today: 0, new_leads_week: 0, new_leads_month: 0, new_leads_period: 0,
    qualified_count: 0, converted_count: 0, unqualified_count: 0, lost_leads_count: 0,
    won_count: 0, won_value: 0, lost_count: 0, open_count: 0, open_pipeline_value: 0,
    cycle_sum: 0, cycle_n: 0,
    open_lead_age_sum: 0, open_lead_age_n: 0, oldest_open_lead_days: 0,
    activities_completed_period: 0, activities_total_period: 0,
    score_sum: 0, score_n: 0,
  };
}
function blankRow(name: string): TeamPerformanceRow {
  return {
    user_id: null, name,
    total_leads_owned: 0,
    new_leads_today: 0, new_leads_week: 0, new_leads_month: 0, new_leads_period: 0,
    qualified_count: 0, converted_count: 0, unqualified_count: 0, lost_leads_count: 0,
    qualified_rate: 0, converted_rate: 0,
    won_count: 0, won_value: 0, lost_count: 0, open_count: 0, open_pipeline_value: 0,
    conversion_rate: 0, avg_deal_size: 0, avg_sales_cycle_days: 0,
    avg_ageing_days: 0, oldest_open_lead_days: 0,
    activities_completed_period: 0, activities_total_period: 0,
    last_activity_at: null, avg_lead_score: 0,
  };
}

// ─── Lead Tracker ─────────────────────────────────────────────────
//
// Monthly count of new leads created across the caller's hierarchy
// subtree, for the last N months. Drives the bar chart on the
// Lead Tracker report.
//
// Plus three "period summary" rollups (today, this week so far, this
// month so far) so the rep can read recent volume at a glance without
// pulling extra endpoints.

export interface LeadTrackerBucket { key: string; count: number; }
export interface LeadTrackerPeriodSummary {
  label: string;
  from: string;
  to: string;
  new_leads: number;
  converted: number;
  conversion_rate: number;   // converted / new_leads
}
export interface LeadTrackerBreakdown { name: string; count: number; }

export interface LeadTrackerPayload {
  monthly: LeadTrackerBucket[];      // last N months — bar chart
  weekly: LeadTrackerBucket[];       // last 12 weeks — sparkline
  daily: LeadTrackerBucket[];        // last 30 days  — sparkline
  period_today: LeadTrackerPeriodSummary;
  period_week: LeadTrackerPeriodSummary;
  period_month: LeadTrackerPeriodSummary;
  // Status mix across the visible subtree (lifetime).
  status_breakdown: { new: number; working: number; qualified: number; converted: number; unqualified: number; lost: number };
  // Top 5 sources + top 5 cities (lifetime).
  source_breakdown: LeadTrackerBreakdown[];
  city_breakdown: LeadTrackerBreakdown[];
  // Distribution of open-lead ageing — for the heatmap card.
  ageing_distribution: { bucket: string; count: number }[];
}

export async function leadTracker(
  org_id: string,
  months = 6,
  client_id: string | null = null,
  scope?: AnalyticsScope,
): Promise<LeadTrackerPayload> {
  const safeMonths = Math.max(1, Math.min(24, Math.floor(months)));
  const now = new Date();

  // Lifetime status / source / city aggregates need every lead; cap the
  // chart aggregations at the last N months for chart performance.
  // .range(0, 99999) lifts the 1000-row PostgREST cap so the tracker
  // counts every lead, not just the first 1000.
  let q = supabaseAdmin.from('crm_leads')
    .select('created_at, owner_id, status, source_id, city, crm_lead_sources(name)')
    .eq('org_id', org_id).is('deleted_at', null)
    .range(0, 99999);
  q = withClient(q, client_id);
  q = applyLeadScope(q, scope);
  const { data: leads } = await q;

  // Initialise monthly / weekly / daily buckets so empty windows render zero.
  const monthlyBuckets: Record<string, number> = {};
  for (let i = 0; i < safeMonths; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (safeMonths - 1 - i), 1));
    monthlyBuckets[`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`] = 0;
  }
  const weeklyBuckets: Record<string, number> = {};
  for (let i = 0; i < 12; i++) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i * 7);
    const year = d.getUTCFullYear();
    const onejan = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((d.getTime() - onejan.getTime()) / 86_400_000) + onejan.getUTCDay() + 1) / 7);
    weeklyBuckets[`${year}-W${String(week).padStart(2, '0')}`] = 0;
  }
  const dailyBuckets: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    dailyBuckets[d.toISOString().slice(0, 10)] = 0;
  }

  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const day = todayStart.getUTCDay() || 7;
  const weekStart = new Date(todayStart); weekStart.setUTCDate(weekStart.getUTCDate() - (day - 1));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const status = { new: 0, working: 0, qualified: 0, converted: 0, unqualified: 0, lost: 0 };
  const sourceCounts = new Map<string, number>();
  const cityCounts = new Map<string, number>();
  const ageingBuckets: Record<string, number> = { '0-7d': 0, '8-30d': 0, '31-90d': 0, '90+d': 0 };
  const periodCounts = { today: { new: 0, conv: 0 }, week: { new: 0, conv: 0 }, month: { new: 0, conv: 0 } };

  for (const l of (leads ?? []) as Array<{
    created_at: string; status: string | null;
    crm_lead_sources?: { name?: string } | null; city: string | null;
  }>) {
    const t = new Date(l.created_at);
    if (!Number.isFinite(t.getTime())) continue;

    // Chart buckets.
    const mkey = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
    if (mkey in monthlyBuckets) monthlyBuckets[mkey] += 1;
    const dkey = t.toISOString().slice(0, 10);
    if (dkey in dailyBuckets) dailyBuckets[dkey] += 1;

    // Status.
    const s = (l.status ?? '').toLowerCase();
    if (s in status) status[s as keyof typeof status] += 1;

    // Period rollups.
    const isConv = s === 'converted';
    if (t >= todayStart) { periodCounts.today.new  += 1; if (isConv) periodCounts.today.conv += 1; }
    if (t >= weekStart)  { periodCounts.week.new   += 1; if (isConv) periodCounts.week.conv  += 1; }
    if (t >= monthStart) { periodCounts.month.new  += 1; if (isConv) periodCounts.month.conv += 1; }

    // Source / city breakdowns.
    const srcName = l.crm_lead_sources?.name?.trim() || 'Unspecified';
    sourceCounts.set(srcName, (sourceCounts.get(srcName) ?? 0) + 1);
    if (l.city) cityCounts.set(l.city, (cityCounts.get(l.city) ?? 0) + 1);

    // Ageing distribution for open leads.
    if (!['converted', 'unqualified', 'lost'].includes(s)) {
      const ageDays = (now.getTime() - t.getTime()) / 86_400_000;
      if      (ageDays <= 7)   ageingBuckets['0-7d']   += 1;
      else if (ageDays <= 30)  ageingBuckets['8-30d']  += 1;
      else if (ageDays <= 90)  ageingBuckets['31-90d'] += 1;
      else                     ageingBuckets['90+d']   += 1;
    }
  }

  const monthly: LeadTrackerBucket[] = Object.entries(monthlyBuckets)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const weekly: LeadTrackerBucket[] = Object.entries(weeklyBuckets)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const daily: LeadTrackerBucket[] = Object.entries(dailyBuckets)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const topN = (m: Map<string, number>): LeadTrackerBreakdown[] =>
    Array.from(m.entries()).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 5);

  const period = (label: string, from: Date, to: Date, p: { new: number; conv: number }): LeadTrackerPeriodSummary => ({
    label,
    from: from.toISOString(),
    to:   to.toISOString(),
    new_leads: p.new,
    converted: p.conv,
    conversion_rate: p.new > 0 ? p.conv / p.new : 0,
  });

  return {
    monthly, weekly, daily,
    period_today: period('Today',     todayStart, now, periodCounts.today),
    period_week:  period('This week', weekStart,  now, periodCounts.week),
    period_month: period('This month', monthStart, now, periodCounts.month),
    status_breakdown: status,
    source_breakdown: topN(sourceCounts),
    city_breakdown:   topN(cityCounts),
    ageing_distribution: Object.entries(ageingBuckets).map(([bucket, count]) => ({ bucket, count })),
  };
}

// ─── Team Daily Activity ──────────────────────────────────────────
//
// One card per rep in the caller's subtree for a given calendar day.
// Each card carries:
//   - attendance: check-in time + address + lat/lng (or null = absent)
//   - visits: achieved (today's site_visit activities, status=completed)
//             vs scheduled (open activities with activity_date = day)
//   - lead_tracker: count of leads owned by this rep created that day
// Sorted with present-and-active reps first, absent last, so the
// supervisor's eye lands on the cards that need attention.

export interface TeamDailyCard {
  user_id: string;
  name: string;
  // CRM-derived signal of "where they are right now" — the lat/lng on
  // the most recent lead they created (today or earlier). No attendance
  // dependency.
  last_known_location: {
    captured_at: string | null;
    source: 'lead_created' | null;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
  };
  last_activity_at: string | null;
  // What they did on the chosen day, broken out by activity type so the
  // supervisor can tell "is this rep on the phone or in the field?"
  activities_today: {
    total: number;
    completed: number;
    calls: number;
    emails: number;
    meetings: number;
    site_visits: number;
    tasks: number;
    other: number;
  };
  leads_today: number;
  leads_today_qualified: number;
  leads_today_converted: number;
  deals_open_count: number;
  deals_won_today_count: number;
  deals_won_today_value: number;
  pipeline_value: number;
  status: 'active' | 'idle' | 'inactive';
}

export async function teamDaily(
  org_id: string,
  date: string,                 // YYYY-MM-DD; defaults to today
  client_id: string | null = null,
  scope?: AnalyticsScope,
): Promise<TeamDailyCard[]> {
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : new Date().toISOString().slice(0, 10);
  const dayStart = `${ymd}T00:00:00.000Z`;
  const dayEnd   = `${ymd}T23:59:59.999Z`;

  // Resolve the subtree.
  const subtree = scope?.visibleOwnerIds ?? null;
  let userQ = supabaseAdmin.from('users')
    .select('id, name, full_name, email, client_id')
    .eq('org_id', org_id);
  if (client_id) userQ = userQ.eq('client_id', client_id);
  if (subtree && subtree.length > 0) userQ = userQ.in('id', subtree);
  else if (subtree && subtree.length === 0) return [];
  const { data: users } = await userQ;
  const userIds = (users ?? []).map((u: { id: string }) => u.id);
  if (userIds.length === 0) return [];

  // Fan-out parallel queries.
  const [actRes, leadsTodayRes, latestLeadRes, dealsRes, lastActRes] = await Promise.all([
    // Activities owned/assigned on the chosen day, with type for the
    // breakdown.
    supabaseAdmin.from('crm_activities')
      .select('owner_id, assigned_to, status, type')
      .eq('org_id', org_id).is('deleted_at', null)
      .or(`owner_id.in.(${userIds.join(',')}),assigned_to.in.(${userIds.join(',')})`)
      .gte('activity_date', dayStart).lte('activity_date', dayEnd),
    // Leads created on the chosen day, with status for qualified/converted counts.
    supabaseAdmin.from('crm_leads')
      .select('owner_id, status')
      .eq('org_id', org_id).is('deleted_at', null)
      .in('owner_id', userIds)
      .gte('created_at', dayStart).lte('created_at', dayEnd),
    // Latest lead per rep (lifetime) — drives the "last known location"
    // since we no longer use attendance. Cap response to avoid pulling
    // every lead; we only need the most recent N per rep.
    supabaseAdmin.from('crm_leads')
      .select('owner_id, latitude, longitude, address_line1, city, created_at')
      .eq('org_id', org_id).is('deleted_at', null)
      .in('owner_id', userIds)
      .not('latitude', 'is', null).not('longitude', 'is', null)
      .order('created_at', { ascending: false })
      .limit(2000),
    // Deals — open + won-on-day rollups.
    supabaseAdmin.from('crm_deals')
      .select('owner_id, amount, status, actual_close_date, crm_deal_stages!inner(stage_type)')
      .eq('org_id', org_id).is('deleted_at', null)
      .in('owner_id', userIds),
    // Latest activity per rep (lifetime).
    supabaseAdmin.from('crm_activities')
      .select('owner_id, assigned_to, completed_at, activity_date, created_at')
      .eq('org_id', org_id).is('deleted_at', null)
      .or(`owner_id.in.(${userIds.join(',')}),assigned_to.in.(${userIds.join(',')})`)
      .order('created_at', { ascending: false })
      .limit(2000),
  ]);

  type ActBreak = { total: number; completed: number; calls: number; emails: number; meetings: number; site_visits: number; tasks: number; other: number };
  const blankAct = (): ActBreak => ({ total: 0, completed: 0, calls: 0, emails: 0, meetings: 0, site_visits: 0, tasks: 0, other: 0 });
  const actByUser = new Map<string, ActBreak>();
  for (const act of (actRes.data ?? []) as Array<{
    owner_id: string | null; assigned_to: string | null; status: string | null; type: string | null;
  }>) {
    const user = act.assigned_to || act.owner_id;
    if (!user || !userIds.includes(user)) continue;
    let a = actByUser.get(user);
    if (!a) { a = blankAct(); actByUser.set(user, a); }
    a.total += 1;
    if (act.status === 'completed') a.completed += 1;
    const t = (act.type ?? 'other').toLowerCase();
    if      (t === 'call')                          a.calls       += 1;
    else if (t === 'email')                         a.emails      += 1;
    else if (t === 'meeting')                       a.meetings    += 1;
    else if (t === 'site_visit' || t === 'visit')   a.site_visits += 1;
    else if (t === 'task')                          a.tasks       += 1;
    else                                            a.other       += 1;
  }

  // Leads today + status counts.
  const leadsByUser = new Map<string, { total: number; qualified: number; converted: number }>();
  for (const l of (leadsTodayRes.data ?? []) as Array<{ owner_id: string | null; status: string | null }>) {
    if (!l.owner_id) continue;
    let r = leadsByUser.get(l.owner_id);
    if (!r) { r = { total: 0, qualified: 0, converted: 0 }; leadsByUser.set(l.owner_id, r); }
    r.total += 1;
    if (l.status === 'qualified') r.qualified += 1;
    if (l.status === 'converted') r.converted += 1;
  }

  // Last known location — take the first lead row per rep (already ordered DESC).
  const locByUser = new Map<string, { captured_at: string; latitude: number | null; longitude: number | null; address: string | null }>();
  for (const l of (latestLeadRes.data ?? []) as Array<{
    owner_id: string | null; latitude: number | null; longitude: number | null;
    address_line1: string | null; city: string | null; created_at: string;
  }>) {
    if (!l.owner_id || locByUser.has(l.owner_id)) continue;
    const addr = [l.address_line1, l.city].filter(Boolean).join(', ') || null;
    locByUser.set(l.owner_id, {
      captured_at: l.created_at,
      latitude: l.latitude, longitude: l.longitude, address: addr,
    });
  }

  // Deals.
  const dealsByUser = new Map<string, { open: number; pipeline: number; won_today_count: number; won_today_value: number }>();
  for (const d of (dealsRes.data ?? []) as unknown as Array<{
    owner_id: string | null; amount: number | null; status: string | null;
    actual_close_date: string | null; crm_deal_stages: { stage_type: string };
  }>) {
    if (!d.owner_id) continue;
    let r = dealsByUser.get(d.owner_id);
    if (!r) { r = { open: 0, pipeline: 0, won_today_count: 0, won_today_value: 0 }; dealsByUser.set(d.owner_id, r); }
    const stage = d.crm_deal_stages?.stage_type ?? '';
    if (stage !== 'won' && stage !== 'lost') {
      r.open += 1;
      r.pipeline += Number(d.amount ?? 0);
    }
    if (stage === 'won' && d.actual_close_date && d.actual_close_date >= dayStart && d.actual_close_date <= dayEnd) {
      r.won_today_count += 1;
      r.won_today_value += Number(d.amount ?? 0);
    }
  }

  // Last activity per rep (lifetime).
  const lastActByUser = new Map<string, string>();
  for (const act of (lastActRes.data ?? []) as Array<{
    owner_id: string | null; assigned_to: string | null;
    completed_at: string | null; activity_date: string | null; created_at: string;
  }>) {
    const user = act.assigned_to || act.owner_id;
    if (!user || lastActByUser.has(user)) continue;
    const ts = act.completed_at || act.activity_date || act.created_at;
    if (ts) lastActByUser.set(user, ts);
  }

  // Build cards.
  const cards: TeamDailyCard[] = (users ?? []).map((u: {
    id: string; name?: string | null; full_name?: string | null; email?: string | null;
  }) => {
    const act = actByUser.get(u.id) ?? blankAct();
    const leadsR = leadsByUser.get(u.id) ?? { total: 0, qualified: 0, converted: 0 };
    const loc = locByUser.get(u.id) ?? null;
    const deals = dealsByUser.get(u.id) ?? { open: 0, pipeline: 0, won_today_count: 0, won_today_value: 0 };
    const lastAct = lastActByUser.get(u.id) ?? null;
    const didSomething = act.total > 0 || leadsR.total > 0 || deals.won_today_count > 0;
    const recent = lastAct && (new Date(lastAct).getTime() >= new Date(dayStart).getTime());
    const status: TeamDailyCard['status'] = didSomething ? 'active' : (recent ? 'idle' : 'inactive');
    return {
      user_id: u.id,
      name: u.name?.trim() || u.full_name?.trim() || u.email?.trim() || 'User',
      last_known_location: loc
        ? { captured_at: loc.captured_at, source: 'lead_created', latitude: loc.latitude, longitude: loc.longitude, address: loc.address }
        : { captured_at: null, source: null, latitude: null, longitude: null, address: null },
      last_activity_at: lastAct,
      activities_today: act,
      leads_today: leadsR.total,
      leads_today_qualified: leadsR.qualified,
      leads_today_converted: leadsR.converted,
      deals_open_count: deals.open,
      deals_won_today_count: deals.won_today_count,
      deals_won_today_value: deals.won_today_value,
      pipeline_value: deals.pipeline,
      status,
    };
  });

  const rank = (c: TeamDailyCard): number => c.status === 'active' ? 0 : (c.status === 'idle' ? 1 : 2);
  cards.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return cards;
}

// ─── Widget Summary ───────────────────────────────────────────────
//
// Tiny payload sized for iOS WidgetKit / Android AppWidget refresh
// loops. Polled by mobile widget extensions every 15–30 minutes; kept
// small so the round-trip is cheap on cellular and so the response
// fits comfortably under the 16KB shared-data quota a widget extension
// gets to write back to the parent app.

export interface WidgetSummary {
  total_leads: number;
  total_conversions: number;
  conversion_rate: number;        // 0..1
  leads_today: number;
  leads_week: number;
  trend_7d: number[];             // 7 daily counts, oldest → newest
  // Deal-side stats so the home-screen widget can render both halves
  // of the pipeline in one tile. The rep can see incoming leads AND
  // open / closed-won deal counts without launching the app.
  open_deals: number;
  won_deals_30d: number;
  open_deal_value: number;        // rupees
  refreshed_at: string;           // ISO; the widget shows "Updated X ago"
}

export async function widgetSummary(
  org_id: string,
  client_id: string | null = null,
  scope?: AnalyticsScope,
): Promise<WidgetSummary> {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const day = todayStart.getUTCDay() || 7;
  const weekStart = new Date(todayStart); weekStart.setUTCDate(weekStart.getUTCDate() - (day - 1));
  // 7-day trend window: last 7 days inclusive (oldest day is 6 days ago).
  const trendStart = new Date(todayStart); trendStart.setUTCDate(trendStart.getUTCDate() - 6);

  let q = supabaseAdmin.from('crm_leads')
    .select('created_at, status')
    .eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  q = applyLeadScope(q, scope);
  const { data: leads } = await q;

  // Initialise the 7-day buckets so empty days render at zero.
  const dayBuckets: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(trendStart); d.setUTCDate(d.getUTCDate() + i);
    dayBuckets[d.toISOString().slice(0, 10)] = 0;
  }

  let total_leads = 0;
  let total_conversions = 0;
  let leads_today = 0;
  let leads_week = 0;
  for (const l of (leads ?? []) as Array<{ created_at: string; status: string | null }>) {
    total_leads += 1;
    if (l.status === 'converted') total_conversions += 1;
    const t = new Date(l.created_at);
    if (!Number.isFinite(t.getTime())) continue;
    if (t >= todayStart) leads_today += 1;
    if (t >= weekStart)  leads_week  += 1;
    const dkey = t.toISOString().slice(0, 10);
    if (dkey in dayBuckets) dayBuckets[dkey] += 1;
  }

  const trend_7d = Object.entries(dayBuckets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v);

  // Deal-side counts for the widget's "Deals" half. Open vs won is
  // resolved by joining the stage's stage_type so it stays in sync
  // with any pipeline reshuffle the admin does on the web console.
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  const dealQ = withClient(applyOwnerScope(supabaseAdmin.from('crm_deals')
    .select('amount, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).is('deleted_at', null)
    .range(0, 99999), scope), client_id);
  const { data: dealRows } = await dealQ;
  let open_deals = 0;
  let won_deals_30d = 0;
  let open_deal_value = 0;
  for (const d of (dealRows ?? []) as Array<{
    amount?: number | string | null;
    actual_close_date?: string | null;
    crm_deal_stages?: { stage_type?: string } | { stage_type?: string }[] | null;
  }>) {
    const st = Array.isArray(d.crm_deal_stages) ? d.crm_deal_stages[0]?.stage_type : d.crm_deal_stages?.stage_type;
    const amt = typeof d.amount === 'number'
      ? d.amount
      : typeof d.amount === 'string'
        ? Number(d.amount) || 0
        : 0;
    if (st === 'open') {
      open_deals += 1;
      if (amt > 0) open_deal_value += amt;
    } else if (st === 'won') {
      const closedAt = d.actual_close_date ? new Date(d.actual_close_date) : null;
      if (closedAt && Number.isFinite(closedAt.getTime()) && closedAt >= thirtyDaysAgo) {
        won_deals_30d += 1;
      }
    }
  }
  open_deal_value = Math.round(open_deal_value);

  return {
    total_leads,
    total_conversions,
    conversion_rate: total_leads > 0 ? total_conversions / total_leads : 0,
    leads_today,
    leads_week,
    trend_7d,
    open_deals,
    won_deals_30d,
    open_deal_value,
    refreshed_at: now.toISOString(),
  };
}

export async function salesCycle(org_id: string, range?: DateRange, client_id: string | null = null, scope?: AnalyticsScope) {
  let q = supabaseAdmin.from('crm_deals')
    .select('created_at, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id).is('deleted_at', null).eq('crm_deal_stages.stage_type', 'won').not('actual_close_date', 'is', null);
  q = withClient(q, client_id);
  // Deals are scoped by ownership (no city column on the table). The
  // audit caught that the manager view was leaking org-wide cycle
  // data into every ASO's report.
  q = applyOwnerScope(q, scope);
  if (range?.from) q = q.gte('actual_close_date', range.from.slice(0, 10));
  if (range?.to) q = q.lte('actual_close_date', range.to.slice(0, 10));
  // .range(0, 99999) lifts the hard 500-deal cap so tenants with a
  // larger pipeline see a real average instead of a truncated one.
  const { data } = await q.range(0, 99999);
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
  // .range(0, 99999) lifts the 1000-row cap so forecast covers
  // every open / won deal, not just the first 1000.
  let openQ = supabaseAdmin.from('crm_deals')
    .select(`amount, probability, expected_close_date, crm_deal_stages!inner(probability, stage_type)${lines}`)
    .eq('org_id', org_id).is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'open')
    .lte('expected_close_date', cutoff).not('expected_close_date', 'is', null)
    .range(0, 99999);
  openQ = withClient(openQ, client_id);
  openQ = applyOwnerScope(openQ, scope);
  if (fromCutoff) openQ = openQ.gte('expected_close_date', fromCutoff);

  // Already-closed-won amounts in the same horizon (so the chart can plot a "closed" line)
  let wonQ = supabaseAdmin.from('crm_deals')
    .select(`amount, actual_close_date, crm_deal_stages!inner(stage_type)${lines}`)
    .eq('org_id', org_id).is('deleted_at', null)
    .eq('crm_deal_stages.stage_type', 'won')
    .not('actual_close_date', 'is', null)
    .lte('actual_close_date', cutoff)
    .range(0, 99999);
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

export async function activityHeatmap(org_id: string, client_id: string | null = null, scope?: AnalyticsScope) {
  // Last 31 days × 24 hours. Returns full grid (744 rows incl. zeros) so the
  // frontend can render a date-by-hour heatmap without gap-filling.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 30);
  // .range(0, 99999) lifts the row cap so the heatmap reflects every
  // activity in the window, not just the first 1000.
  // applyActivityScope keeps the manager's view bounded to their
  // hierarchy subtree (without it the heatmap leaked org-wide
  // activity to every ASO / Consumer Champion in the audit).
  const { data } = await withClient(
    applyActivityScope(
      supabaseAdmin
        .from('crm_activities')
        .select('created_at')
        .eq('org_id', org_id)
        .is('deleted_at', null)
        .gte('created_at', since.toISOString())
        .range(0, 99999),
      scope,
    ),
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

export async function leadSourceRoi(org_id: string, client_id: string | null = null, scope?: AnalyticsScope) {
  // Live query — the MV (crm_mv_lead_source_roi) doesn't track client_id.
  // Pull leads + their source name + cost-per-lead and any converted-deal amount.
  // .range(0, 99999) lifts the row cap so source ROI covers every
  // lead, not just the first 1000.
  // applyLeadScope keeps the manager's view bounded to their team's
  // leads — without it source ROI bled org-wide numbers into every
  // ASO's report (the audit-flagged accuracy bug).
  let lq = supabaseAdmin.from('crm_leads')
    .select('status, converted_deal_id, crm_lead_sources(name, cost_per_lead)')
    .eq('org_id', org_id).is('deleted_at', null)
    .range(0, 99999);
  lq = withClient(lq, client_id);
  lq = applyLeadScope(lq, scope);
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
  // .range(0, 99999) lifts the row cap so the distribution covers
  // every lead, not just the first 1000.
  let q = supabaseAdmin.from('crm_leads').select('score').eq('org_id', org_id).is('deleted_at', null).range(0, 99999);
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

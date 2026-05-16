/**
 * Extended CRM analytics — the 15 widgets that power the customizable
 * Lead Analytics page. Each function returns a serializable shape ready
 * to drop straight into a Recharts component on the dashboard.
 */
import { supabaseAdmin } from '../../lib/supabase';

export interface DateRange { from?: string; to?: string }

function withClient<T>(q: T, client_id: string | null): T {
  const qb = q as any;
  if (client_id) return qb.eq('client_id', client_id);
  return qb;
}

function monthKey(iso: string): string { return iso.slice(0, 7); }

// 1. Lead Velocity Rate — MoM % growth in qualified leads
export async function leadVelocity(org_id: string, client_id: string | null = null, months_back = 6) {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months_back);
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  let q = supabaseAdmin.from('crm_leads')
    .select('created_at, status')
    .eq('org_id', org_id).is('deleted_at', null)
    .gte('created_at', since.toISOString());
  q = withClient(q, client_id);
  const { data } = await q;

  const buckets = new Map<string, { total: number; qualified: number }>();
  for (const r of (data ?? []) as Array<{ created_at: string; status: string }>) {
    const m = monthKey(r.created_at);
    const e = buckets.get(m) ?? { total: 0, qualified: 0 };
    e.total++;
    if (['qualified', 'converted'].includes(r.status)) e.qualified++;
    buckets.set(m, e);
  }

  const sorted = Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([month, v], i) => {
    const prev = i > 0 ? sorted[i - 1][1].qualified : null;
    const mom = prev != null && prev > 0 ? ((v.qualified - prev) / prev) * 100 : null;
    return { month, total: v.total, qualified: v.qualified, mom_growth_pct: mom == null ? null : Math.round(mom * 10) / 10 };
  });
}

// 2. Time-to-first-touch — avg + median + SLA breach %
export async function timeToFirstTouch(org_id: string, client_id: string | null = null, range?: DateRange, sla_minutes = 60) {
  const fromIso = range?.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const toIso = range?.to ?? new Date().toISOString();

  let lq = supabaseAdmin.from('crm_leads')
    .select('id, created_at')
    .eq('org_id', org_id).is('deleted_at', null)
    .gte('created_at', fromIso).lte('created_at', toIso);
  lq = withClient(lq, client_id);
  const { data: leads } = await lq;
  if (!leads?.length) return { avg_minutes: 0, median_minutes: 0, sla_breach_pct: 0, total: 0, breaches: 0, sla_minutes, distribution: [] };

  const leadIds = leads.map((l: any) => l.id);
  const { data: acts } = await supabaseAdmin.from('crm_activities')
    .select('lead_id, created_at')
    .in('lead_id', leadIds)
    .order('created_at', { ascending: true });

  const firstByLead = new Map<string, string>();
  for (const a of acts ?? []) {
    const k = (a as any).lead_id as string;
    if (!firstByLead.has(k)) firstByLead.set(k, (a as any).created_at as string);
  }

  const minutes: number[] = [];
  let breaches = 0;
  for (const l of leads as Array<{ id: string; created_at: string }>) {
    const first = firstByLead.get(l.id);
    if (!first) continue;
    const m = (new Date(first).getTime() - new Date(l.created_at).getTime()) / 60_000;
    if (m < 0) continue;
    minutes.push(m);
    if (m > sla_minutes) breaches++;
  }

  minutes.sort((a, b) => a - b);
  const avg = minutes.length ? minutes.reduce((a, b) => a + b, 0) / minutes.length : 0;
  const median = minutes.length ? minutes[Math.floor(minutes.length / 2)] : 0;

  const dist = [
    { bucket: '<5m', max: 5, count: 0 },
    { bucket: '5–15m', max: 15, count: 0 },
    { bucket: '15–60m', max: 60, count: 0 },
    { bucket: '1–4h', max: 240, count: 0 },
    { bucket: '4–24h', max: 1440, count: 0 },
    { bucket: '>24h', max: Infinity, count: 0 },
  ];
  for (const m of minutes) {
    const b = dist.find(d => m <= d.max);
    if (b) b.count++;
  }

  return {
    avg_minutes: Math.round(avg),
    median_minutes: Math.round(median),
    sla_breach_pct: minutes.length ? Math.round((breaches / minutes.length) * 1000) / 10 : 0,
    total: minutes.length,
    breaches,
    sla_minutes,
    distribution: dist.map(({ bucket, count }) => ({ bucket, count })),
  };
}

// 3. Stuck leads — counts at 7/14/30 day idle thresholds
export async function stuckLeads(org_id: string, client_id: string | null = null) {
  const now = Date.now();
  let lq = supabaseAdmin.from('crm_leads')
    .select('id, owner_id, last_activity_at, created_at, status')
    .eq('org_id', org_id).is('deleted_at', null)
    .in('status', ['new', 'working', 'nurturing', 'qualified']);
  lq = withClient(lq, client_id);
  const { data: leads } = await lq;

  let c7 = 0, c14 = 0, c30 = 0;
  const byOwner = new Map<string, { owner_id: string; count: number }>();
  for (const l of (leads ?? []) as Array<{ id: string; owner_id: string | null; last_activity_at: string | null; created_at: string }>) {
    const lastTouch = l.last_activity_at ?? l.created_at;
    const days = (now - new Date(lastTouch).getTime()) / 86_400_000;
    if (days >= 7) c7++;
    if (days >= 14) c14++;
    if (days >= 30) c30++;
    if (days >= 14) {
      const key = l.owner_id ?? 'unassigned';
      const e = byOwner.get(key) ?? { owner_id: key, count: 0 };
      e.count++;
      byOwner.set(key, e);
    }
  }

  const top_owners = Array.from(byOwner.values()).sort((a, b) => b.count - a.count).slice(0, 5);
  return { count_7d: c7, count_14d: c14, count_30d: c30, top_owners };
}

// 4-6. Lost / won / disqualification reason breakdowns
async function reasonsByStatus(
  org_id: string,
  client_id: string | null,
  range: DateRange | undefined,
  status: 'lost' | 'unqualified',
  reasonColumn: 'lost_reason',
) {
  let q = supabaseAdmin.from('crm_leads')
    .select(`${reasonColumn}`)
    .eq('org_id', org_id).is('deleted_at', null).eq('status', status);
  q = withClient(q, client_id);
  if (range?.from) q = q.gte('updated_at', range.from);
  if (range?.to) q = q.lte('updated_at', range.to);
  const { data } = await q;
  const map = new Map<string, number>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const k = (r[reasonColumn] as string | null) ?? 'Not specified';
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

export async function lostReasons(org_id: string, client_id: string | null = null, range?: DateRange) {
  return reasonsByStatus(org_id, client_id, range, 'lost', 'lost_reason');
}
export async function disqualificationReasons(org_id: string, client_id: string | null = null, range?: DateRange) {
  return reasonsByStatus(org_id, client_id, range, 'unqualified', 'lost_reason');
}
export async function wonReasons(org_id: string, client_id: string | null = null, range?: DateRange) {
  let q = supabaseAdmin.from('crm_leads')
    .select('won_reason')
    .eq('org_id', org_id).is('deleted_at', null).eq('status', 'converted').not('won_reason', 'is', null);
  q = withClient(q, client_id);
  if (range?.from) q = q.gte('updated_at', range.from);
  if (range?.to) q = q.lte('updated_at', range.to);
  const { data, error } = await q;
  if (error) return [];
  const map = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ won_reason: string | null }>) {
    const k = r.won_reason ?? 'Not specified';
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

// 7. Stage conversion — % advanced between adjacent pipeline stages
export async function stageConversion(org_id: string, pipeline_id: string | undefined, client_id: string | null = null) {
  let sq = supabaseAdmin.from('crm_deal_stages')
    .select('id, name, position, pipeline_id')
    .eq('org_id', org_id);
  if (pipeline_id) sq = sq.eq('pipeline_id', pipeline_id);
  sq = sq.order('position', { ascending: true });
  const { data: stages } = await sq;
  if (!stages?.length) return [];

  let dq = supabaseAdmin.from('crm_deals')
    .select('id, stage_id, pipeline_id, history:crm_deal_history(field, new_value)')
    .eq('org_id', org_id).is('deleted_at', null);
  if (pipeline_id) dq = dq.eq('pipeline_id', pipeline_id);
  dq = withClient(dq, client_id);
  const { data: deals } = await dq;
  if (!deals?.length) return [];

  const stageOrder = new Map((stages as Array<{ id: string; name: string; position: number }>).map(s => [s.id, s.position]));
  const maxByDeal = new Map<string, number>();
  for (const d of deals as Array<{ id: string; stage_id: string; history?: Array<{ field: string; new_value: any }> }>) {
    let maxPos = stageOrder.get(d.stage_id) ?? 0;
    for (const h of d.history ?? []) {
      if (h.field === 'stage_id' && typeof h.new_value === 'string') {
        const p = stageOrder.get(h.new_value);
        if (p != null && p > maxPos) maxPos = p;
      }
    }
    maxByDeal.set(d.id, maxPos);
  }

  const out: Array<{ from_stage: string; to_stage: string; entered: number; advanced: number; rate: number }> = [];
  const ordered = (stages as Array<{ id: string; name: string; position: number }>).sort((a, b) => a.position - b.position);
  for (let i = 0; i < ordered.length - 1; i++) {
    const fromPos = ordered[i].position;
    const toPos = ordered[i + 1].position;
    let entered = 0, advanced = 0;
    for (const max of maxByDeal.values()) {
      if (max >= fromPos) entered++;
      if (max >= toPos) advanced++;
    }
    out.push({
      from_stage: ordered[i].name,
      to_stage: ordered[i + 1].name,
      entered,
      advanced,
      rate: entered > 0 ? Math.round((advanced / entered) * 1000) / 10 : 0,
    });
  }
  return out;
}

// 8. Lead aging — open leads by age bucket
export async function leadAging(org_id: string, client_id: string | null = null) {
  let q = supabaseAdmin.from('crm_leads')
    .select('created_at, status')
    .eq('org_id', org_id).is('deleted_at', null)
    .not('status', 'in', '(converted,lost,unqualified)');
  q = withClient(q, client_id);
  const { data } = await q;
  const buckets = [
    { bucket: '0–7d', max: 7, count: 0 },
    { bucket: '8–30d', max: 30, count: 0 },
    { bucket: '31–60d', max: 60, count: 0 },
    { bucket: '60+d', max: Infinity, count: 0 },
  ];
  const now = Date.now();
  for (const r of (data ?? []) as Array<{ created_at: string }>) {
    const days = (now - new Date(r.created_at).getTime()) / 86_400_000;
    const b = buckets.find(b => days <= b.max);
    if (b) b.count++;
  }
  return buckets.map(({ bucket, count }) => ({ bucket, count }));
}

// 9. Cohort conversion — month cohort × age matrix
export async function cohortConversion(org_id: string, client_id: string | null = null, months_back = 6) {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months_back);
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  let q = supabaseAdmin.from('crm_leads')
    .select('created_at, status, converted_at')
    .eq('org_id', org_id).is('deleted_at', null)
    .gte('created_at', since.toISOString());
  q = withClient(q, client_id);
  const { data } = await q;

  const cohorts = new Map<string, { total: number; conv: Map<number, number> }>();
  for (const r of (data ?? []) as Array<{ created_at: string; status: string; converted_at: string | null }>) {
    const cohort = monthKey(r.created_at);
    const e = cohorts.get(cohort) ?? { total: 0, conv: new Map() };
    e.total++;
    if (r.status === 'converted' && r.converted_at) {
      const offset = monthOffset(cohort, monthKey(r.converted_at));
      e.conv.set(offset, (e.conv.get(offset) ?? 0) + 1);
    }
    cohorts.set(cohort, e);
  }

  return Array.from(cohorts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([cohort_month, v]) => {
    const cells: Array<{ age_months: number; converted: number; rate: number }> = [];
    let cumulative = 0;
    for (let m = 0; m <= months_back; m++) {
      cumulative += v.conv.get(m) ?? 0;
      cells.push({
        age_months: m,
        converted: cumulative,
        rate: v.total > 0 ? Math.round((cumulative / v.total) * 1000) / 10 : 0,
      });
    }
    return { cohort_month, total: v.total, cells };
  });
}

function monthOffset(aYM: string, bYM: string): number {
  const [ay, am] = aYM.split('-').map(Number);
  const [by, bm] = bYM.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// 10. Engagement comparison — avg touches per won vs lost
export async function engagementComparison(org_id: string, client_id: string | null = null, range?: DateRange) {
  let lq = supabaseAdmin.from('crm_leads')
    .select('id, status')
    .eq('org_id', org_id).is('deleted_at', null)
    .in('status', ['converted', 'lost']);
  lq = withClient(lq, client_id);
  if (range?.from) lq = lq.gte('updated_at', range.from);
  if (range?.to) lq = lq.lte('updated_at', range.to);
  const { data: leads } = await lq;
  if (!leads?.length) return { won: { avg: 0, count: 0 }, lost: { avg: 0, count: 0 } };

  const ids = leads.map((l: any) => l.id);
  const { data: acts } = await supabaseAdmin.from('crm_activities')
    .select('lead_id').in('lead_id', ids).is('deleted_at', null);

  const countByLead = new Map<string, number>();
  for (const a of acts ?? []) {
    const k = (a as any).lead_id as string;
    countByLead.set(k, (countByLead.get(k) ?? 0) + 1);
  }

  let wonSum = 0, wonN = 0, lostSum = 0, lostN = 0;
  for (const l of leads as Array<{ id: string; status: string }>) {
    const c = countByLead.get(l.id) ?? 0;
    if (l.status === 'converted') { wonSum += c; wonN++; }
    else { lostSum += c; lostN++; }
  }
  return {
    won: { avg: wonN ? Math.round((wonSum / wonN) * 10) / 10 : 0, count: wonN },
    lost: { avg: lostN ? Math.round((lostSum / lostN) * 10) / 10 : 0, count: lostN },
  };
}

// 11. Days-since-last-touch distribution
export async function daysSinceTouch(org_id: string, client_id: string | null = null) {
  let q = supabaseAdmin.from('crm_leads')
    .select('last_activity_at, created_at, status')
    .eq('org_id', org_id).is('deleted_at', null)
    .not('status', 'in', '(converted,lost)');
  q = withClient(q, client_id);
  const { data } = await q;
  const buckets = [
    { bucket: '0d', max: 0, count: 0 },
    { bucket: '1–3d', max: 3, count: 0 },
    { bucket: '4–7d', max: 7, count: 0 },
    { bucket: '8–14d', max: 14, count: 0 },
    { bucket: '15–30d', max: 30, count: 0 },
    { bucket: '30+d', max: Infinity, count: 0 },
  ];
  const now = Date.now();
  for (const r of (data ?? []) as Array<{ last_activity_at: string | null; created_at: string }>) {
    const ref = r.last_activity_at ?? r.created_at;
    const days = Math.floor((now - new Date(ref).getTime()) / 86_400_000);
    const b = buckets.find(b => days <= b.max);
    if (b) b.count++;
  }
  return buckets.map(({ bucket, count }) => ({ bucket, count }));
}

// 12. Score-band conversion — % of leads in each score band that converted
export async function scoreBandConversion(org_id: string, client_id: string | null = null, range?: DateRange) {
  let q = supabaseAdmin.from('crm_leads')
    .select('score, status')
    .eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  if (range?.from) q = q.gte('created_at', range.from);
  if (range?.to) q = q.lte('created_at', range.to);
  const { data } = await q;
  const bands = [
    { band: '0–19', min: 0, max: 19, total: 0, converted: 0 },
    { band: '20–39', min: 20, max: 39, total: 0, converted: 0 },
    { band: '40–59', min: 40, max: 59, total: 0, converted: 0 },
    { band: '60–79', min: 60, max: 79, total: 0, converted: 0 },
    { band: '80–100', min: 80, max: 100, total: 0, converted: 0 },
  ];
  for (const r of (data ?? []) as Array<{ score: number | null; status: string }>) {
    const s = Number(r.score ?? 0);
    const b = bands.find(b => s >= b.min && s <= b.max);
    if (!b) continue;
    b.total++;
    if (r.status === 'converted') b.converted++;
  }
  return bands.map(({ band, total, converted }) => ({
    band, total, converted,
    rate: total > 0 ? Math.round((converted / total) * 1000) / 10 : 0,
  }));
}

// 13. Territory conversion — by state (or city when state isn't stamped)
export async function territoryConversion(org_id: string, client_id: string | null = null, range?: DateRange) {
  let q = supabaseAdmin.from('crm_leads')
    .select('state, city, status')
    .eq('org_id', org_id).is('deleted_at', null);
  q = withClient(q, client_id);
  if (range?.from) q = q.gte('created_at', range.from);
  if (range?.to) q = q.lte('created_at', range.to);
  const { data } = await q;
  const map = new Map<string, { total: number; converted: number }>();
  for (const r of (data ?? []) as Array<{ state: string | null; city: string | null; status: string }>) {
    const k = r.state ?? r.city ?? 'Unspecified';
    const e = map.get(k) ?? { total: 0, converted: 0 };
    e.total++;
    if (r.status === 'converted') e.converted++;
    map.set(k, e);
  }
  return Array.from(map.entries())
    .map(([territory, v]) => ({
      territory, total: v.total, converted: v.converted,
      rate: v.total > 0 ? Math.round((v.converted / v.total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
}

// 14. Touchpoints-to-response — outbound touches before first inbound response
export async function touchpointsToResponse(org_id: string, client_id: string | null = null, range?: DateRange) {
  let lq = supabaseAdmin.from('crm_leads')
    .select('id, created_at')
    .eq('org_id', org_id).is('deleted_at', null);
  lq = withClient(lq, client_id);
  if (range?.from) lq = lq.gte('created_at', range.from);
  if (range?.to) lq = lq.lte('created_at', range.to);
  const { data: leads } = await lq;
  if (!leads?.length) return [];

  const ids = leads.map((l: any) => l.id);
  const { data: acts } = await supabaseAdmin.from('crm_activities')
    .select('lead_id, direction, created_at')
    .in('lead_id', ids).is('deleted_at', null)
    .order('created_at', { ascending: true });

  const buckets = [
    { bucket: '1', max: 1, count: 0 },
    { bucket: '2', max: 2, count: 0 },
    { bucket: '3', max: 3, count: 0 },
    { bucket: '4', max: 4, count: 0 },
    { bucket: '5+', max: Infinity, count: 0 },
    { bucket: 'No response', max: -1, count: 0 },
  ];

  const seenLead = new Set<string>();
  const outboundByLead = new Map<string, number>();
  for (const a of (acts ?? []) as Array<{ lead_id: string; direction: string | null }>) {
    if (seenLead.has(a.lead_id)) continue;
    if ((a.direction ?? '').toLowerCase() === 'outbound') {
      outboundByLead.set(a.lead_id, (outboundByLead.get(a.lead_id) ?? 0) + 1);
    } else if ((a.direction ?? '').toLowerCase() === 'inbound') {
      const n = outboundByLead.get(a.lead_id) ?? 0;
      const b = buckets.find(b => n <= b.max);
      if (b) b.count++;
      seenLead.add(a.lead_id);
    }
  }
  for (const l of leads as Array<{ id: string }>) {
    if (!seenLead.has(l.id)) buckets[buckets.length - 1].count++;
  }
  return buckets.map(({ bucket, count }) => ({ bucket, count }));
}

// 15. Leads at risk — open leads with high score AND no activity in 14d+
export async function leadsAtRisk(org_id: string, client_id: string | null = null, score_threshold = 60, idle_days = 14) {
  let q = supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, company, score, owner_id, last_activity_at, created_at')
    .eq('org_id', org_id).is('deleted_at', null)
    .gte('score', score_threshold)
    .in('status', ['new', 'working', 'nurturing', 'qualified']);
  q = withClient(q, client_id);
  const { data } = await q;
  const now = Date.now();
  return ((data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; company: string | null; score: number; owner_id: string | null; last_activity_at: string | null; created_at: string }>)
    .map(l => {
      const ref = l.last_activity_at ?? l.created_at;
      return {
        lead_id: l.id,
        name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.company || 'Unnamed',
        score: l.score,
        owner_id: l.owner_id,
        days_idle: Math.floor((now - new Date(ref).getTime()) / 86_400_000),
      };
    })
    .filter(l => l.days_idle >= idle_days)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
}

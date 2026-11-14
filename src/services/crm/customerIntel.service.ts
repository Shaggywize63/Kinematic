/**
 * Customer intelligence / sales analytics for the pharma CRM.
 *
 * Reads the lightweight crm_customer_orders ledger (written by the desk and by
 * MR field visits) and derives, per customer: average order value, ordering
 * frequency, last order date, days since last order, and a lifecycle label
 * (new / active / declining / dormant / churned). Plus org-level rollups:
 * monthly sales + growth, new-vs-repeat customers, and retention.
 *
 * Pure read model — no writes. All day math is IST (istTodayISO()).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { istTodayISO } from '../../lib/clientAccess';

const ORDERS = 'crm_customer_orders';
type Scope = { id: string | null; strict: boolean };

export interface IntelThresholds {
  dormant_days: number;   // no order ≥ this → dormant
  churned_days: number;   // no order ≥ this → churned (stopped ordering)
  new_window_days: number;// first order within this → "new customer"
}
const DEFAULTS: IntelThresholds = { dormant_days: 30, churned_days: 90, new_window_days: 30 };

function daysBetween(aISO: string, bISO: string): number {
  return Math.round((new Date(`${aISO}T00:00:00Z`).getTime() - new Date(`${bISO}T00:00:00Z`).getTime()) / 86400000);
}

async function loadThresholds(orgId: string): Promise<IntelThresholds> {
  try {
    const { data } = await supabaseAdmin.from('crm_settings').select('config').eq('org_id', orgId).limit(1);
    const cfg = (data?.[0] as any)?.config?.customer_intel || {};
    return {
      dormant_days: Number(cfg.dormant_days) > 0 ? Number(cfg.dormant_days) : DEFAULTS.dormant_days,
      churned_days: Number(cfg.churned_days) > 0 ? Number(cfg.churned_days) : DEFAULTS.churned_days,
      new_window_days: Number(cfg.new_window_days) > 0 ? Number(cfg.new_window_days) : DEFAULTS.new_window_days,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

interface OrderRow { customer_type: string; customer_id: string; customer_name: string | null; order_date: string; order_value: number }

async function loadOrders(orgId: string, scope: Scope, sinceISO?: string): Promise<OrderRow[]> {
  let q = supabaseAdmin.from(ORDERS).select('customer_type, customer_id, customer_name, order_date, order_value')
    .eq('org_id', orgId).is('deleted_at', null).limit(200000);
  if (scope.id) q = q.eq('client_id', scope.id);
  if (sinceISO) q = q.gte('order_date', sinceISO);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return ((data as any[]) || []).map((r) => ({ ...r, order_value: Number(r.order_value || 0) }));
}

export interface CustomerIntelRow {
  customer_type: string; customer_id: string; customer_name: string | null;
  orders: number; total_value: number; avg_order_value: number;
  first_order_date: string; last_order_date: string; days_since_last_order: number;
  orders_per_month: number;
  value_last_30: number; value_prev_30: number; trend_pct: number;
  lifecycle: 'new' | 'active' | 'declining' | 'dormant' | 'churned';
}

/** Per-customer RFM-style intelligence across all order history. */
export async function customerIntelligence(
  orgId: string, scope: Scope,
  query: { lifecycle?: string; q?: string; sort?: string; limit?: number } = {},
): Promise<{ today: string; thresholds: IntelThresholds; customers: CustomerIntelRow[]; summary: any }> {
  const today = istTodayISO();
  const th = await loadThresholds(orgId);
  const orders = await loadOrders(orgId, scope);

  const last30 = new Date(new Date(`${today}T00:00:00Z`).getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const prev30 = new Date(new Date(`${today}T00:00:00Z`).getTime() - 60 * 86400000).toISOString().slice(0, 10);

  const byCust = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const k = `${o.customer_type}:${o.customer_id}`;
    const arr = byCust.get(k) || [];
    arr.push(o); byCust.set(k, arr);
  }

  const rows: CustomerIntelRow[] = [];
  for (const [, arr] of byCust) {
    arr.sort((a, b) => a.order_date.localeCompare(b.order_date));
    const first = arr[0]; const last = arr[arr.length - 1];
    const total = arr.reduce((s, o) => s + o.order_value, 0);
    const orders_count = arr.length;
    const spanDays = Math.max(1, daysBetween(last.order_date, first.order_date));
    const orders_per_month = +(orders_count / (spanDays / 30 || 1)).toFixed(2);
    const days_since = daysBetween(today, last.order_date);
    const value_last_30 = arr.filter((o) => o.order_date > last30).reduce((s, o) => s + o.order_value, 0);
    const value_prev_30 = arr.filter((o) => o.order_date > prev30 && o.order_date <= last30).reduce((s, o) => s + o.order_value, 0);
    const trend_pct = value_prev_30 > 0 ? Math.round(((value_last_30 - value_prev_30) / value_prev_30) * 100) : (value_last_30 > 0 ? 100 : 0);

    let lifecycle: CustomerIntelRow['lifecycle'];
    if (days_since >= th.churned_days) lifecycle = 'churned';
    else if (days_since >= th.dormant_days) lifecycle = 'dormant';
    else if (daysBetween(today, first.order_date) <= th.new_window_days) lifecycle = 'new';
    else if (value_prev_30 > 0 && value_last_30 < value_prev_30 * 0.7) lifecycle = 'declining';
    else lifecycle = 'active';

    rows.push({
      customer_type: first.customer_type, customer_id: first.customer_id,
      customer_name: last.customer_name || first.customer_name,
      orders: orders_count, total_value: +total.toFixed(2), avg_order_value: +(total / orders_count).toFixed(2),
      first_order_date: first.order_date, last_order_date: last.order_date, days_since_last_order: days_since,
      orders_per_month, value_last_30: +value_last_30.toFixed(2), value_prev_30: +value_prev_30.toFixed(2), trend_pct,
      lifecycle,
    });
  }

  let filtered = rows;
  if (query.lifecycle) filtered = filtered.filter((r) => r.lifecycle === query.lifecycle);
  if (query.q) { const s = String(query.q).toLowerCase(); filtered = filtered.filter((r) => (r.customer_name || '').toLowerCase().includes(s)); }
  const sort = query.sort || 'total_value';
  filtered.sort((a: any, b: any) => (b[sort] ?? 0) - (a[sort] ?? 0));
  if (query.limit) filtered = filtered.slice(0, Number(query.limit));

  const summary = {
    total_customers: rows.length,
    new: rows.filter((r) => r.lifecycle === 'new').length,
    active: rows.filter((r) => r.lifecycle === 'active').length,
    declining: rows.filter((r) => r.lifecycle === 'declining').length,
    dormant: rows.filter((r) => r.lifecycle === 'dormant').length,
    churned: rows.filter((r) => r.lifecycle === 'churned').length,
    total_value: +rows.reduce((s, r) => s + r.total_value, 0).toFixed(2),
    avg_order_value: rows.length ? +(rows.reduce((s, r) => s + r.avg_order_value, 0) / rows.length).toFixed(2) : 0,
  };
  return { today, thresholds: th, customers: filtered, summary };
}

/** Monthly sales + MoM growth, new-vs-repeat customers, and simple retention. */
export async function salesTrends(
  orgId: string, scope: Scope, query: { months?: number } = {},
): Promise<any> {
  const months = Math.min(24, Math.max(3, Number(query.months) || 12));
  const today = istTodayISO();
  const start = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));
  const sinceISO = start.toISOString().slice(0, 10);
  const orders = await loadOrders(orgId, scope, sinceISO);

  // First-ever order date per customer (to classify new vs repeat per month).
  const allOrders = await loadOrders(orgId, scope);
  const firstByCust = new Map<string, string>();
  for (const o of allOrders) {
    const k = `${o.customer_type}:${o.customer_id}`;
    const cur = firstByCust.get(k);
    if (!cur || o.order_date < cur) firstByCust.set(k, o.order_date);
  }

  const monthMap = new Map<string, { month: string; value: number; orders: number; customers: Set<string>; new_customers: Set<string> }>();
  for (const o of orders) {
    const m = o.order_date.slice(0, 7);
    const b = monthMap.get(m) || { month: m, value: 0, orders: 0, customers: new Set<string>(), new_customers: new Set<string>() };
    const k = `${o.customer_type}:${o.customer_id}`;
    b.value += o.order_value; b.orders++; b.customers.add(k);
    if ((firstByCust.get(k) || '').slice(0, 7) === m) b.new_customers.add(k);
    monthMap.set(m, b);
  }
  // Fill every month in range even if empty.
  const series: any[] = [];
  const cursor = new Date(start);
  for (let i = 0; i < months; i++) {
    const m = cursor.toISOString().slice(0, 7);
    const b = monthMap.get(m);
    series.push({
      month: m,
      value: b ? +b.value.toFixed(2) : 0,
      orders: b ? b.orders : 0,
      active_customers: b ? b.customers.size : 0,
      new_customers: b ? b.new_customers.size : 0,
      repeat_customers: b ? (b.customers.size - b.new_customers.size) : 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  for (let i = 0; i < series.length; i++) {
    const prev = i > 0 ? series[i - 1].value : 0;
    series[i].growth_pct = prev > 0 ? Math.round(((series[i].value - prev) / prev) * 100) : (series[i].value > 0 && i > 0 ? 100 : 0);
    // Retention: of last month's active customers, how many ordered this month.
    if (i > 0) {
      const prevSet = monthMap.get(series[i - 1].month)?.customers || new Set<string>();
      const curSet = monthMap.get(series[i].month)?.customers || new Set<string>();
      let retained = 0; prevSet.forEach((c) => { if (curSet.has(c)) retained++; });
      series[i].retention_pct = prevSet.size ? Math.round((retained / prevSet.size) * 100) : 0;
    } else {
      series[i].retention_pct = 0;
    }
  }
  return { from: sinceISO, to: today, months, series };
}

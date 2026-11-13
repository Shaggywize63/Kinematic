/**
 * Pharma desk-calling service — the daily tele-calling workflow.
 *
 * Responsibilities:
 *   - generateDailyCallList: build (idempotently) the day's calling list from
 *     the CRM customer master (accounts and/or leads), assign to desk operators,
 *     NEVER overwriting a previous day. Driven by the IST calendar day.
 *   - listDailyCallTasks / deskDaySummary: the operator's working view.
 *   - updateCallTaskStatus: apply one of the 3 pharma dispositions
 *     (order_taken / order_pending / no_order). "Order Taken" writes a row to
 *     the lightweight crm_customer_orders ledger; a later order_taken on a
 *     customer who was order_pending marks the pending task resolved.
 *   - recordCustomerOrder: shared order-ledger writer (desk AND MR field use it).
 *   - deskReport / operatorProductivity: daily/weekly/monthly rollups.
 *
 * Tenant model: every query is org_id + strict client_id scoped. Order/visit
 * ownership lives on the row (captured_by) not the person, so history stays
 * with the company when an employee leaves.
 *
 * Time: all day boundaries are Asia/Kolkata (IST, UTC+05:30, no DST) via
 * istTodayISO(); timestamps are stored UTC and rendered IST by the clients.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { istTodayISO } from '../../lib/clientAccess';

const CALL_TASKS = 'crm_daily_call_tasks';
const ORDERS = 'crm_customer_orders';

export type CallStatus = 'pending' | 'order_taken' | 'order_pending' | 'no_order';
export type CustomerType = 'account' | 'lead';
type Scope = { id: string | null; strict: boolean };

export interface DeskConfig {
  customer_source: 'accounts' | 'leads' | 'both';
  operator_role_name: string;
  auto_assign: boolean;
}

/** Read the client's calling-desk config from crm_settings.config.calling_desk. */
export async function getDeskConfig(orgId: string, clientId: string | null): Promise<DeskConfig> {
  const defaults: DeskConfig = { customer_source: 'accounts', operator_role_name: 'Desk Operator', auto_assign: true };
  try {
    let q = supabaseAdmin.from('crm_settings').select('config').eq('org_id', orgId).limit(1);
    const { data } = await q;
    const cfg = (data?.[0] as any)?.config?.calling_desk || {};
    return {
      customer_source: ['accounts', 'leads', 'both'].includes(cfg.customer_source) ? cfg.customer_source : defaults.customer_source,
      operator_role_name: typeof cfg.operator_role_name === 'string' && cfg.operator_role_name ? cfg.operator_role_name : defaults.operator_role_name,
      auto_assign: cfg.auto_assign === undefined ? defaults.auto_assign : !!cfg.auto_assign,
    };
  } catch {
    return defaults;
  }
}

/** Active desk-operator user ids for this client, resolved by designation name. */
async function resolveOperators(orgId: string, clientId: string | null, roleName: string): Promise<string[]> {
  try {
    const { data: roles } = await supabaseAdmin
      .from('org_roles').select('id').eq('org_id', orgId).ilike('name', roleName).is('deleted_at', null);
    const roleIds = ((roles as any[]) || []).map((r) => r.id);
    if (!roleIds.length) return [];
    let q = supabaseAdmin.from('users').select('id').eq('org_id', orgId).eq('is_active', true).in('org_role_id', roleIds);
    if (clientId) q = q.or(`client_id.eq.${clientId},client_id.is.null`);
    const { data } = await q;
    return ((data as any[]) || []).map((u) => u.id).sort();
  } catch {
    return [];
  }
}

/** Pull the customer master rows that seed the daily list. */
async function fetchCustomerMaster(
  orgId: string, clientId: string | null, source: DeskConfig['customer_source'],
): Promise<Array<{ customer_type: CustomerType; customer_id: string; customer_name: string | null; customer_phone: string | null }>> {
  const out: Array<{ customer_type: CustomerType; customer_id: string; customer_name: string | null; customer_phone: string | null }> = [];
  if (source === 'accounts' || source === 'both') {
    let q = supabaseAdmin.from('crm_accounts').select('id, name, phone').eq('org_id', orgId).is('deleted_at', null).limit(20000);
    if (clientId) q = q.eq('client_id', clientId);
    const { data } = await q;
    for (const a of (data as any[]) || []) out.push({ customer_type: 'account', customer_id: a.id, customer_name: a.name ?? null, customer_phone: a.phone ?? null });
  }
  if (source === 'leads' || source === 'both') {
    let q = supabaseAdmin.from('crm_leads').select('id, first_name, last_name, company, phone').eq('org_id', orgId).is('deleted_at', null).eq('is_converted', false).limit(20000);
    if (clientId) q = q.eq('client_id', clientId);
    const { data } = await q;
    for (const l of (data as any[]) || []) {
      const nm = (l.company && String(l.company).trim()) || [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || null;
      out.push({ customer_type: 'lead', customer_id: l.id, customer_name: nm, customer_phone: l.phone ?? null });
    }
  }
  return out;
}

/**
 * Build (or top up) the calling list for a given IST day. Idempotent:
 * re-running only inserts customers not already on that day's list — existing
 * rows (and their dispositions) are untouched, so previous data is never lost.
 */
export async function generateDailyCallList(
  orgId: string,
  clientId: string | null,
  opts: { date?: string; createdBy?: string | null } = {},
): Promise<{ date: string; created: number; existing: number; customers: number; operators: number }> {
  if (!clientId) throw new AppError(400, 'calling desk requires a client scope', 'NO_CLIENT');
  const date = opts.date || istTodayISO();
  const cfg = await getDeskConfig(orgId, clientId);
  const [master, operators] = await Promise.all([
    fetchCustomerMaster(orgId, clientId, cfg.customer_source),
    resolveOperators(orgId, clientId, cfg.operator_role_name),
  ]);

  // Which customers already have a task today → skip them (append-only).
  const { data: existingRows } = await supabaseAdmin
    .from(CALL_TASKS).select('customer_type, customer_id')
    .eq('org_id', orgId).eq('client_id', clientId).eq('call_date', date).is('deleted_at', null);
  const existing = new Set(((existingRows as any[]) || []).map((r) => `${r.customer_type}:${r.customer_id}`));

  const toInsert = master.filter((m) => !existing.has(`${m.customer_type}:${m.customer_id}`));
  let created = 0;
  if (toInsert.length) {
    const rows = toInsert.map((m, i) => ({
      org_id: orgId,
      client_id: clientId,
      call_date: date,
      customer_type: m.customer_type,
      customer_id: m.customer_id,
      customer_name: m.customer_name,
      customer_phone: m.customer_phone,
      assigned_operator: cfg.auto_assign && operators.length ? operators[i % operators.length] : null,
      status: 'pending' as CallStatus,
      created_by: opts.createdBy ?? null,
    }));
    // Chunked insert; the unique index makes concurrent generators safe.
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows.slice(i, i + 500);
      const { error, count } = await supabaseAdmin.from(CALL_TASKS).insert(slice, { count: 'exact' });
      if (error && !/duplicate key|unique/i.test(error.message)) throw new AppError(500, error.message, 'DB_ERROR');
      created += count ?? slice.length;
    }
  }
  return { date, created, existing: existing.size, customers: master.length, operators: operators.length };
}

/** List the calling tasks for a day, with optional status / operator / search filters. */
export async function listDailyCallTasks(
  orgId: string, scope: Scope,
  query: { date?: string; status?: string; assigned_operator?: string; q?: string; limit?: number; page?: number; onlyMine?: string | null },
): Promise<{ rows: any[]; total: number; page: number; limit: number; date: string }> {
  const date = query.date || istTodayISO();
  const limit = Math.min(Number(query.limit ?? 100), 500);
  const page = Math.max(Number(query.page ?? 1), 1);
  let q = supabaseAdmin.from(CALL_TASKS).select('*', { count: 'exact' })
    .eq('org_id', orgId).eq('call_date', date).is('deleted_at', null);
  if (scope.id) q = q.eq('client_id', scope.id);
  if (query.status) q = q.eq('status', query.status);
  if (query.assigned_operator) q = q.eq('assigned_operator', query.assigned_operator);
  if (query.onlyMine) q = q.eq('assigned_operator', query.onlyMine);
  if (query.q) q = q.ilike('customer_name', `%${String(query.q).replace(/[%,()]/g, '')}%`);
  q = q.order('status', { ascending: true }).order('customer_name', { ascending: true }).range((page - 1) * limit, page * limit - 1);
  const { data, error, count } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { rows: (data as any[]) ?? [], total: count ?? 0, page, limit, date };
}

/** Status counts + order totals for a day — powers the desk header + daily report. */
export async function deskDaySummary(orgId: string, scope: Scope, date?: string): Promise<any> {
  const day = date || istTodayISO();
  let q = supabaseAdmin.from(CALL_TASKS).select('status, order_value, assigned_operator, called_at')
    .eq('org_id', orgId).eq('call_date', day).is('deleted_at', null).limit(50000);
  if (scope.id) q = q.eq('client_id', scope.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data as any[]) || [];
  const s = { date: day, assigned: rows.length, pending: 0, order_taken: 0, order_pending: 0, no_order: 0, connected: 0, orders_value: 0, called: 0 };
  for (const r of rows) {
    if (r.status === 'pending') s.pending++;
    else { s.called++; if (r.status === 'order_taken') s.order_taken++; else if (r.status === 'order_pending') s.order_pending++; else if (r.status === 'no_order') s.no_order++; }
    if (r.status === 'order_taken' || r.status === 'order_pending') s.connected++;
    if (r.status === 'order_taken') s.orders_value += Number(r.order_value || 0);
  }
  return s;
}

/**
 * Shared order-ledger writer. Used by the desk ("Order Taken") and by MR field
 * visits. Appends a crm_customer_orders row — never mutates history.
 */
export async function recordCustomerOrder(
  orgId: string, clientId: string | null,
  input: {
    customer_type: CustomerType; customer_id: string; customer_name?: string | null;
    order_value: number; source: 'desk' | 'field' | 'manual';
    call_task_id?: string | null; visit_id?: string | null; captured_by?: string | null;
    order_date?: string; notes?: string | null;
  },
): Promise<any> {
  const row = {
    org_id: orgId, client_id: clientId,
    customer_type: input.customer_type, customer_id: input.customer_id, customer_name: input.customer_name ?? null,
    order_date: input.order_date || istTodayISO(),
    order_value: Number(input.order_value) || 0,
    source: input.source,
    call_task_id: input.call_task_id ?? null, visit_id: input.visit_id ?? null,
    captured_by: input.captured_by ?? null, created_by: input.captured_by ?? null,
    notes: input.notes ?? null,
  };
  const { data, error } = await supabaseAdmin.from(ORDERS).insert(row).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

/** Apply one of the 3 dispositions to a call task. */
export async function updateCallTaskStatus(
  orgId: string, scope: Scope, taskId: string,
  input: { status: CallStatus; order_value?: number | null; notes?: string | null },
  userId?: string | null,
): Promise<any> {
  // Load + tenant-check the task.
  let sel = supabaseAdmin.from(CALL_TASKS).select('*').eq('org_id', orgId).eq('id', taskId).is('deleted_at', null);
  if (scope.id) sel = sel.eq('client_id', scope.id);
  const { data: task, error: selErr } = await sel.single();
  if (selErr || !task) throw new AppError(404, 'call task not found', 'NOT_FOUND');
  const t = task as any;

  const patch: Record<string, unknown> = {
    status: input.status,
    notes: input.notes ?? t.notes ?? null,
    called_at: input.status === 'pending' ? null : new Date().toISOString(),
    updated_by: userId ?? null,
    updated_at: new Date().toISOString(),
  };

  let order: any = null;
  if (input.status === 'order_taken') {
    const value = Number(input.order_value) || 0;
    patch.order_value = value;
    // Append an order to the ledger (idempotency: if the task already linked an
    // order, update that order's value instead of creating a duplicate).
    if (t.order_id) {
      const { data: upd } = await supabaseAdmin.from(ORDERS).update({ order_value: value, updated_by: userId ?? null, updated_at: new Date().toISOString() }).eq('id', t.order_id).eq('org_id', orgId).select('*').single();
      order = upd;
    } else {
      order = await recordCustomerOrder(orgId, scope.id, {
        customer_type: t.customer_type, customer_id: t.customer_id, customer_name: t.customer_name,
        order_value: value, source: 'desk', call_task_id: t.id, captured_by: userId ?? null, order_date: t.call_date,
        notes: input.notes ?? null,
      });
      patch.order_id = order?.id ?? null;
    }
    patch.pending_resolved = true;
    // Resolve any still-open order_pending tasks for this customer (they converted).
    try {
      let rq = supabaseAdmin.from(CALL_TASKS).update({ pending_resolved: true, updated_at: new Date().toISOString() })
        .eq('org_id', orgId).eq('customer_type', t.customer_type).eq('customer_id', t.customer_id)
        .eq('status', 'order_pending').eq('pending_resolved', false);
      if (scope.id) rq = rq.eq('client_id', scope.id);
      await rq;
    } catch { /* best-effort */ }
  } else if (input.status === 'order_pending') {
    patch.order_value = null;
    patch.pending_resolved = false;
  } else {
    // no_order / pending
    patch.order_value = null;
  }

  let updQ = supabaseAdmin.from(CALL_TASKS).update(patch).eq('org_id', orgId).eq('id', taskId);
  if (scope.id) updQ = updQ.eq('client_id', scope.id);
  const { data: updated, error: updErr } = await updQ.select('*').single();
  if (updErr) throw new AppError(500, updErr.message, 'DB_ERROR');
  return { task: updated, order };
}

// ───────────────────────────── Reports ─────────────────────────────

function bucketKey(dateStr: string, granularity: 'day' | 'week' | 'month'): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (granularity === 'month') return dateStr.slice(0, 7);
  if (granularity === 'week') {
    // ISO week start (Monday), labelled by that Monday's date.
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

/**
 * Desk calling report over a date range, bucketed day/week/month. Returns per
 * bucket: assigned, connected, orders received, pending, no-order, order value;
 * plus the customer-wise order values across the whole range.
 */
export async function deskReport(
  orgId: string, scope: Scope,
  query: { from?: string; to?: string; granularity?: 'day' | 'week' | 'month' },
): Promise<any> {
  const to = query.to || istTodayISO();
  const from = query.from || new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const granularity = query.granularity || 'day';

  let q = supabaseAdmin.from(CALL_TASKS).select('call_date, status, order_value, customer_type, customer_id, customer_name')
    .eq('org_id', orgId).gte('call_date', from).lte('call_date', to).is('deleted_at', null).limit(100000);
  if (scope.id) q = q.eq('client_id', scope.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data as any[]) || [];

  const buckets = new Map<string, any>();
  const byCustomer = new Map<string, any>();
  for (const r of rows) {
    const key = bucketKey(r.call_date, granularity);
    const b = buckets.get(key) || { bucket: key, assigned: 0, connected: 0, order_taken: 0, order_pending: 0, no_order: 0, pending: 0, orders_value: 0 };
    b.assigned++;
    if (r.status === 'order_taken') { b.order_taken++; b.connected++; b.orders_value += Number(r.order_value || 0); }
    else if (r.status === 'order_pending') { b.order_pending++; b.connected++; }
    else if (r.status === 'no_order') b.no_order++;
    else b.pending++;
    buckets.set(key, b);

    const ck = `${r.customer_type}:${r.customer_id}`;
    const c = byCustomer.get(ck) || { customer_type: r.customer_type, customer_id: r.customer_id, customer_name: r.customer_name, calls: 0, orders: 0, orders_value: 0 };
    c.calls++;
    if (r.status === 'order_taken') { c.orders++; c.orders_value += Number(r.order_value || 0); }
    if (!c.customer_name && r.customer_name) c.customer_name = r.customer_name;
    byCustomer.set(ck, c);
  }
  const series = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  const totals = series.reduce((acc, b) => {
    acc.assigned += b.assigned; acc.connected += b.connected; acc.order_taken += b.order_taken;
    acc.order_pending += b.order_pending; acc.no_order += b.no_order; acc.pending += b.pending; acc.orders_value += b.orders_value;
    return acc;
  }, { assigned: 0, connected: 0, order_taken: 0, order_pending: 0, no_order: 0, pending: 0, orders_value: 0 });
  const customers = [...byCustomer.values()].sort((a, b) => b.orders_value - a.orders_value);
  return { from, to, granularity, series, totals, customers };
}

/** Per-operator desk productivity over a range. */
export async function operatorProductivity(
  orgId: string, scope: Scope, query: { from?: string; to?: string },
): Promise<any> {
  const to = query.to || istTodayISO();
  const from = query.from || new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 86400000).toISOString().slice(0, 10);
  let q = supabaseAdmin.from(CALL_TASKS).select('assigned_operator, status, order_value')
    .eq('org_id', orgId).gte('call_date', from).lte('call_date', to).is('deleted_at', null).limit(100000);
  if (scope.id) q = q.eq('client_id', scope.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data as any[]) || [];

  const byOp = new Map<string, any>();
  for (const r of rows) {
    const op = r.assigned_operator || 'unassigned';
    const o = byOp.get(op) || { operator_id: r.assigned_operator || null, assigned: 0, called: 0, order_taken: 0, order_pending: 0, no_order: 0, orders_value: 0 };
    o.assigned++;
    if (r.status !== 'pending') o.called++;
    if (r.status === 'order_taken') { o.order_taken++; o.orders_value += Number(r.order_value || 0); }
    else if (r.status === 'order_pending') o.order_pending++;
    else if (r.status === 'no_order') o.no_order++;
    byOp.set(op, o);
  }
  const operators = [...byOp.values()];
  // Resolve operator names.
  const ids = operators.map((o) => o.operator_id).filter(Boolean);
  if (ids.length) {
    const { data: users } = await supabaseAdmin.from('users').select('id, name').in('id', ids);
    const nameById = new Map(((users as any[]) || []).map((u) => [u.id, u.name]));
    for (const o of operators) o.operator_name = o.operator_id ? (nameById.get(o.operator_id) || 'Unknown') : 'Unassigned';
  } else {
    for (const o of operators) o.operator_name = 'Unassigned';
  }
  for (const o of operators) {
    o.connect_rate = o.assigned ? Math.round(((o.called) / o.assigned) * 100) : 0;
    o.order_rate = o.called ? Math.round((o.order_taken / o.called) * 100) : 0;
  }
  operators.sort((a, b) => b.orders_value - a.orders_value);
  return { from, to, operators };
}

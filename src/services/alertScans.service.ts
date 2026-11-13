/**
 * Scheduled alert scans — Field Force + Supply Chain.
 *
 * These are the "nobody did an action, so nobody would ever INSERT a
 * notification inline" cases. A periodic scan finds the condition, inserts a
 * `notifications` row (sent_at = NULL) and leaves delivery to the existing
 * dispatch-pushes cron (FCM/APNs + in-app bell). Everything here is:
 *
 *  - Best-effort: a failure is logged, never thrown — a scan can never take the
 *    server down or fail a sibling scan.
 *  - Self-gating: a tenant with no route plans / no distributor stock / no
 *    batches simply produces zero rows, so enabling the scans changes nothing
 *    for tenants that don't use the feature.
 *  - Idempotent: each scan de-dupes against notifications it already created
 *    (there is no per-row "alerted_at" column to add — we reuse the
 *    notifications table itself as the ledger, keyed on data.kind + the entity
 *    id), so re-running never double-notifies.
 *
 * All rows use type:'general' + data.kind (see notify.ts for why) so an insert
 * never silently fails on a tenant whose notification_type enum lacks a value.
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { notify, notifyUsers, resolveManagers } from './notify';
import { buildReplenishment } from './distribution/replenishment.service';
import { istTodayISO } from '../lib/clientAccess';

const DAY_MS = 86_400_000;

/**
 * Pull the set of entity-ids we've ALREADY sent a `kind` notification for within
 * `sinceHours`, so a scan skips them. One query, keyed on data.kind, returns the
 * data blobs; the caller reads whichever id field it dedupes on.
 */
async function recentlyNotifiedIds(
  kind: string,
  idField: string,
  sinceHours: number,
): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    const sinceIso = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
    const { data } = await supabaseAdmin
      .from('notifications')
      .select('data')
      .eq('data->>kind', kind)
      .gte('created_at', sinceIso)
      .limit(20000);
    for (const r of (data as any[]) || []) {
      const v = r?.data?.[idField];
      if (v != null) seen.add(String(v));
    }
  } catch (e: any) {
    logger.warn(`[alert-scans] dedup lookup failed (kind=${kind}): ${e?.message || e}`);
  }
  return seen;
}

// ───────────────────────── Field Force: missed visits ──────────────────────
/**
 * Missed-visit scan. For every route plan dated in the recent past whose outlets
 * were NOT all checked into, tell the rep ("you missed N planned visits") and
 * their supervisor/managers. De-duped per plan (a plan is one rep's beat for one
 * day), so a plan alerts exactly once. Run once after end-of-day (see server.ts).
 *
 * `lookbackDays` bounds how far back a missed plan can still alert (default 1 —
 * yesterday's beats). Runs against the AMBIENT project; wrap in runWithProject
 * for a specific tenant.
 */
export async function runMissedVisitScan(
  opts: { lookbackDays?: number } = {},
): Promise<{ plans: number; alerted: number }> {
  const lookbackDays = Math.min(14, Math.max(1, opts.lookbackDays ?? 1));
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const sinceStr = new Date(today.getTime() - lookbackDays * DAY_MS).toISOString().slice(0, 10);

  // Every outlet on a past-dated plan in the window, with its plan + store.
  const { data, error } = await supabaseAdmin
    .from('route_plan_outlets')
    .select('id, checkin_at, route_plan_id, route_plans!inner(id, user_id, org_id, client_id, plan_date, territory_label)')
    .gte('route_plans.plan_date', sinceStr)
    .lt('route_plans.plan_date', todayStr)
    .limit(20000);
  if (error) {
    logger.warn(`[missed-visit] scan query failed: ${error.message}`);
    return { plans: 0, alerted: 0 };
  }
  const rows = (data as any[]) || [];
  if (!rows.length) return { plans: 0, alerted: 0 };

  // Aggregate per plan: total outlets vs. missed (no check-in).
  type Agg = { plan: any; total: number; missed: number };
  const byPlan = new Map<string, Agg>();
  for (const o of rows) {
    const rp = Array.isArray(o.route_plans) ? o.route_plans[0] : o.route_plans;
    if (!rp?.id) continue;
    const a = byPlan.get(rp.id) || { plan: rp, total: 0, missed: 0 };
    a.total += 1;
    if (!o.checkin_at) a.missed += 1;
    byPlan.set(rp.id, a);
  }

  const alreadyAlerted = await recentlyNotifiedIds('missed_visits', 'plan_id', (lookbackDays + 2) * 24);
  let alerted = 0;

  for (const [planId, a] of byPlan.entries()) {
    if (a.missed <= 0) continue;                 // fully covered → nothing to say
    if (alreadyAlerted.has(planId)) continue;    // already alerted for this plan

    const rp = a.plan;
    const where = rp.territory_label ? ` on ${rp.territory_label}` : '';
    const nOf = `${a.missed} of ${a.total}`;

    // 1) The rep — a personal nudge.
    await notify({
      orgId: rp.org_id,
      userId: rp.user_id,
      kind: 'missed_visits',
      title: 'Missed planned visits',
      body: `You didn't check in to ${nOf} planned outlet${a.total === 1 ? '' : 's'}${where} on ${rp.plan_date}.`,
      data: { plan_id: planId, plan_date: String(rp.plan_date), missed: String(a.missed), total: String(a.total), audience: 'rep' },
    });

    // 2) The supervisor / managers — team visibility.
    let repName = 'A rep';
    try {
      const { data: rep } = await supabaseAdmin.from('users').select('name').eq('id', rp.user_id).maybeSingle();
      repName = (rep as any)?.name || repName;
    } catch { /* best-effort */ }
    const managers = await resolveManagers(rp.org_id, { clientId: rp.client_id ?? null });
    await notifyUsers(managers, {
      orgId: rp.org_id,
      kind: 'missed_visits',
      title: 'Rep missed planned visits',
      body: `${repName} missed ${nOf} planned outlet${a.total === 1 ? '' : 's'}${where} on ${rp.plan_date}.`,
      data: { plan_id: planId, plan_date: String(rp.plan_date), rep_id: rp.user_id, missed: String(a.missed), total: String(a.total), audience: 'manager' },
    }, { exclude: rp.user_id });

    alerted += 1;
  }

  logger.info(`[missed-visit] scan: ${byPlan.size} plan(s), ${alerted} alerted`);
  return { plans: byPlan.size, alerted };
}

// ─────────────────────── Supply Chain: batch near-expiry ────────────────────
/**
 * Stock-expiry scan. Finds open distributor batches (qty_remaining > 0) whose
 * expiry_date falls within the alert window and tells the org's managers so they
 * can push FEFO rotation / clearance before the stock is dead. The window is the
 * SKU's expiry_alert_days when set, else the default (30). De-duped per batch on
 * a weekly cadence, so a batch nudges at most once every `dedupHours` as it ages
 * toward expiry. Self-gating: no batches → no-op.
 */
export async function runStockExpiryScan(
  opts: { defaultAlertDays?: number; dedupHours?: number } = {},
): Promise<{ batches: number; alerted: number }> {
  const defaultAlertDays = Math.min(180, Math.max(1, opts.defaultAlertDays ?? 30));
  const dedupHours = Math.max(1, opts.dedupHours ?? 24 * 7);

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  // Widest horizon we ever alert on, so one query covers every SKU threshold;
  // we filter per-SKU below using expiry_alert_days.
  const horizonStr = new Date(today.getTime() + 180 * DAY_MS).toISOString().slice(0, 10);

  // NOTE: distribution_stock_batches has NO foreign key to skus, so a PostgREST
  // `skus(...)` embed would error and silently no-op the whole scan. Fetch the
  // batches flat, then resolve SKU names/thresholds in a second query (the same
  // pattern replenishment.service uses) so this never depends on a FK.
  const { data, error } = await supabaseAdmin
    .from('distribution_stock_batches')
    .select('id, org_id, client_id, distributor_id, sku_id, batch_no, expiry_date, qty_remaining')
    .gt('qty_remaining', 0)
    .not('expiry_date', 'is', null)
    .gte('expiry_date', todayStr)      // not already expired
    .lte('expiry_date', horizonStr)
    .limit(20000);
  if (error) {
    logger.warn(`[stock-expiry] scan query failed: ${error.message}`);
    return { batches: 0, alerted: 0 };
  }
  const rows = (data as any[]) || [];
  if (!rows.length) return { batches: 0, alerted: 0 };

  // Resolve SKU name / code / alert-window in one batched query.
  const skuIds = Array.from(new Set(rows.map((b) => b.sku_id).filter(Boolean)));
  const skuById = new Map<string, { name?: string; sku_code?: string; expiry_alert_days?: number }>();
  if (skuIds.length) {
    const { data: skus } = await supabaseAdmin
      .from('skus')
      .select('id, name, sku_code, expiry_alert_days')
      .in('id', skuIds);
    for (const s of (skus as any[]) || []) skuById.set(s.id, s);
  }

  const alreadyAlerted = await recentlyNotifiedIds('stock_expiry', 'batch_id', dedupHours);
  // Cache manager lists + distributor names per org to avoid N round-trips.
  const managersByOrg = new Map<string, string[]>();
  const distNameCache = new Map<string, string>();
  let alerted = 0;

  for (const b of rows) {
    if (alreadyAlerted.has(String(b.id))) continue;
    const sku = skuById.get(b.sku_id);
    const alertDays = Number(sku?.expiry_alert_days) > 0 ? Number(sku!.expiry_alert_days) : defaultAlertDays;
    const daysLeft = Math.ceil((new Date(b.expiry_date).getTime() - today.getTime()) / DAY_MS);
    if (daysLeft > alertDays) continue;         // still outside this SKU's window

    if (!managersByOrg.has(b.org_id)) {
      managersByOrg.set(b.org_id, await resolveManagers(b.org_id, { clientId: b.client_id ?? null }));
    }
    const managers = managersByOrg.get(b.org_id) || [];
    if (!managers.length) continue;

    let distName = distNameCache.get(b.distributor_id);
    if (distName === undefined) {
      try {
        const { data: d } = await supabaseAdmin.from('distributors').select('name').eq('id', b.distributor_id).maybeSingle();
        distName = (d as any)?.name || 'a distributor';
      } catch { distName = 'a distributor'; }
      distNameCache.set(b.distributor_id, distName);
    }

    const skuLabel = sku?.name || sku?.sku_code || 'a SKU';
    const batchLabel = b.batch_no ? ` (batch ${b.batch_no})` : '';
    const when = daysLeft <= 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;

    await notifyUsers(managers, {
      orgId: b.org_id,
      kind: 'stock_expiry',
      title: 'Stock nearing expiry',
      body: `${Number(b.qty_remaining)} unit(s) of ${skuLabel}${batchLabel} at ${distName} expire ${when} (${b.expiry_date}).`,
      data: {
        batch_id: String(b.id),
        sku_id: String(b.sku_id),
        distributor_id: String(b.distributor_id),
        expiry_date: String(b.expiry_date),
        days_left: String(daysLeft),
      },
    });
    alerted += 1;
  }

  logger.info(`[stock-expiry] scan: ${rows.length} candidate batch(es), ${alerted} alerted`);
  return { batches: rows.length, alerted };
}

// ─────────────────────── Supply Chain: low stock / reorder ──────────────────
/**
 * Low-stock / replenishment scan. Reuses the SAME velocity engine the
 * replenishment agent uses (buildReplenishment) so the "needs reorder" numbers
 * never diverge from the draft-order flow, and tells each org's managers which
 * SKUs are running low against projected demand. One summary notification per
 * org per run (deduped daily), so it's a digest, not a flood. Self-gating: an
 * org with no sell-out history produces no suggestions → no-op.
 */
export async function runLowStockScan(
  opts: { dedupHours?: number; maxOrgs?: number } = {},
): Promise<{ orgs: number; alerted: number }> {
  const dedupHours = Math.max(1, opts.dedupHours ?? 20);
  const maxOrgs = Math.min(1000, Math.max(1, opts.maxOrgs ?? 500));

  // Orgs that actually run distribution (have distributors). No distributors →
  // nothing to scan, so this is a no-op for pure-CRM tenants.
  const { data: distRows, error } = await supabaseAdmin
    .from('distributors')
    .select('org_id')
    .limit(20000);
  if (error) {
    logger.warn(`[low-stock] distributors query failed: ${error.message}`);
    return { orgs: 0, alerted: 0 };
  }
  const orgIds = Array.from(new Set(((distRows as any[]) || []).map((r) => r.org_id).filter(Boolean))).slice(0, maxOrgs);
  if (!orgIds.length) return { orgs: 0, alerted: 0 };

  const alreadyAlerted = await recentlyNotifiedIds('low_stock', 'org_id', dedupHours);
  let alerted = 0;

  for (const org_id of orgIds) {
    if (alreadyAlerted.has(String(org_id))) continue;
    try {
      const suggestions = await buildReplenishment(org_id);
      if (!suggestions.length) continue;

      // Flatten to the SKUs needing reorder; surface the out-of-stock ones first.
      const items = suggestions.flatMap((s) => s.items.map((i) => ({ ...i, distributor: s.distributor_name })));
      const outOfStock = items.filter((i) => i.on_hand <= 0);
      const distinctSkus = new Set(items.map((i) => i.sku_id)).size;
      if (!distinctSkus) continue;

      const lead = (outOfStock.length ? outOfStock : items)
        .slice(0, 3)
        .map((i) => i.name)
        .join(', ');
      const oos = outOfStock.length ? `${outOfStock.length} out of stock. ` : '';
      const body = `${oos}${distinctSkus} SKU${distinctSkus === 1 ? '' : 's'} running low across ${suggestions.length} distributor${suggestions.length === 1 ? '' : 's'} — e.g. ${lead}. Review replenishment.`;

      const managers = await resolveManagers(org_id);
      if (!managers.length) continue;

      await notifyUsers(managers, {
        orgId: org_id,
        kind: 'low_stock',
        title: 'Low stock — reorder needed',
        body,
        data: { org_id: String(org_id), low_skus: String(distinctSkus), out_of_stock: String(outOfStock.length) },
      });
      alerted += 1;
    } catch (e: any) {
      logger.warn(`[low-stock] org ${org_id} failed: ${e?.message || e}`);
    }
  }

  logger.info(`[low-stock] scan: ${orgIds.length} org(s), ${alerted} alerted`);
  return { orgs: orgIds.length, alerted };
}

// ══════════════════════ Pharma desk + customer-order alerts ═════════════════
// These four scans back the pharma requirement's alert rules. They read the
// crm_daily_call_tasks + crm_customer_orders tables and are self-gating: a
// tenant that doesn't use the calling desk / order ledger produces zero rows.
// Grouped by (org_id, client_id); notifications are client-scoped.

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); const a = m.get(k) || []; a.push(r); m.set(k, a); }
  return m;
}

/**
 * Uncontacted-customer scan. For TODAY's (IST) calling list, finds customers
 * still 'pending' (never called) and nudges the client's managers (+ each
 * assigned operator). Run late in the IST working day. De-duped per
 * (client, date) so it alerts once per day.
 */
export async function runUncontactedScan(): Promise<{ clients: number; alerted: number }> {
  const today = istTodayISO();
  const { data, error } = await supabaseAdmin
    .from('crm_daily_call_tasks')
    .select('org_id, client_id, assigned_operator, status')
    .eq('call_date', today).is('deleted_at', null).limit(100000);
  if (error) { logger.warn(`[uncontacted] query failed: ${error.message}`); return { clients: 0, alerted: 0 }; }
  const rows = (data as any[]) || [];
  if (!rows.length) return { clients: 0, alerted: 0 };

  const already = await recentlyNotifiedIds('uncontacted_customers', 'scope', 20);
  const byClient = groupBy(rows, (r) => `${r.org_id}|${r.client_id || ''}`);
  let alerted = 0;
  for (const [key, group] of byClient) {
    const pending = group.filter((r) => r.status === 'pending');
    if (!pending.length) continue;
    if (already.has(key)) continue;
    const [org_id, client_id] = key.split('|');
    const managers = await resolveManagers(org_id, { clientId: client_id || null });
    if (managers.length) {
      await notifyUsers(managers, {
        orgId: org_id, kind: 'uncontacted_customers',
        title: 'Customers not yet called',
        body: `${pending.length} customer${pending.length === 1 ? '' : 's'} on today's calling list ${pending.length === 1 ? 'has' : 'have'} not been contacted yet.`,
        data: { scope: key, date: today, pending: String(pending.length), audience: 'manager' },
      });
    }
    // Per-operator nudge.
    const byOp = groupBy(pending.filter((r) => r.assigned_operator), (r) => r.assigned_operator);
    for (const [op, list] of byOp) {
      await notify({
        orgId: org_id, userId: op, kind: 'uncontacted_customers',
        title: 'Pending calls on your list',
        body: `You have ${list.length} customer${list.length === 1 ? '' : 's'} still to call today.`,
        data: { scope: `${key}|${op}`, date: today, pending: String(list.length), audience: 'operator' },
      });
    }
    alerted++;
  }
  logger.info(`[uncontacted] scan: ${byClient.size} client(s), ${alerted} alerted`);
  return { clients: byClient.size, alerted };
}

/**
 * Order-pending-not-converted scan. Finds call tasks marked 'order_pending'
 * on a prior day that never converted (pending_resolved = false), and tells
 * the operator + managers. De-duped per task.
 */
export async function runPendingOrderScan(opts: { graceDays?: number } = {}): Promise<{ tasks: number; alerted: number }> {
  const graceDays = Math.max(1, opts.graceDays ?? 1);
  const cutoff = new Date(Date.now() - graceDays * DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from('crm_daily_call_tasks')
    .select('id, org_id, client_id, assigned_operator, customer_name, call_date')
    .eq('status', 'order_pending').eq('pending_resolved', false)
    .lte('call_date', cutoff).is('deleted_at', null).limit(50000);
  if (error) { logger.warn(`[pending-order] query failed: ${error.message}`); return { tasks: 0, alerted: 0 }; }
  const rows = (data as any[]) || [];
  if (!rows.length) return { tasks: 0, alerted: 0 };

  const already = await recentlyNotifiedIds('pending_order_unconverted', 'task_id', 48);
  const managerCache = new Map<string, string[]>();
  let alerted = 0;
  for (const t of rows) {
    if (already.has(String(t.id))) continue;
    const mk = `${t.org_id}|${t.client_id || ''}`;
    if (!managerCache.has(mk)) managerCache.set(mk, await resolveManagers(t.org_id, { clientId: t.client_id || null }));
    const recipients = [...new Set([t.assigned_operator, ...(managerCache.get(mk) || [])].filter(Boolean))];
    if (!recipients.length) continue;
    await notifyUsers(recipients, {
      orgId: t.org_id, kind: 'pending_order_unconverted',
      title: 'Pending order not converted',
      body: `${t.customer_name || 'A customer'} promised an order on ${t.call_date} but it hasn't been booked yet.`,
      data: { task_id: String(t.id), customer_name: t.customer_name || '', call_date: String(t.call_date) },
    });
    alerted++;
  }
  logger.info(`[pending-order] scan: ${rows.length} task(s), ${alerted} alerted`);
  return { tasks: rows.length, alerted };
}

/** Per-customer last-order + value aggregation from the order ledger. */
async function aggregateCustomerOrders(): Promise<Map<string, { org_id: string; client_id: string | null; customer_type: string; customer_id: string; customer_name: string | null; last_order: string; value_last_30: number; value_prev_30: number }>> {
  const today = istTodayISO();
  const last30 = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const prev30 = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
  const { data } = await supabaseAdmin
    .from('crm_customer_orders')
    .select('org_id, client_id, customer_type, customer_id, customer_name, order_date, order_value')
    .is('deleted_at', null).limit(200000);
  const agg = new Map<string, any>();
  for (const o of (data as any[]) || []) {
    const k = `${o.org_id}|${o.client_id || ''}|${o.customer_type}|${o.customer_id}`;
    const cur = agg.get(k) || { org_id: o.org_id, client_id: o.client_id || null, customer_type: o.customer_type, customer_id: o.customer_id, customer_name: o.customer_name, last_order: o.order_date, value_last_30: 0, value_prev_30: 0 };
    if (o.order_date > cur.last_order) { cur.last_order = o.order_date; cur.customer_name = o.customer_name || cur.customer_name; }
    if (o.order_date > last30) cur.value_last_30 += Number(o.order_value || 0);
    else if (o.order_date > prev30) cur.value_prev_30 += Number(o.order_value || 0);
    agg.set(k, cur);
  }
  void today;
  return agg;
}

/**
 * Dormant-customer scan. Customers whose most recent order is older than
 * `dormantDays` (default 30) get surfaced to the client's managers as a digest.
 * De-duped per (client) daily.
 */
export async function runDormantCustomerScan(opts: { dormantDays?: number } = {}): Promise<{ clients: number; alerted: number }> {
  const dormantDays = Math.max(7, opts.dormantDays ?? 30);
  const today = istTodayISO();
  const cutoff = new Date(Date.now() - dormantDays * DAY_MS).toISOString().slice(0, 10);
  const agg = await aggregateCustomerOrders();
  const dormant = [...agg.values()].filter((c) => c.last_order <= cutoff);
  if (!dormant.length) return { clients: 0, alerted: 0 };

  const already = await recentlyNotifiedIds('customer_dormant', 'scope', 20);
  const byClient = groupBy(dormant, (c) => `${c.org_id}|${c.client_id || ''}`);
  let alerted = 0;
  for (const [key, list] of byClient) {
    if (already.has(key)) continue;
    const [org_id, client_id] = key.split('|');
    const managers = await resolveManagers(org_id, { clientId: client_id || null });
    if (!managers.length) continue;
    const lead = list.slice(0, 3).map((c) => c.customer_name || 'a customer').join(', ');
    await notifyUsers(managers, {
      orgId: org_id, kind: 'customer_dormant',
      title: 'Customers stopped ordering',
      body: `${list.length} customer${list.length === 1 ? '' : 's'} haven't ordered in ${dormantDays}+ days — e.g. ${lead}.`,
      data: { scope: key, date: today, count: String(list.length), dormant_days: String(dormantDays) },
    });
    alerted++;
  }
  logger.info(`[dormant] scan: ${byClient.size} client(s), ${alerted} alerted`);
  return { clients: byClient.size, alerted };
}

/**
 * Declining-sales scan. Customers whose last-30-day order value fell below 70%
 * of the prior 30 days (and who actually ordered before) get flagged to the
 * client's managers. De-duped per (client) daily.
 */
export async function runDecliningCustomerScan(): Promise<{ clients: number; alerted: number }> {
  const today = istTodayISO();
  const agg = await aggregateCustomerOrders();
  const declining = [...agg.values()].filter((c) => c.value_prev_30 > 0 && c.value_last_30 < c.value_prev_30 * 0.7);
  if (!declining.length) return { clients: 0, alerted: 0 };

  const already = await recentlyNotifiedIds('customer_declining', 'scope', 20);
  const byClient = groupBy(declining, (c) => `${c.org_id}|${c.client_id || ''}`);
  let alerted = 0;
  for (const [key, list] of byClient) {
    if (already.has(key)) continue;
    const [org_id, client_id] = key.split('|');
    const managers = await resolveManagers(org_id, { clientId: client_id || null });
    if (!managers.length) continue;
    const lead = list.slice(0, 3).map((c) => c.customer_name || 'a customer').join(', ');
    await notifyUsers(managers, {
      orgId: org_id, kind: 'customer_declining',
      title: 'Customer orders declining',
      body: `${list.length} customer${list.length === 1 ? '' : 's'} ordering well below their usual — e.g. ${lead}. Worth a call.`,
      data: { scope: key, date: today, count: String(list.length) },
    });
    alerted++;
  }
  logger.info(`[declining] scan: ${byClient.size} client(s), ${alerted} alerted`);
  return { clients: byClient.size, alerted };
}

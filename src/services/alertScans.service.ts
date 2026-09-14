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
    .select('id, checkin_at, route_plan_id, stores(name), route_plans!inner(id, user_id, org_id, client_id, plan_date, territory_label)')
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

  const { data, error } = await supabaseAdmin
    .from('distribution_stock_batches')
    .select('id, org_id, client_id, distributor_id, sku_id, batch_no, expiry_date, qty_remaining, skus(name, sku_code, expiry_alert_days)')
    .gt('qty_remaining', 0)
    .not('expiry_date', 'is', null)
    .gte('expiry_date', todayStr)      // not already expired (handled as its own message below)
    .lte('expiry_date', horizonStr)
    .limit(20000);
  if (error) {
    logger.warn(`[stock-expiry] scan query failed: ${error.message}`);
    return { batches: 0, alerted: 0 };
  }
  const rows = (data as any[]) || [];
  if (!rows.length) return { batches: 0, alerted: 0 };

  const alreadyAlerted = await recentlyNotifiedIds('stock_expiry', 'batch_id', dedupHours);
  // Cache manager lists + distributor names per org to avoid N round-trips.
  const managersByOrg = new Map<string, string[]>();
  const distNameCache = new Map<string, string>();
  let alerted = 0;

  for (const b of rows) {
    if (alreadyAlerted.has(String(b.id))) continue;
    const sku = Array.isArray(b.skus) ? b.skus[0] : b.skus;
    const alertDays = Number(sku?.expiry_alert_days) > 0 ? Number(sku.expiry_alert_days) : defaultAlertDays;
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

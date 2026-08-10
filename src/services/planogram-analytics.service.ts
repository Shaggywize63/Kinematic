/**
 * planogram-analytics.service.ts
 *
 * Aggregations and predictive signals over compliance history.
 * The dashboard pulls from these endpoints to power the manager view:
 *   • org / region / store rollups
 *   • per-SKU visibility trend
 *   • chronic-gap detection
 *   • naive risk scoring for "stores likely to fail next week"
 */

import { supabaseAdmin } from '../lib/supabase';

export interface RollupRow {
  bucket: string;            // e.g. zone or store id (or "org")
  bucket_label: string;
  captures: number;
  avg_score: number;
  avg_presence: number;
  avg_facing: number;
  avg_position: number;
  competitor_share: number;
}

// ── Redesigned module: Captures list + Overview contracts ──────────────────
// These mirror the pinned dashboard contract (kinematic-dashboard
// src/types/planogram.ts: CaptureListItem / CapturesListResponse /
// PlanogramOverview). base path: /api/v1/planograms, org-scoped.

/** One row of GET /captures (and the Review queue = same with needs_review). */
export interface CaptureListItem {
  id: string;
  store_id: string | null;
  store_name: string | null;
  city: string | null;
  category: string | null;
  captured_at: string;
  fe_name: string | null;
  score: number | null;
  presence_score: number | null;
  shelf_share_own: number | null;
  needs_review: boolean;
  recovered_count: number;
  competitor_present: boolean;
}

export interface CapturesListResult {
  total: number;
  captures: CaptureListItem[];
}

export interface CaptureListFilters {
  city?: string;
  storeId?: string;
  needsReview?: boolean;
  minScore?: number;
  maxScore?: number;
  limit?: number;
  offset?: number;
}

export interface PlanogramOverviewResult {
  avg_compliance: number;
  own_shelf_share: number;
  captures_count: number;
  stores_count: number;
  flagged_count: number;
  trend: Array<{ date: string; avg_score: number }>;
  needs_attention: Array<{ capture_id: string; store_name: string | null; score: number | null; reason: string }>;
  recent: Array<{
    capture_id: string;
    store_name: string | null;
    category: string | null;
    captured_at: string;
    score: number | null;
    recovered_count: number;
    needs_review: boolean;
    competitor_present: boolean;
  }>;
}

/**
 * Cross-store trend analytics for the redesigned module's Insights view.
 * Every series is derived from the same compliance-history window so the page
 * reads as one coherent picture. Degrades gracefully on sparse data — a series
 * is simply empty when the underlying v2 fields aren't populated yet.
 */
export interface PlanogramInsightsResult {
  period_days: number;
  captures_count: number;                 // scored captures in the window
  stores_count: number;
  /** Org-wide daily average compliance score. */
  compliance_trend: Array<{ date: string; avg_score: number; captures: number }>;
  /** Window-average own-vs-competitor shelf share per category. */
  category_share: Array<{
    category: string;
    own_share: number;
    competitor_share: number;
    facings: number;
    captures: number;
    avg_own_price: number | null;
    avg_competitor_price: number | null;
  }>;
  /** Own-vs-competitor average shelf price, per day (price movement). */
  price_movement: Array<{
    date: string;
    own_avg_price: number | null;
    competitor_avg_price: number | null;
    own_n: number;
    competitor_n: number;
  }>;
  /** Per-store compliance rollup, ranked best→worst. */
  store_compliance: Array<{
    store_id: string;
    store_name: string | null;
    region: string | null;
    captures: number;
    avg_score: number;
    own_shelf_share: number | null;
    competitor_share: number | null;
  }>;
  /** Per-region (city) compliance rollup, ranked best→worst. */
  region_compliance: Array<{
    region: string;
    stores: number;
    captures: number;
    avg_score: number;
    own_shelf_share: number | null;
  }>;
  /** Promotion presence — how often shelves carry live offers, and which. */
  promo: {
    captures_total: number;
    captures_with_promo: number;
    pct: number;
    trend: Array<{ date: string; total: number; with_promo: number; pct: number }>;
    top_offers: Array<{ text: string; offer_type: string; count: number }>;
  };
}

/**
 * Internal enrichment row: the public CaptureListItem plus the extra signals the
 * Overview "needs attention" reason string is derived from. The extra fields are
 * stripped before a capture is returned to a caller (see toCaptureListItem).
 */
interface EnrichedCapture extends CaptureListItem {
  competitor_share: number | null;
  missing_count: number;
  blur_score: number | null;
  glare_score: number | null;
  angle_score: number | null;
}

export class PlanogramAnalyticsService {
  /** Org-wide compliance trend over the last N days. */
  static async orgTrend(orgId: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('planogram_compliance')
      .select('created_at, score')
      .eq('org_id', orgId)
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const buckets = new Map<string, { sum: number; count: number }>();
    for (const r of data || []) {
      const day = (r.created_at as string).slice(0, 10);
      const b = buckets.get(day) || { sum: 0, count: 0 };
      b.sum += r.score;
      b.count += 1;
      buckets.set(day, b);
    }
    return Array.from(buckets.entries()).map(([day, b]) => ({
      day,
      avg_score: round1(b.sum / b.count),
      captures: b.count,
    }));
  }

  /** Ranking of stores by avg compliance over last N days. */
  static async storeRanking(orgId: string, days = 7, limit = 50) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('planogram_compliance')
      .select('store_id, score, presence_score, facing_score, position_score, competitor_share')
      .eq('org_id', orgId)
      .gte('created_at', since);
    if (error) throw error;

    const map = new Map<string, RollupRow>();
    for (const r of data || []) {
      const key = (r.store_id as string) || 'unassigned';
      let row = map.get(key);
      if (!row) {
        row = {
          bucket: key,
          bucket_label: key,
          captures: 0,
          avg_score: 0,
          avg_presence: 0,
          avg_facing: 0,
          avg_position: 0,
          competitor_share: 0,
        };
        map.set(key, row);
      }
      row.captures += 1;
      row.avg_score += r.score;
      row.avg_presence += r.presence_score;
      row.avg_facing += r.facing_score;
      row.avg_position += r.position_score;
      row.competitor_share += r.competitor_share;
    }

    const rows = Array.from(map.values()).map((row) => ({
      ...row,
      avg_score: round1(row.avg_score / row.captures),
      avg_presence: round1(row.avg_presence / row.captures),
      avg_facing: round1(row.avg_facing / row.captures),
      avg_position: round1(row.avg_position / row.captures),
      competitor_share: round1(row.competitor_share / row.captures),
    }));

    rows.sort((a, b) => b.avg_score - a.avg_score);
    return rows.slice(0, limit);
  }

  /** Stores with chronic compliance gaps (<70 score on >= 3 of last 5 captures). */
  static async chronicGaps(orgId: string, threshold = 70, lookback = 5) {
    const { data, error } = await supabaseAdmin
      .from('planogram_compliance')
      .select('store_id, score, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw error;

    const byStore = new Map<string, number[]>();
    for (const r of data || []) {
      if (!r.store_id) continue;
      const arr = byStore.get(r.store_id) || [];
      if (arr.length < lookback) arr.push(r.score);
      byStore.set(r.store_id, arr);
    }

    const out: Array<{ store_id: string; failing: number; avg_score: number }> = [];
    for (const [store_id, scores] of byStore) {
      const failing = scores.filter((s) => s < threshold).length;
      if (failing >= Math.ceil(lookback * 0.6)) {
        out.push({
          store_id,
          failing,
          avg_score: round1(scores.reduce((a, b) => a + b, 0) / scores.length),
        });
      }
    }
    out.sort((a, b) => a.avg_score - b.avg_score);
    return out;
  }

  /** Per-SKU visibility (avg facings present across captures). */
  static async skuVisibility(orgId: string, days = 14, limit = 100) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('planogram_recognition')
      .select('detected_skus, processed_at, capture_id')
      .eq('org_id', orgId)
      .gte('processed_at', since)
      .limit(2000);
    if (error) throw error;

    const agg = new Map<string, { name: string; facings: number; appearances: number }>();
    for (const r of data || []) {
      for (const d of (r.detected_skus as any[]) || []) {
        if (!d.sku_id || d.is_competitor) continue;
        const a = agg.get(d.sku_id) || { name: d.sku_name, facings: 0, appearances: 0 };
        a.facings += d.facings || 0;
        a.appearances += 1;
        agg.set(d.sku_id, a);
      }
    }
    const rows = Array.from(agg.entries()).map(([sku_id, a]) => ({
      sku_id,
      sku_name: a.name,
      avg_facings: round1(a.facings / a.appearances),
      appearances: a.appearances,
    }));
    rows.sort((a, b) => b.appearances - a.appearances);
    return rows.slice(0, limit);
  }

  /**
   * Lightweight risk forecast: stores whose compliance trend is dropping.
   * Slope of last `window` captures < 0 AND latest < 75 → at risk.
   */
  static async riskForecast(orgId: string, window = 5) {
    const { data, error } = await supabaseAdmin
      .from('planogram_compliance')
      .select('store_id, score, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(3000);
    if (error) throw error;

    const byStore = new Map<string, Array<{ t: number; s: number }>>();
    for (const r of data || []) {
      if (!r.store_id) continue;
      const list = byStore.get(r.store_id) || [];
      if (list.length < window) {
        list.push({ t: new Date(r.created_at as string).getTime(), s: r.score });
      }
      byStore.set(r.store_id, list);
    }

    const out: Array<{ store_id: string; latest: number; slope: number; risk: number }> = [];
    for (const [store_id, pts] of byStore) {
      if (pts.length < 3) continue;
      const slope = linearSlope(pts.map((p) => ({ x: p.t, y: p.s })));
      const latest = pts[0].s;
      // Risk: low latest + negative slope → high risk (0..100)
      const risk = clamp(0, 100, (100 - latest) * 0.7 + Math.max(0, -slope) * 30);
      if (risk >= 40) {
        out.push({ store_id, latest: round1(latest), slope: round1(slope), risk: round1(risk) });
      }
    }
    out.sort((a, b) => b.risk - a.risk);
    return out;
  }

  /**
   * Cross-store trend analytics for the Insights view. One pass over the
   * compliance-history window (default 90 days) yields: the org compliance
   * trend, per-category own-vs-competitor shelf share, own-vs-competitor price
   * movement, store + region compliance rollups, and promotion presence. All
   * derived from the same window so the page is internally consistent; each
   * series degrades to empty when its v2 fields aren't populated yet.
   */
  static async insights(orgId: string, opts: { periodDays?: number } = {}): Promise<PlanogramInsightsResult> {
    const periodDays = Math.min(365, Math.max(1, opts.periodDays ?? 90));
    const sinceISO = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('planogram_compliance')
      .select('store_id, score, shelf_share_own, competitor_share, category_breakdown, pricing, promotions, created_at')
      .eq('org_id', orgId)
      .gte('created_at', sinceISO)
      .order('created_at', { ascending: true })
      .limit(5000);
    if (error) throw error;
    const rows = (data || []) as Array<{
      store_id: string | null;
      score: number | null;
      shelf_share_own: number | null;
      competitor_share: number | null;
      category_breakdown: unknown;
      pricing: unknown;
      promotions: unknown;
      created_at: string;
    }>;

    // Resolve store name + city (region) in a batch (store → city_id → cities.name).
    const storeIds = [...new Set(rows.map((r) => r.store_id).filter(Boolean) as string[])];
    const storeById = new Map<string, { name: string | null; city_id: string | null }>();
    if (storeIds.length) {
      const { data: sd } = await supabaseAdmin.from('stores').select('id, name, city_id').in('id', storeIds);
      for (const s of (sd || []) as any[]) storeById.set(s.id as string, { name: (s.name as string) ?? null, city_id: (s.city_id as string) ?? null });
    }
    const cityIds = [...new Set([...storeById.values()].map((s) => s.city_id).filter(Boolean) as string[])];
    const cityNameById = new Map<string, string>();
    if (cityIds.length) {
      const { data: cd } = await supabaseAdmin.from('cities').select('id, name').in('id', cityIds);
      for (const c of (cd || []) as any[]) cityNameById.set(c.id as string, (c.name as string) ?? '');
    }
    const regionOf = (storeId: string | null): string | null => {
      if (!storeId) return null;
      const cid = storeById.get(storeId)?.city_id ?? null;
      return cid ? cityNameById.get(cid) ?? null : null;
    };

    const scored = rows.filter((r) => r.score != null);
    const captures_count = scored.length;
    const stores_count = new Set(rows.map((r) => r.store_id).filter(Boolean) as string[]).size;

    // 1. Compliance trend — daily average score.
    const dayAgg = new Map<string, { sum: number; count: number }>();
    for (const r of scored) {
      const day = (r.created_at || '').slice(0, 10);
      if (!day) continue;
      const b = dayAgg.get(day) || { sum: 0, count: 0 };
      b.sum += r.score as number;
      b.count += 1;
      dayAgg.set(day, b);
    }
    const compliance_trend = [...dayAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, b]) => ({ date, avg_score: round1(b.sum / b.count), captures: b.count }));

    // 2. Category share — window average of own/competitor share per category.
    const catAgg = new Map<string, { own: number; comp: number; facings: number; n: number; ownP: number; ownPn: number; compP: number; compPn: number }>();
    for (const r of rows) {
      const cb = Array.isArray(r.category_breakdown) ? (r.category_breakdown as any[]) : [];
      for (const c of cb) {
        const name = typeof c?.category === 'string' && c.category.trim() ? c.category.trim() : null;
        if (!name) continue;
        const a = catAgg.get(name) || { own: 0, comp: 0, facings: 0, n: 0, ownP: 0, ownPn: 0, compP: 0, compPn: 0 };
        a.own += num(c.own_share);
        a.comp += num(c.competitor_share);
        a.facings += num(c.facings);
        a.n += 1;
        if (c?.avg_own_price != null && Number.isFinite(Number(c.avg_own_price))) { a.ownP += Number(c.avg_own_price); a.ownPn += 1; }
        if (c?.avg_competitor_price != null && Number.isFinite(Number(c.avg_competitor_price))) { a.compP += Number(c.avg_competitor_price); a.compPn += 1; }
        catAgg.set(name, a);
      }
    }
    const category_share = [...catAgg.entries()]
      .map(([category, a]) => ({
        category,
        own_share: round1(a.own / a.n),
        competitor_share: round1(a.comp / a.n),
        facings: Math.round(a.facings),
        captures: a.n,
        avg_own_price: a.ownPn ? round1(a.ownP / a.ownPn) : null,
        avg_competitor_price: a.compPn ? round1(a.compP / a.compPn) : null,
      }))
      .sort((x, y) => y.facings - x.facings);

    // 3. Price movement — daily own vs competitor average shelf price.
    const priceByDay = new Map<string, { own: number; ownN: number; comp: number; compN: number }>();
    for (const r of rows) {
      const day = (r.created_at || '').slice(0, 10);
      if (!day) continue;
      const pr = Array.isArray(r.pricing) ? (r.pricing as any[]) : [];
      for (const p of pr) {
        const price = p?.price;
        if (price == null || !Number.isFinite(Number(price))) continue;
        const b = priceByDay.get(day) || { own: 0, ownN: 0, comp: 0, compN: 0 };
        if (p?.is_competitor === true) { b.comp += Number(price); b.compN += 1; }
        else { b.own += Number(price); b.ownN += 1; }
        priceByDay.set(day, b);
      }
    }
    const price_movement = [...priceByDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, b]) => ({
        date,
        own_avg_price: b.ownN ? round1(b.own / b.ownN) : null,
        competitor_avg_price: b.compN ? round1(b.comp / b.compN) : null,
        own_n: b.ownN,
        competitor_n: b.compN,
      }));

    // 4. Store compliance (ranked) + region rollup (by city).
    const storeAgg = new Map<string, { score: number; n: number; own: number; ownN: number; comp: number; compN: number }>();
    for (const r of scored) {
      if (!r.store_id) continue;
      const a = storeAgg.get(r.store_id) || { score: 0, n: 0, own: 0, ownN: 0, comp: 0, compN: 0 };
      a.score += r.score as number;
      a.n += 1;
      if (r.shelf_share_own != null) { a.own += r.shelf_share_own; a.ownN += 1; }
      if (r.competitor_share != null) { a.comp += r.competitor_share; a.compN += 1; }
      storeAgg.set(r.store_id, a);
    }
    const store_compliance = [...storeAgg.entries()]
      .map(([store_id, a]) => ({
        store_id,
        store_name: storeById.get(store_id)?.name ?? null,
        region: regionOf(store_id),
        captures: a.n,
        avg_score: round1(a.score / a.n),
        own_shelf_share: a.ownN ? round1(a.own / a.ownN) : null,
        competitor_share: a.compN ? round1(a.comp / a.compN) : null,
      }))
      .sort((x, y) => y.avg_score - x.avg_score);

    const regionAgg = new Map<string, { score: number; n: number; own: number; ownN: number; stores: Set<string> }>();
    for (const r of scored) {
      const region = regionOf(r.store_id) || 'Unassigned';
      const a = regionAgg.get(region) || { score: 0, n: 0, own: 0, ownN: 0, stores: new Set<string>() };
      a.score += r.score as number;
      a.n += 1;
      if (r.shelf_share_own != null) { a.own += r.shelf_share_own; a.ownN += 1; }
      if (r.store_id) a.stores.add(r.store_id);
      regionAgg.set(region, a);
    }
    const region_compliance = [...regionAgg.entries()]
      .map(([region, a]) => ({
        region,
        stores: a.stores.size,
        captures: a.n,
        avg_score: round1(a.score / a.n),
        own_shelf_share: a.ownN ? round1(a.own / a.ownN) : null,
      }))
      .sort((x, y) => y.avg_score - x.avg_score);

    // 5. Promotion presence — share of captures carrying a live offer + top offers.
    const promoDay = new Map<string, { total: number; withPromo: number }>();
    const offerAgg = new Map<string, { text: string; offer_type: string; count: number }>();
    let capturesWithPromo = 0;
    for (const r of rows) {
      const day = (r.created_at || '').slice(0, 10);
      const promos = Array.isArray(r.promotions) ? (r.promotions as any[]) : [];
      const has = promos.length > 0;
      if (has) capturesWithPromo += 1;
      if (day) {
        const b = promoDay.get(day) || { total: 0, withPromo: 0 };
        b.total += 1;
        if (has) b.withPromo += 1;
        promoDay.set(day, b);
      }
      for (const p of promos) {
        const text = typeof p?.text === 'string' ? p.text.trim() : '';
        if (!text) continue;
        const key = text.toLowerCase();
        const a = offerAgg.get(key) || { text, offer_type: typeof p?.offer_type === 'string' ? p.offer_type : 'other', count: 0 };
        a.count += 1;
        offerAgg.set(key, a);
      }
    }
    const promo = {
      captures_total: rows.length,
      captures_with_promo: capturesWithPromo,
      pct: rows.length ? round1((capturesWithPromo / rows.length) * 100) : 0,
      trend: [...promoDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, b]) => ({ date, total: b.total, with_promo: b.withPromo, pct: b.total ? round1((b.withPromo / b.total) * 100) : 0 })),
      top_offers: [...offerAgg.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    };

    return {
      period_days: periodDays,
      captures_count,
      stores_count,
      compliance_trend,
      category_share,
      price_movement,
      store_compliance,
      region_compliance,
      promo,
    };
  }

  // ── Redesigned module: captures list + overview ──────────────────────────

  /**
   * Captures list for the redesigned module (Captures tab + Review queue).
   * Newest first. `total` reflects the filtered set BEFORE pagination.
   * Org-scoped like the sibling planogram routes (org_id only).
   */
  static async listCaptures(orgId: string, filters: CaptureListFilters = {}): Promise<CapturesListResult> {
    const enriched = await this.enrichedCaptures(orgId, { storeId: filters.storeId });

    let rows = enriched;
    if (filters.city) {
      const target = filters.city.trim().toLowerCase();
      rows = rows.filter((r) => (r.city ?? '').toLowerCase() === target);
    }
    if (filters.needsReview !== undefined) {
      rows = rows.filter((r) => r.needs_review === filters.needsReview);
    }
    if (filters.minScore !== undefined && Number.isFinite(filters.minScore)) {
      rows = rows.filter((r) => r.score != null && r.score >= (filters.minScore as number));
    }
    if (filters.maxScore !== undefined && Number.isFinite(filters.maxScore)) {
      rows = rows.filter((r) => r.score != null && r.score <= (filters.maxScore as number));
    }

    const total = rows.length; // enrichedCaptures already returns newest-first
    const offset = Math.max(0, filters.offset ?? 0);
    const limit = Math.min(200, Math.max(1, filters.limit ?? 30));
    return { total, captures: rows.slice(offset, offset + limit).map(toCaptureListItem) };
  }

  /**
   * Overview aggregate over the last `periodDays` (default 30), org-scoped
   * (+ optional city filter). Deterministic; every headline number is derived
   * from the same enriched capture set as the captures list.
   */
  static async overview(
    orgId: string,
    opts: { periodDays?: number; city?: string } = {},
  ): Promise<PlanogramOverviewResult> {
    const periodDays = Math.min(365, Math.max(1, opts.periodDays ?? 30));
    const sinceISO = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    let enriched = await this.enrichedCaptures(orgId, { sinceISO });
    if (opts.city) {
      const target = opts.city.trim().toLowerCase();
      enriched = enriched.filter((r) => (r.city ?? '').toLowerCase() === target);
    }
    // Only captures that were actually scored feed the headline aggregates.
    const scored = enriched.filter((r) => r.score != null);

    const captures_count = scored.length;
    const stores_count = new Set(scored.map((r) => r.store_id).filter(Boolean) as string[]).size;
    const flagged_count = scored.filter((r) => r.needs_review).length;
    const avg_compliance = captures_count
      ? round1(scored.reduce((s, r) => s + (r.score as number), 0) / captures_count)
      : 0;
    const shareRows = scored.filter((r) => r.shelf_share_own != null);
    const own_shelf_share = shareRows.length
      ? round1(shareRows.reduce((s, r) => s + (r.shelf_share_own as number), 0) / shareRows.length)
      : 0;

    // Daily average-score trend (ascending by date).
    const byDay = new Map<string, { sum: number; count: number }>();
    for (const r of scored) {
      const day = (r.captured_at || '').slice(0, 10);
      if (!day) continue;
      const b = byDay.get(day) || { sum: 0, count: 0 };
      b.sum += r.score as number;
      b.count += 1;
      byDay.set(day, b);
    }
    const trend = Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, b]) => ({ date, avg_score: round1(b.sum / b.count) }));

    // Needs attention: lowest-scoring first (tie-break newest), top 5.
    const needs_attention = scored
      .slice()
      .sort((a, b) => (a.score as number) - (b.score as number) || b.captured_at.localeCompare(a.captured_at))
      .slice(0, 5)
      .map((r) => ({ capture_id: r.id, store_name: r.store_name, score: r.score, reason: attentionReason(r) }));

    // Recent: latest 6 (enriched is already newest-first).
    const recent = scored.slice(0, 6).map((r) => ({
      capture_id: r.id,
      store_name: r.store_name,
      category: r.category,
      captured_at: r.captured_at,
      score: r.score,
      recovered_count: r.recovered_count,
      needs_review: r.needs_review,
      competitor_present: r.competitor_present,
    }));

    return {
      avg_compliance,
      own_shelf_share,
      captures_count,
      stores_count,
      flagged_count,
      trend,
      needs_attention,
      recent,
    };
  }

  /**
   * Load org captures (newest first) and enrich each with its compliance score,
   * recognition-derived flags, and resolved store / city / category / FE names.
   *
   * Store name → stores.name; city → stores.city_id → cities.name (the demo
   * stores carry the city in the name with a null city_id, so city can be null);
   * category → planograms.category; fe_name → users.name; recovered_count =
   * detected_skus with recovered===true; competitor_present = any detected
   * is_competitor===true. Batched lookups keep it to a handful of queries; the
   * capture set is bounded (small per org) like the sibling analytics rollups.
   */
  private static async enrichedCaptures(
    orgId: string,
    opts: { sinceISO?: string; storeId?: string } = {},
  ): Promise<EnrichedCapture[]> {
    let capQ = supabaseAdmin
      .from('planogram_captures')
      .select('id, store_id, planogram_id, fe_id, captured_at, blur_score, glare_score, angle_score')
      .eq('org_id', orgId)
      .order('captured_at', { ascending: false })
      .limit(5000);
    if (opts.storeId) capQ = capQ.eq('store_id', opts.storeId);
    if (opts.sinceISO) capQ = capQ.gte('captured_at', opts.sinceISO);
    const { data: capsData, error } = await capQ;
    if (error) throw error;
    const captures = (capsData || []) as Array<{
      id: string;
      store_id: string | null;
      planogram_id: string | null;
      fe_id: string | null;
      captured_at: string;
      blur_score: number | null;
      glare_score: number | null;
      angle_score: number | null;
    }>;
    if (captures.length === 0) return [];

    const capIds = captures.map((c) => c.id);

    // Compliance (1:1 with capture) → score + shares + missing count.
    const complianceByCapture = new Map<
      string,
      { score: number | null; presence_score: number | null; shelf_share_own: number | null; competitor_share: number | null; missing_count: number }
    >();
    {
      const { data } = await supabaseAdmin
        .from('planogram_compliance')
        .select('capture_id, score, presence_score, shelf_share_own, competitor_share, missing_skus')
        .in('capture_id', capIds);
      for (const r of (data || []) as any[]) {
        complianceByCapture.set(r.capture_id as string, {
          score: r.score ?? null,
          presence_score: r.presence_score ?? null,
          shelf_share_own: r.shelf_share_own ?? null,
          competitor_share: r.competitor_share ?? null,
          missing_count: Array.isArray(r.missing_skus) ? r.missing_skus.length : 0,
        });
      }
    }

    // Recognition (1:1 with capture) → needs_review + recovered/competitor flags.
    const recognitionByCapture = new Map<string, { needs_review: boolean; recovered: number; competitor: boolean }>();
    {
      const { data } = await supabaseAdmin
        .from('planogram_recognition')
        .select('capture_id, needs_review, detected_skus')
        .in('capture_id', capIds);
      for (const r of (data || []) as any[]) {
        const detected = (r.detected_skus as any[]) || [];
        let recovered = 0;
        let competitor = false;
        for (const d of detected) {
          if (d && d.recovered === true) recovered += 1;
          if (d && d.is_competitor === true) competitor = true;
        }
        recognitionByCapture.set(r.capture_id as string, { needs_review: r.needs_review === true, recovered, competitor });
      }
    }

    // Stores → name + city_id.
    const storeIds = [...new Set(captures.map((c) => c.store_id).filter(Boolean) as string[])];
    const storeById = new Map<string, { name: string | null; city_id: string | null }>();
    if (storeIds.length) {
      const { data } = await supabaseAdmin.from('stores').select('id, name, city_id').in('id', storeIds);
      for (const s of (data || []) as any[]) storeById.set(s.id as string, { name: (s.name as string) ?? null, city_id: (s.city_id as string) ?? null });
    }

    // Cities → name (resolved from the store's city_id).
    const cityIds = [...new Set([...storeById.values()].map((s) => s.city_id).filter(Boolean) as string[])];
    const cityNameById = new Map<string, string>();
    if (cityIds.length) {
      const { data } = await supabaseAdmin.from('cities').select('id, name').in('id', cityIds);
      for (const c of (data || []) as any[]) cityNameById.set(c.id as string, (c.name as string) ?? '');
    }

    // Planograms → category.
    const planogramIds = [...new Set(captures.map((c) => c.planogram_id).filter(Boolean) as string[])];
    const categoryById = new Map<string, string | null>();
    if (planogramIds.length) {
      const { data } = await supabaseAdmin.from('planograms').select('id, category').in('id', planogramIds);
      for (const p of (data || []) as any[]) categoryById.set(p.id as string, (p.category as string) ?? null);
    }

    // Users → FE display name.
    const feIds = [...new Set(captures.map((c) => c.fe_id).filter(Boolean) as string[])];
    const feNameById = new Map<string, string | null>();
    if (feIds.length) {
      const { data } = await supabaseAdmin.from('users').select('id, name').in('id', feIds);
      for (const u of (data || []) as any[]) feNameById.set(u.id as string, (u.name as string) ?? null);
    }

    return captures.map((c) => {
      const comp = complianceByCapture.get(c.id);
      const rec = recognitionByCapture.get(c.id);
      const store = c.store_id ? storeById.get(c.store_id) : undefined;
      const cityId = store?.city_id ?? null;
      return {
        id: c.id,
        store_id: c.store_id ?? null,
        store_name: store?.name ?? null,
        city: cityId ? cityNameById.get(cityId) ?? null : null,
        category: c.planogram_id ? categoryById.get(c.planogram_id) ?? null : null,
        captured_at: c.captured_at,
        fe_name: c.fe_id ? feNameById.get(c.fe_id) ?? null : null,
        score: comp?.score ?? null,
        presence_score: comp?.presence_score ?? null,
        shelf_share_own: comp?.shelf_share_own ?? null,
        needs_review: rec?.needs_review ?? false,
        recovered_count: rec?.recovered ?? 0,
        competitor_present: rec?.competitor ?? false,
        competitor_share: comp?.competitor_share ?? null,
        missing_count: comp?.missing_count ?? 0,
        blur_score: c.blur_score ?? null,
        glare_score: c.glare_score ?? null,
        angle_score: c.angle_score ?? null,
      };
    });
  }
}

/** Strip the internal reason-signal fields off an enriched capture. */
function toCaptureListItem(c: EnrichedCapture): CaptureListItem {
  return {
    id: c.id,
    store_id: c.store_id,
    store_name: c.store_name,
    city: c.city,
    category: c.category,
    captured_at: c.captured_at,
    fe_name: c.fe_name,
    score: c.score,
    presence_score: c.presence_score,
    shelf_share_own: c.shelf_share_own,
    needs_review: c.needs_review,
    recovered_count: c.recovered_count,
    competitor_present: c.competitor_present,
  };
}

/**
 * Short, deterministic human reason for the Overview "needs attention" list,
 * derived from the strongest available signal (photo quality → competitor
 * share → shelf gaps → review flag → raw compliance).
 */
function attentionReason(c: EnrichedCapture): string {
  const LOWQ = 0.4; // same 0.4 quality floor the capture pipeline flags on
  if (
    (c.blur_score != null && c.blur_score < LOWQ) ||
    (c.glare_score != null && c.glare_score < LOWQ) ||
    (c.angle_score != null && c.angle_score < LOWQ)
  ) {
    return 'Low photo quality';
  }
  if (c.competitor_share != null && c.competitor_share >= 25) {
    return `Competitor share ${Math.round(c.competitor_share)}%`;
  }
  if (c.missing_count > 0) {
    return `${c.missing_count} SKU${c.missing_count === 1 ? '' : 's'} not on shelf`;
  }
  if (c.needs_review) return 'Flagged for review';
  return `Compliance ${Math.round(c.score ?? 0)}%`;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
/** Finite-or-zero coercion for aggregating possibly-null jsonb numeric fields. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clamp(min: number, max: number, v: number) {
  return Math.max(min, Math.min(max, v));
}
function linearSlope(points: Array<{ x: number; y: number }>): number {
  // Returns slope in score-units per day (x is ms)
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (!den) return 0;
  const perMs = num / den;
  return perMs * 24 * 60 * 60 * 1000; // per day
}

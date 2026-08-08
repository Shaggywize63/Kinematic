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

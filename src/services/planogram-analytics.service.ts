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

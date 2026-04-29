/**
 * planogram.service.ts
 *
 * Core compliance + recommendation engine. Given a shelf recognition result
 * and the expected planogram, produces:
 *   • a 0..100 compliance score (presence + facing + position)
 *   • lists of missing / misplaced SKUs and facing deltas
 *   • prioritized "what to fix" actions
 *
 * The engine is deterministic so the same inputs always yield the same
 * scores, making analytics over time meaningful.
 */

import { supabaseAdmin } from '../lib/supabase';
import { AppError } from '../utils';
import {
  PlanogramVisionService,
  ShelfRecognition,
  DetectedSKU,
} from './planogram-vision.service';

export interface ExpectedSKU {
  sku_id: string;
  sku_name: string;
  shelf_index: number;
  facings: number;
  position?: number;            // left-to-right rank on shelf (optional)
  weight?: number;              // sales-weighted importance (default 1)
  competitor_ids?: string[];    // SKUs that may displace this one
}

export interface PlanogramLayout {
  shelves: Array<{ index: number; capacity?: number }>;
  expected_skus: ExpectedSKU[];
}

export interface ComplianceResult {
  score: number;               // 0..100
  presence_score: number;
  facing_score: number;
  position_score: number;
  competitor_share: number;
  missing_skus: Array<{ sku_id: string; sku_name: string; expected_facings: number }>;
  misplaced_skus: Array<{
    sku_id: string;
    sku_name: string;
    expected_shelf: number;
    actual_shelf: number;
  }>;
  facing_deltas: Array<{
    sku_id: string;
    sku_name: string;
    expected: number;
    actual: number;
    delta: number;
  }>;
  recommendations: Array<{
    priority: 'critical' | 'high' | 'medium' | 'low';
    action: string;
    sku_id?: string;
    sku_name?: string;
    rationale: string;
  }>;
}

export interface ScoreShelfArgs {
  recognition: ShelfRecognition;
  layout: PlanogramLayout;
}

export class PlanogramService {
  /**
   * Score a shelf capture against the expected planogram.
   * Pure function — does not write to the DB.
   */
  static scoreShelf(args: ScoreShelfArgs): ComplianceResult {
    const { recognition, layout } = args;
    const expected = layout.expected_skus || [];
    const detected = recognition.detected_skus || [];

    if (expected.length === 0) {
      throw new AppError(400, 'Planogram has no expected SKUs.', 'PLANOGRAM_EMPTY');
    }

    const detectedById = new Map<string, DetectedSKU>();
    for (const d of detected) {
      if (d.sku_id && !d.is_competitor) detectedById.set(d.sku_id, d);
    }

    // ── Presence ───────────────────────────────────────────────
    const totalWeight = expected.reduce((s, e) => s + (e.weight ?? 1), 0);
    const presentWeight = expected
      .filter((e) => detectedById.has(e.sku_id))
      .reduce((s, e) => s + (e.weight ?? 1), 0);
    const presence_score = totalWeight ? (presentWeight / totalWeight) * 100 : 0;

    // ── Facings ─────────────────────────────────────────────────────
    let facingPenalty = 0;
    let facingMax = 0;
    const facing_deltas: ComplianceResult['facing_deltas'] = [];
    for (const e of expected) {
      const d = detectedById.get(e.sku_id);
      const actual = d?.facings ?? 0;
      const delta = actual - e.facings;
      const w = e.weight ?? 1;
      facingMax += e.facings * w;
      facingPenalty += Math.abs(delta) * w;
      if (delta !== 0) {
        facing_deltas.push({
          sku_id: e.sku_id,
          sku_name: e.sku_name,
          expected: e.facings,
          actual,
          delta,
        });
      }
    }
    const facing_score = facingMax
      ? Math.max(0, 100 - (facingPenalty / facingMax) * 100)
      : 100;

    // ── Position ──────────────────────────────────────────────────────
    const misplaced_skus: ComplianceResult['misplaced_skus'] = [];
    let positionMatches = 0;
    let positionTotal = 0;
    for (const e of expected) {
      const d = detectedById.get(e.sku_id);
      if (!d) continue;
      positionTotal += 1;
      if (d.shelf_index === e.shelf_index) {
        positionMatches += 1;
      } else {
        misplaced_skus.push({
          sku_id: e.sku_id,
          sku_name: e.sku_name,
          expected_shelf: e.shelf_index,
          actual_shelf: d.shelf_index,
        });
      }
    }
    const position_score = positionTotal
      ? (positionMatches / positionTotal) * 100
      : 0;

    // ── Competitor share ──────────────────────────────────────────────
    const totalFacings = detected.reduce((s, d) => s + (d.facings || 0), 0) || 1;
    const competitorFacings = detected
      .filter((d) => d.is_competitor)
      .reduce((s, d) => s + (d.facings || 0), 0);
    const competitor_share = (competitorFacings / totalFacings) * 100;

    // ── Missing ────────────────────────────────────────────────────
    const missing_skus = expected
      .filter((e) => !detectedById.has(e.sku_id))
      .map((e) => ({
        sku_id: e.sku_id,
        sku_name: e.sku_name,
        expected_facings: e.facings,
      }));

    // ── Composite score ───────────────────────────────────────────────
    // Weighted: presence dominates, facings + position equal, competitor
    // share lightly penalizes if it's eating shelf space.
    const competitorPenalty = Math.max(0, competitor_share - 25); // tolerate 25%
    const score =
      0.5 * presence_score +
      0.25 * facing_score +
      0.2 * position_score -
      0.05 * competitorPenalty;

    return {
      score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)),
      presence_score: round1(presence_score),
      facing_score: round1(facing_score),
      position_score: round1(position_score),
      competitor_share: round1(competitor_share),
      missing_skus,
      misplaced_skus,
      facing_deltas,
      recommendations: this.buildRecommendations({
        missing_skus,
        misplaced_skus,
        facing_deltas,
        competitor_share,
        expected,
      }),
    };
  }

  /** Prioritized "what to fix" list. */
  private static buildRecommendations(input: {
    missing_skus: ComplianceResult['missing_skus'];
    misplaced_skus: ComplianceResult['misplaced_skus'];
    facing_deltas: ComplianceResult['facing_deltas'];
    competitor_share: number;
    expected: ExpectedSKU[];
  }): ComplianceResult['recommendations'] {
    const recs: ComplianceResult['recommendations'] = [];
    const weightOf = (sku_id: string) =>
      input.expected.find((e) => e.sku_id === sku_id)?.weight ?? 1;

    for (const m of input.missing_skus) {
      const w = weightOf(m.sku_id);
      recs.push({
        priority: w >= 2 ? 'critical' : 'high',
        action: `Restock ${m.sku_name} (${m.expected_facings} facings)`,
        sku_id: m.sku_id,
        sku_name: m.sku_name,
        rationale:
          w >= 2
            ? 'High-velocity SKU is missing — direct sales loss.'
            : 'Expected SKU is absent on shelf.',
      });
    }

    for (const m of input.misplaced_skus) {
      recs.push({
        priority: 'medium',
        action: `Move ${m.sku_name} from shelf ${m.actual_shelf} to shelf ${m.expected_shelf}`,
        sku_id: m.sku_id,
        sku_name: m.sku_name,
        rationale: 'Shelf position deviates from planogram; eye-level placement matters.',
      });
    }

    for (const d of input.facing_deltas) {
      if (d.delta < 0) {
        recs.push({
          priority: d.expected - d.actual >= 2 ? 'high' : 'medium',
          action: `Increase facings of ${d.sku_name} by ${-d.delta}`,
          sku_id: d.sku_id,
          sku_name: d.sku_name,
          rationale: `Currently ${d.actual} facings, planogram expects ${d.expected}.`,
        });
      } else if (d.delta > 1) {
        recs.push({
          priority: 'low',
          action: `Trim ${d.sku_name} by ${d.delta} facings to free shelf space`,
          sku_id: d.sku_id,
          sku_name: d.sku_name,
          rationale: 'Over-facing reduces variety perception.',
        });
      }
    }

    if (input.competitor_share > 35) {
      recs.push({
        priority: 'high',
        action: 'Reclaim shelf space from competitor placements',
        rationale: `Competitor share is ${round1(input.competitor_share)}% of facings.`,
      });
    }

    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return recs.sort((a, b) => order[a.priority] - order[b.priority]).slice(0, 12);
  }

  // ── Persistence helpers ───────────────────────────────────────────────

  static async loadPlanogramLayout(planogramId: string): Promise<PlanogramLayout> {
    const { data, error } = await supabaseAdmin
      .from('planograms')
      .select('id, layout, expected_skus')
      .eq('id', planogramId)
      .single();
    if (error || !data) {
      throw new AppError(404, 'Planogram not found', 'NOT_FOUND');
    }
    return {
      shelves: data.layout?.shelves || [],
      expected_skus: data.expected_skus || [],
    };
  }

  static async resolvePlanogramForStore(
    orgId: string,
    storeId: string,
  ): Promise<string | null> {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabaseAdmin
      .from('planogram_assignments')
      .select('planogram_id, valid_from, valid_to')
      .eq('org_id', orgId)
      .eq('store_id', storeId)
      .lte('valid_from', today)
      .order('valid_from', { ascending: false })
      .limit(1);
    const row = data?.[0];
    if (!row) return null;
    if (row.valid_to && row.valid_to < today) return null;
    return row.planogram_id;
  }

  /**
   * End-to-end pipeline: capture image → vision → compliance → persist.
   * Returns the persisted compliance row id along with the result payload.
   */
  static async processCapture(args: {
    orgId: string;
    clientId?: string | null;
    feId: string;
    storeId?: string | null;
    visitId?: string | null;
    planogramId?: string | null;
    imageUrl: string;
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    capture: { lat?: number; lng?: number; deviceMeta?: any };
  }): Promise<{
    capture_id: string;
    compliance_id: string;
    result: ComplianceResult;
    recognition: ShelfRecognition;
  }> {
    let planogramId = args.planogramId;
    if (!planogramId && args.storeId) {
      planogramId = await this.resolvePlanogramForStore(args.orgId, args.storeId);
    }
    if (!planogramId) {
      throw new AppError(
        400,
        'No active planogram for this store. Provide planogram_id or assign one to the store.',
        'NO_PLANOGRAM',
      );
    }

    const layout = await this.loadPlanogramLayout(planogramId);

    const recognition = await PlanogramVisionService.recognizeShelf({
      imageBase64: args.imageBase64,
      imageMediaType: args.imageMediaType,
      expectedSkus: layout.expected_skus.map((s) => ({
        sku_id: s.sku_id,
        sku_name: s.sku_name,
      })),
    });

    const result = this.scoreShelf({ recognition, layout });

    // Persist capture
    const { data: cap, error: capErr } = await supabaseAdmin
      .from('planogram_captures')
      .insert({
        org_id: args.orgId,
        client_id: args.clientId ?? null,
        fe_id: args.feId,
        store_id: args.storeId ?? null,
        visit_id: args.visitId ?? null,
        planogram_id: planogramId,
        image_url: args.imageUrl,
        capture_lat: args.capture.lat ?? null,
        capture_lng: args.capture.lng ?? null,
        angle_score: recognition.quality.angle_score,
        blur_score: recognition.quality.blur_score,
        glare_score: recognition.quality.glare_score,
        device_meta: args.capture.deviceMeta ?? null,
      })
      .select('id')
      .single();
    if (capErr || !cap) {
      throw new AppError(500, 'Failed to persist capture', 'DB_ERROR');
    }

    await supabaseAdmin.from('planogram_recognition').insert({
      capture_id: cap.id,
      org_id: args.orgId,
      detected_skus: recognition.detected_skus,
      shelf_map: { shelf_count: recognition.shelf_count },
      overall_confidence: recognition.overall_confidence,
      model_versions: { vision: recognition.model_version },
      needs_review: recognition.needs_review,
    });

    const { data: comp, error: compErr } = await supabaseAdmin
      .from('planogram_compliance')
      .insert({
        org_id: args.orgId,
        client_id: args.clientId ?? null,
        capture_id: cap.id,
        planogram_id: planogramId,
        store_id: args.storeId ?? null,
        fe_id: args.feId,
        score: result.score,
        presence_score: result.presence_score,
        facing_score: result.facing_score,
        position_score: result.position_score,
        competitor_share: result.competitor_share,
        missing_skus: result.missing_skus,
        misplaced_skus: result.misplaced_skus,
        facing_deltas: result.facing_deltas,
        recommendations: result.recommendations,
      })
      .select('id')
      .single();
    if (compErr || !comp) {
      throw new AppError(500, 'Failed to persist compliance', 'DB_ERROR');
    }

    return {
      capture_id: cap.id,
      compliance_id: comp.id,
      result,
      recognition,
    };
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

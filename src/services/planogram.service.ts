/**
 * planogram.service.ts
 *
 * Core compliance + recommendation engine. Given a shelf recognition result
 * and the expected planogram, produces:
 *   • a 0..100 compliance score (presence + facing + position + competitor)
 *   • occupancy, shelf-share, per-category and per-zone rollups
 *   • verbatim pricing rows (with expected-price deltas) and promotions
 *   • lists of missing / misplaced SKUs and facing deltas
 *   • prioritized "what to fix" actions
 *   • a `methodology` object documenting how every headline number is computed
 *
 * The engine is deterministic so the same inputs always yield the same
 * scores, making analytics over time meaningful. The composite compliance
 * score formula is intentionally UNCHANGED from v1 (presence/facing/position/
 * competitor weighted 0.5/0.25/0.2/0.05) — occupancy and shelf-share are
 * reported alongside it, not folded in.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { AppError } from '../utils';
import {
  PlanogramVisionService,
  ShelfRecognition,
  DetectedSKU,
  RecognizeArgs,
  ShelfZone,
  PriceSource,
  PromoOfferType,
  PosmDetection,
  PosmType,
  PosmCondition,
} from './planogram-vision.service';

export interface ExpectedSKU {
  sku_id: string;
  sku_name: string;
  shelf_index: number;
  facings: number;
  position?: number;            // left-to-right rank on shelf (optional)
  weight?: number;              // sales-weighted importance (default 1)
  competitor_ids?: string[];    // SKUs that may displace this one
  ref_image_url?: string;       // front-facing pack shot → vision reference
  brand?: string | null;        // NEW — passed to the model as a matching hint
  category?: string | null;     // NEW — seeds the category taxonomy + rollups
  expected_price?: number | null; // NEW — baseline for pricing deltas
  // NEW — extra reference pack-shots grown by the confirm-crop-as-reference
  // flow (a field rep confirms a detection → its crop is stored here). Loaded
  // alongside ref_image_url so confirmed crops feed future recognition. jsonb;
  // no migration (lives inside the expected_skus jsonb column).
  additional_ref_urls?: string[];
}

export interface PlanogramLayout {
  shelves: Array<{ index: number; capacity?: number }>;
  expected_skus: ExpectedSKU[];
  // Competitor SKUs the brand tracks (Veeba / Ching's / Maggi …). Stored on
  // the planogram's `layout.competitors` jsonb and passed to the vision model
  // so competitor detection is matched against an explicit list rather than
  // inferred heuristically — this is what makes share-of-shelf reliable.
  competitors: Array<{
    sku_id: string;
    sku_name: string;
    brand?: string;
    ref_image_url?: string;
    category?: string | null;       // NEW
    expected_price?: number | null; // NEW
    additional_ref_urls?: string[]; // NEW — confirmed-crop reference pack-shots
  }>;
  // NEW — opt-in per-planogram switch for the dense-bay shelf-tiling augment
  // pass (also globally enableable via PLANOGRAM_TILING=1). Default off.
  tiling?: boolean;
  // NEW — expected POSM / merchandising assets this planogram prescribes, used
  // by the POSM-compliance check (expected-vs-found). Stored on the planogram's
  // own `expected_posm` jsonb column. Empty/omitted → POSM compliance is N/A.
  expected_posm?: ExpectedPosm[];
}

/** One prescribed POSM / merchandising asset on a planogram. */
export interface ExpectedPosm {
  id?: string;
  type: PosmType;
  name: string;
  brand?: string | null;
  required?: boolean;   // default true — counts toward the POSM score
}

export interface CategoryBreakdown {
  category: string;
  occupancy: number;              // % of total detected shelf area in this category
  own_share: number;             // own facings / total facings in category (%)
  competitor_share: number;      // competitor facings / total facings in category (%)
  facings: number;
  sku_count: number;             // distinct detected SKUs in the category
  avg_own_price: number | null;
  avg_competitor_price: number | null;
}

export interface ZoneBreakdown {
  zone: ShelfZone;
  own_facings: number;
  competitor_facings: number;
  own_share: number;             // own / (own + competitor) facings (%)
  sku_ids: string[];             // distinct detected sku_ids in the zone
}

export interface PricingRow {
  sku_id: string | null;
  sku_name: string;
  is_competitor: boolean;
  brand?: string | null;         // NEW — matched competitor (or own) brand for stable identity
  price: number;
  currency: string | null;
  expected_price: number | null;
  delta: number | null;          // price - expected_price (own SKUs with a baseline)
  source: PriceSource | null;
  confidence: number;
}

export interface CompliancePromo {
  text: string;
  offer_type: PromoOfferType;
  confidence: number;
  linked_sku_ids: string[];
}

/** Stock-count-from-image rollup for one capture. */
export interface StockSummary {
  total_units: number;            // own + competitor estimated units on shelf
  own_units: number;
  competitor_units: number;
  availability_rate: number;      // % of expected own SKUs present on shelf (0..100)
  oos_count: number;              // expected own SKUs not found (out of stock)
  low_count: number;              // detected own SKUs flagged low / near-empty
  out_of_stock_skus: Array<{ sku_id: string; sku_name: string }>;
  low_stock_skus: Array<{ sku_id: string; sku_name: string; units_estimate: number | null }>;
}

/** POSM / merchandising compliance (expected-vs-found) for one capture. */
export interface PosmCompliance {
  expected_count: number;
  required_count: number;
  found_count: number;
  score: number | null;           // % of required POSM found in acceptable condition; null when nothing expected
  missing: Array<{ type: PosmType; name: string }>;
  damaged: Array<{ type: PosmType; name: string }>;
  found: Array<{ type: PosmType; name: string; brand: string | null; condition: PosmCondition; confidence: number }>;
}

export interface MethodologyEntry {
  formula: string;
  inputs: string[];
  notes?: string;
  // ── Auditability (all OPTIONAL so older stored methodology that only carries
  //    {formula, inputs, notes} still validates and renders) ────────────────
  weight?: number;   // composite contribution weight: presence 0.5, facing 0.25,
                     // position 0.2, competitor −0.05; omit for occupancy/shelf_share/zone
  result?: number;   // the computed metric value (0..100), rounded 1dp
  calc?: string;     // the ACTUAL arithmetic with real numbers, e.g.
                     // "present weight 20 / total weight 32 × 100 = 62.5"
  columns?: { key: string; label: string }[];               // header for the per-item audit table
  rows?: Array<Record<string, string | number | boolean | null>>; // per-SKU audit rows
}

/** One row of a methodology audit table. */
type MethodologyRow = Record<string, string | number | boolean | null>;

export type Methodology = Record<string, MethodologyEntry>;

export interface ComplianceResult {
  score: number;               // 0..100 (composite — UNCHANGED formula)
  presence_score: number;
  facing_score: number;
  position_score: number;
  competitor_share: number;
  occupancy_score: number;         // NEW — overall filled shelf space %
  shelf_share_own: number;         // NEW — own facings / total facings (%)
  shelf_share_competitor: number;  // NEW — competitor facings / total facings (%)
  category_breakdown: CategoryBreakdown[]; // NEW
  zone_breakdown: ZoneBreakdown[];         // NEW
  pricing: PricingRow[];                   // NEW
  promotions: CompliancePromo[];           // NEW
  stock_summary: StockSummary;             // NEW — stock-count-from-image rollup
  posm: PosmCompliance;                    // NEW — POSM / merchandising compliance
  posm_score: number | null;               // NEW — scalar POSM score (mirror of posm.score)
  availability_rate: number;               // NEW — scalar (mirror of stock_summary.availability_rate)
  oos_count: number;                        // NEW — scalar (mirror of stock_summary.oos_count)
  low_stock_count: number;                  // NEW — scalar (mirror of stock_summary.low_count)
  methodology: Methodology;                // NEW
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

const UNCATEGORIZED = 'Uncategorized';

export class PlanogramService {
  /**
   * Score a shelf capture against the expected planogram. Deterministic.
   * Note: this attaches the canonical `zone` (and fills `bbox_area`) onto each
   * detection object in `recognition.detected_skus` so the persisted recognition
   * carries backend-computed zones. It does not otherwise write to the DB.
   */
  static scoreShelf(args: ScoreShelfArgs): ComplianceResult {
    const { recognition, layout } = args;
    const expected = layout.expected_skus || [];
    const detected = recognition.detected_skus || [];

    if (expected.length === 0) {
      throw new AppError(400, 'Planogram has no expected SKUs.', 'PLANOGRAM_EMPTY');
    }

    // ── Lever 2 — competitor matching ──────────────────────────────────
    // Bind each competitor detection to a tracked competitor in
    // layout.competitors so competitors carry a STABLE sku_id/brand across
    // captures. Mutates competitor detections only — presence/facing/position
    // and share math key off is_competitor / own sku_ids, so those numbers are
    // unchanged (detectedById below still excludes competitors).
    this.matchCompetitors(detected, layout.competitors || []);

    const expectedById = new Map<string, ExpectedSKU>();
    for (const e of expected) expectedById.set(e.sku_id, e);

    const detectedById = new Map<string, DetectedSKU>();
    for (const d of detected) {
      if (d.sku_id && !d.is_competitor) detectedById.set(d.sku_id, d);
    }

    // ── Canonical zone (backend-computed) ──────────────────────────────
    // Bottom third of shelves → low, middle → eye, top → top. Attach to each
    // detection (overwriting any model hint) and fill bbox_area if absent.
    const shelfCount = Math.max(
      1,
      recognition.shelf_count || (detected.reduce((m, d) => Math.max(m, d.shelf_index), 0) + 1),
    );
    for (const d of detected) {
      d.zone = zoneFor(d.shelf_index, shelfCount);
      if (d.bbox_area == null && Array.isArray(d.bbox) && d.bbox.length === 4) {
        d.bbox_area = round4((d.bbox[2] || 0) * (d.bbox[3] || 0));
      }
    }

    // ── Presence ───────────────────────────────────────────────
    const totalWeight = expected.reduce((s, e) => s + (e.weight ?? 1), 0);
    let presentWeight = 0;
    const presenceRows: MethodologyRow[] = [];
    for (const e of expected) {
      const w = e.weight ?? 1;
      const present = detectedById.has(e.sku_id);
      if (present) presentWeight += w;
      presenceRows.push({ sku_name: e.sku_name, weight: w, present });
    }
    const presence_score = totalWeight ? (presentWeight / totalWeight) * 100 : 0;

    // ── Facings ─────────────────────────────────────────────────────
    let facingPenalty = 0;
    let facingMax = 0;
    const facing_deltas: ComplianceResult['facing_deltas'] = [];
    const facingRows: MethodologyRow[] = [];
    for (const e of expected) {
      const d = detectedById.get(e.sku_id);
      const actual = d?.facings ?? 0;
      const delta = actual - e.facings;
      const w = e.weight ?? 1;
      facingMax += e.facings * w;
      facingPenalty += Math.abs(delta) * w;
      facingRows.push({
        sku_name: e.sku_name,
        expected: e.facings,
        detected: actual,
        delta,
        weight: w,
        penalty: round2(Math.abs(delta) * w),
      });
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
    const positionRows: MethodologyRow[] = [];
    let positionMatches = 0;
    let positionTotal = 0;
    for (const e of expected) {
      const d = detectedById.get(e.sku_id);
      if (!d) continue;
      positionTotal += 1;
      const match = d.shelf_index === e.shelf_index;
      positionRows.push({
        sku_name: e.sku_name,
        expected_shelf: e.shelf_index,
        actual_shelf: d.shelf_index,
        match,
      });
      if (match) {
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

    // ── Shelf share ───────────────────────────────────────────────────
    const totalFacings = detected.reduce((s, d) => s + (d.facings || 0), 0) || 1;
    const competitorFacings = detected
      .filter((d) => d.is_competitor)
      .reduce((s, d) => s + (d.facings || 0), 0);
    const ownFacings = detected
      .filter((d) => !d.is_competitor)
      .reduce((s, d) => s + (d.facings || 0), 0);
    const competitor_share = (competitorFacings / totalFacings) * 100;
    const shelf_share_own = (ownFacings / totalFacings) * 100;
    const shelf_share_competitor = competitor_share;

    // ── Occupancy ─────────────────────────────────────────────────────
    const shelvesWithCapacity = (layout.shelves || []).filter(
      (s) => Number.isFinite(s.capacity) && (s.capacity as number) > 0,
    );
    let occupancy_score: number;
    let occupancyDenominator: string;
    let occupancyCalc: string;
    if (shelvesWithCapacity.length > 0) {
      const totalCapacity = shelvesWithCapacity.reduce((s, sh) => s + (sh.capacity as number), 0);
      occupancy_score = totalCapacity > 0 ? (totalFacings / totalCapacity) * 100 : 0;
      occupancyDenominator = 'layout.shelves[].capacity (Σ detected facings / Σ capacity × 100)';
      occupancyCalc =
        totalCapacity > 0
          ? `${round1(totalFacings)} facings / ${round1(totalCapacity)} capacity × 100 = ${round1(clamp(0, 100, occupancy_score))}`
          : 'no shelf capacity defined → 0';
    } else {
      // bbox_area = w*h with w,h normalized to the WHOLE image, so `filled` is
      // already the fraction of total image area covered by product (≈1.0 when
      // the shelf is fully packed). Do NOT divide by shelfCount — that would
      // understate occupancy by a factor of the shelf count.
      const filled = detected.reduce((s, d) => s + (d.bbox_area || 0), 0);
      occupancy_score = filled * 100; // Σ bbox_area over the full image
      occupancyDenominator = 'total image area (Σ bbox_area × 100)';
      occupancyCalc = `Σ bbox_area ${round4(filled)} × 100 = ${round1(clamp(0, 100, occupancy_score))}`;
    }
    occupancy_score = clamp(0, 100, occupancy_score);

    // Per-shelf occupancy audit rows: Σ facings on each shelf_index (INCLUDING
    // competitors, matching the occupancy numerator) vs that shelf's capacity.
    const shelfFacings = new Map<number, number>();
    for (const d of detected) {
      shelfFacings.set(d.shelf_index, (shelfFacings.get(d.shelf_index) || 0) + (d.facings || 0));
    }
    const occupancyRows: MethodologyRow[] = (layout.shelves || [])
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((sh) => {
        const detected_facings = shelfFacings.get(sh.index) || 0;
        const capacity = Number.isFinite(sh.capacity) ? (sh.capacity as number) : null;
        const fill_pct =
          capacity != null && capacity > 0 ? round1((detected_facings / capacity) * 100) : null;
        return {
          shelf: `Shelf ${sh.index} · ${zoneLabel(zoneFor(sh.index, shelfCount))}`,
          detected_facings,
          capacity,
          fill_pct,
        };
      });

    // ── Category rollups ──────────────────────────────────────────────
    const category_breakdown = this.buildCategoryBreakdown(detected, expected, expectedById);

    // ── Zone rollups ──────────────────────────────────────────────────
    const zone_breakdown = this.buildZoneBreakdown(detected);

    // ── Pricing ───────────────────────────────────────────────────────
    const pricing: PricingRow[] = detected
      .filter((d) => d.price != null && Number.isFinite(d.price))
      .map((d) => {
        const exp = d.sku_id ? expectedById.get(d.sku_id) : undefined;
        const expected_price = !d.is_competitor && exp?.expected_price != null ? exp.expected_price : null;
        return {
          sku_id: d.sku_id,
          sku_name: d.sku_name,
          is_competitor: d.is_competitor,
          brand: d.brand ?? null,
          price: d.price as number,
          currency: d.price_currency ?? null,
          expected_price,
          delta: expected_price != null ? round2((d.price as number) - expected_price) : null,
          source: d.price_source ?? null,
          confidence: d.confidence,
        };
      });

    // ── Promotions (pass-through) ──────────────────────────────────────
    const promotions: CompliancePromo[] = (recognition.promotions || []).map((p) => ({
      text: p.text,
      offer_type: p.offer_type,
      confidence: p.confidence,
      linked_sku_ids: p.linked_sku_ids || [],
    }));

    // ── Missing ────────────────────────────────────────────────────
    const missing_skus = expected
      .filter((e) => !detectedById.has(e.sku_id))
      .map((e) => ({
        sku_id: e.sku_id,
        sku_name: e.sku_name,
        expected_facings: e.facings,
      }));

    // ── Composite score (UNCHANGED) ───────────────────────────────────
    // Weighted: presence dominates, facings + position equal, competitor
    // share lightly penalizes if it's eating shelf space.
    const competitorPenalty = Math.max(0, competitor_share - 25); // tolerate 25%
    const score =
      0.5 * presence_score +
      0.25 * facing_score +
      0.2 * position_score -
      0.05 * competitorPenalty;
    const finalScore = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

    // ── Stock count (from image) ───────────────────────────────────────
    // Estimated on-shelf units per SKU (model's units_estimate, falling back to
    // facings when it gave none). Availability = share of expected own SKUs
    // actually on the shelf; OOS = expected own SKUs not found (the recall pass
    // treats an omission as genuinely out of stock).
    const ownDetected = detected.filter((d) => !d.is_competitor);
    const compDetected = detected.filter((d) => d.is_competitor);
    const unitsOf = (d: DetectedSKU): number =>
      typeof d.units_estimate === 'number' && d.units_estimate >= 0
        ? d.units_estimate
        : Math.max(0, d.facings || 0);
    const own_units = ownDetected.reduce((s, d) => s + unitsOf(d), 0);
    const competitor_units = compDetected.reduce((s, d) => s + unitsOf(d), 0);
    const out_of_stock_skus = expected
      .filter((e) => !detectedById.has(e.sku_id))
      .map((e) => ({ sku_id: e.sku_id, sku_name: e.sku_name }));
    const low_stock_skus = ownDetected
      .filter(
        (d) =>
          !!d.sku_id &&
          (d.stock_status === 'low' ||
            (typeof d.units_estimate === 'number' && d.units_estimate > 0 && d.units_estimate <= 2)),
      )
      .map((d) => ({
        sku_id: d.sku_id as string,
        sku_name: d.sku_name,
        units_estimate: d.units_estimate ?? null,
      }));
    const presentCount = expected.filter((e) => detectedById.has(e.sku_id)).length;
    const availability_rate = expected.length ? round1((presentCount / expected.length) * 100) : 0;
    const stock_summary: StockSummary = {
      total_units: own_units + competitor_units,
      own_units,
      competitor_units,
      availability_rate,
      oos_count: out_of_stock_skus.length,
      low_count: low_stock_skus.length,
      out_of_stock_skus,
      low_stock_skus,
    };

    // ── POSM / merchandising compliance (expected-vs-found) ────────────
    const posm = this.scorePosm(layout.expected_posm || [], recognition.posm || []);

    return {
      score: finalScore,
      presence_score: round1(presence_score),
      facing_score: round1(facing_score),
      position_score: round1(position_score),
      competitor_share: round1(competitor_share),
      occupancy_score: round1(occupancy_score),
      shelf_share_own: round1(shelf_share_own),
      shelf_share_competitor: round1(shelf_share_competitor),
      category_breakdown,
      zone_breakdown,
      pricing,
      promotions,
      stock_summary,
      posm,
      posm_score: posm.score,
      availability_rate,
      oos_count: stock_summary.oos_count,
      low_stock_count: stock_summary.low_count,
      methodology: this.buildMethodology({
        occupancyDenominator,
        occupancyCalc,
        occupancyScore: occupancy_score,
        occupancyRows,
        categoryBreakdown: category_breakdown,
        presence: {
          presentWeight,
          totalWeight,
          score: presence_score,
          rows: presenceRows,
        },
        facing: {
          penalty: facingPenalty,
          max: facingMax,
          score: facing_score,
          rows: facingRows,
        },
        position: {
          matches: positionMatches,
          total: positionTotal,
          score: position_score,
          rows: positionRows,
        },
        composite: {
          presence: presence_score,
          facing: facing_score,
          position: position_score,
          competitorShare: competitor_share,
          competitorPenalty,
          score: finalScore,
        },
        shelfShare: {
          own: ownFacings,
          competitor: competitorFacings,
          total: totalFacings,
          ownShare: shelf_share_own,
          competitorShare: shelf_share_competitor,
        },
      }),
      missing_skus,
      misplaced_skus,
      facing_deltas,
      recommendations: this.buildRecommendations({
        missing_skus,
        misplaced_skus,
        facing_deltas,
        competitor_share,
        promotions,
        expected,
      }),
    };
  }

  /**
   * POSM / merchandising compliance — compares the planogram's expected POSM
   * assets against those detected in the shelf photo. An expected asset counts
   * as "found" when a detected POSM shares its type (and brand, when the expected
   * entry names one). Score = required assets found in acceptable condition /
   * required (a damaged find counts as half). null when the planogram prescribes
   * no POSM (nothing to check).
   */
  private static scorePosm(expected: ExpectedPosm[], found: PosmDetection[]): PosmCompliance {
    const norm = (s: unknown) => String(s || '').toLowerCase().trim();
    const required = expected.filter((e) => e.required !== false);
    const findFor = (e: ExpectedPosm): PosmDetection | undefined =>
      found.find((f) => norm(f.type) === norm(e.type) && (!e.brand || norm(f.brand) === norm(e.brand)));
    const missing = required.filter((e) => !findFor(e)).map((e) => ({ type: e.type, name: e.name }));
    const damaged = found
      .filter((f) => f.condition === 'damaged')
      .map((f) => ({ type: f.type, name: f.name }));
    let score: number | null = null;
    if (required.length > 0) {
      let good = 0;
      for (const e of required) {
        const hit = findFor(e);
        if (!hit) continue;
        good += hit.condition === 'damaged' ? 0.5 : 1;
      }
      score = round1(Math.max(0, Math.min(100, (good / required.length) * 100)));
    }
    return {
      expected_count: expected.length,
      required_count: required.length,
      found_count: found.length,
      score,
      missing,
      damaged,
      found: found.map((f) => ({
        type: f.type,
        name: f.name,
        brand: f.brand ?? null,
        condition: f.condition,
        confidence: f.confidence,
      })),
    };
  }

  /**
   * Lever 2 — deterministic competitor identity resolution.
   *
   * For each competitor detection, bind it to a tracked competitor from
   * `layout.competitors` so competitors carry a STABLE sku_id/brand across
   * captures (share-of-shelf trending needs a consistent identity, not a fresh
   * name string each capture). Matching, in order:
   *   (a) exact sku_id — the model was asked to echo the competitor's sku_id;
   *   (b) normalized name/brand — case/whitespace-insensitive: an exact
   *       normalized name match, OR a brand match plus a name-contains match.
   * On a match the detection's sku_id/brand are set from the catalog entry.
   *
   * Mutates competitor detections in place ONLY. Own detections, presence,
   * facing, position and share math are untouched (they key off is_competitor
   * and own sku_ids).
   */
  private static matchCompetitors(
    detected: DetectedSKU[],
    competitors: PlanogramLayout['competitors'],
  ): void {
    if (!competitors || competitors.length === 0) return;
    const byId = new Map<string, PlanogramLayout['competitors'][number]>();
    for (const c of competitors) if (c.sku_id) byId.set(c.sku_id, c);
    const norm = (s: string | null | undefined): string =>
      (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

    for (const d of detected) {
      if (!d.is_competitor) continue;

      // (a) exact sku_id (the model may already echo the tracked competitor id).
      let match = d.sku_id ? byId.get(d.sku_id) : undefined;

      // (b) normalized name/brand fallback.
      if (!match) {
        const dn = norm(d.sku_name);
        const db = norm(d.brand);
        // Prefer an exact normalized-name match anywhere in the catalog.
        match = competitors.find((c) => {
          const cn = norm(c.sku_name);
          return !!cn && !!dn && cn === dn;
        });
        // Else brand + bidirectional name-contains; on ties pick the MOST
        // specific (longest) catalog name so same-brand variants don't collapse
        // onto the shorter one (e.g. "Veeba Mayo" vs "Veeba Mayo Chipotle").
        if (!match) {
          let best: PlanogramLayout['competitors'][number] | undefined;
          let bestLen = -1;
          for (const c of competitors) {
            const cn = norm(c.sku_name);
            if (!cn) continue;
            const cb = norm(c.brand);
            const nameHit = !!dn && (dn.includes(cn) || cn.includes(dn));
            const brandHit = !!cb && !!db && (cb === db || db.includes(cb) || cb.includes(db));
            if (nameHit && brandHit && cn.length > bestLen) {
              best = c;
              bestLen = cn.length;
            }
          }
          match = best;
        }
      }

      if (match) {
        d.sku_id = match.sku_id;
        if (match.brand) d.brand = match.brand;
      }
    }
  }

  /** Group detections + expected SKUs by category → per-category rollups. */
  private static buildCategoryBreakdown(
    detected: DetectedSKU[],
    expected: ExpectedSKU[],
    expectedById: Map<string, ExpectedSKU>,
  ): CategoryBreakdown[] {
    const catOf = (d: DetectedSKU): string =>
      d.category || (d.sku_id ? expectedById.get(d.sku_id)?.category ?? null : null) || UNCATEGORIZED;

    const totalArea = detected.reduce((s, d) => s + (d.bbox_area || 0), 0) || 1;

    type Acc = {
      facings: number;
      area: number;
      ownFacings: number;
      competitorFacings: number;
      skuIds: Set<string>;
      ownPrices: number[];
      competitorPrices: number[];
    };
    const map = new Map<string, Acc>();
    const ensure = (cat: string): Acc => {
      let a = map.get(cat);
      if (!a) {
        a = { facings: 0, area: 0, ownFacings: 0, competitorFacings: 0, skuIds: new Set(), ownPrices: [], competitorPrices: [] };
        map.set(cat, a);
      }
      return a;
    };

    // Seed categories from expected SKUs so empty-on-shelf categories still surface.
    for (const e of expected) ensure(e.category || UNCATEGORIZED);

    for (const d of detected) {
      const a = ensure(catOf(d));
      const f = d.facings || 0;
      a.facings += f;
      a.area += d.bbox_area || 0;
      a.skuIds.add(d.sku_id || d.sku_name);
      if (d.is_competitor) {
        a.competitorFacings += f;
        if (d.price != null && Number.isFinite(d.price)) a.competitorPrices.push(d.price as number);
      } else {
        a.ownFacings += f;
        if (d.price != null && Number.isFinite(d.price)) a.ownPrices.push(d.price as number);
      }
    }

    return Array.from(map.entries())
      .map(([category, a]) => {
        const catTotal = a.ownFacings + a.competitorFacings;
        return {
          category,
          occupancy: round1((a.area / totalArea) * 100),
          own_share: catTotal ? round1((a.ownFacings / catTotal) * 100) : 0,
          competitor_share: catTotal ? round1((a.competitorFacings / catTotal) * 100) : 0,
          facings: a.facings,
          sku_count: a.skuIds.size,
          avg_own_price: a.ownPrices.length ? round2(avg(a.ownPrices)) : null,
          avg_competitor_price: a.competitorPrices.length ? round2(avg(a.competitorPrices)) : null,
        };
      })
      .sort((x, y) => y.facings - x.facings);
  }

  /** Per-zone (low / eye / top) own vs competitor facing rollups. */
  private static buildZoneBreakdown(detected: DetectedSKU[]): ZoneBreakdown[] {
    type Acc = { own: number; competitor: number; skuIds: Set<string> };
    const map = new Map<ShelfZone, Acc>();
    for (const d of detected) {
      const z = (d.zone as ShelfZone) || 'eye';
      let a = map.get(z);
      if (!a) {
        a = { own: 0, competitor: 0, skuIds: new Set() };
        map.set(z, a);
      }
      const f = d.facings || 0;
      if (d.is_competitor) a.competitor += f;
      else a.own += f;
      if (d.sku_id) a.skuIds.add(d.sku_id);
    }
    const order: ShelfZone[] = ['low', 'eye', 'top'];
    return order
      .filter((z) => map.has(z))
      .map((zone) => {
        const a = map.get(zone) as Acc;
        const tot = a.own + a.competitor;
        return {
          zone,
          own_facings: a.own,
          competitor_facings: a.competitor,
          own_share: tot ? round1((a.own / tot) * 100) : 0,
          sku_ids: Array.from(a.skuIds),
        };
      });
  }

  /**
   * Document each headline metric so every number is auditable. Data-driven:
   * every entry carries the composite weight (where it applies), the computed
   * `result`, the ACTUAL arithmetic (`calc`) with this capture's real numbers,
   * and a per-SKU `columns`/`rows` audit table — so an admin can reconstruct
   * presence / facings / position / composite by hand. All the auditability
   * fields are optional, so historical rows stored with only {formula, inputs,
   * notes} still validate and render.
   */
  private static buildMethodology(m: {
    occupancyDenominator: string;
    occupancyCalc: string;
    occupancyScore: number;
    occupancyRows: MethodologyRow[];
    categoryBreakdown: CategoryBreakdown[];
    presence: { presentWeight: number; totalWeight: number; score: number; rows: MethodologyRow[] };
    facing: { penalty: number; max: number; score: number; rows: MethodologyRow[] };
    position: { matches: number; total: number; score: number; rows: MethodologyRow[] };
    composite: {
      presence: number;
      facing: number;
      position: number;
      competitorShare: number;
      competitorPenalty: number;
      score: number;
    };
    shelfShare: {
      own: number;
      competitor: number;
      total: number;
      ownShare: number;
      competitorShare: number;
    };
  }): Methodology {
    const c = m.composite;
    return {
      presence: {
        formula: 'Σ weight(expected SKUs present) / Σ weight(all expected SKUs) × 100',
        inputs: ['expected_skus.weight', 'detected_skus.sku_id'],
        notes: 'weight defaults to 1; only own (non-competitor) detections count as present.',
        weight: 0.5,
        result: round1(m.presence.score),
        calc: `present weight ${round1(m.presence.presentWeight)} / total weight ${round1(
          m.presence.totalWeight,
        )} × 100 = ${round1(m.presence.score)}`,
        columns: [
          { key: 'sku_name', label: 'SKU' },
          { key: 'weight', label: 'Weight' },
          { key: 'present', label: 'Present' },
        ],
        rows: m.presence.rows,
      },
      facing: {
        formula: '100 − (Σ |actual − expected| × weight / Σ expected × weight) × 100, floored at 0',
        inputs: ['expected_skus.facings', 'expected_skus.weight', 'detected_skus.facings'],
        weight: 0.25,
        result: round1(m.facing.score),
        calc: `100 − (Σ|Δ|×w ${round1(m.facing.penalty)} / Σ expected×w ${round1(
          m.facing.max,
        )} × 100) = ${round1(m.facing.score)}`,
        columns: [
          { key: 'sku_name', label: 'SKU' },
          { key: 'expected', label: 'Expected' },
          { key: 'detected', label: 'Detected' },
          { key: 'delta', label: 'Δ' },
          { key: 'weight', label: 'Weight' },
          { key: 'penalty', label: 'Penalty' },
        ],
        rows: m.facing.rows,
      },
      position: {
        formula: 'matched shelf_index / detected-and-expected SKUs × 100',
        inputs: ['expected_skus.shelf_index', 'detected_skus.shelf_index'],
        weight: 0.2,
        result: round1(m.position.score),
        calc: `on expected shelf ${m.position.matches} / detected SKUs ${m.position.total} × 100 = ${round1(
          m.position.score,
        )}`,
        columns: [
          { key: 'sku_name', label: 'SKU' },
          { key: 'expected_shelf', label: 'Expected shelf' },
          { key: 'actual_shelf', label: 'Actual shelf' },
          { key: 'match', label: 'On shelf' },
        ],
        rows: m.position.rows,
      },
      presence_facing_position_note: {
        formula: 'n/a',
        inputs: [],
        notes: 'presence, facing and position are the three components of the composite score.',
      },
      occupancy: {
        formula: 'Σ filled / Σ capacity × 100',
        inputs: ['detected_skus.bbox_area', 'detected_skus.facings', 'layout.shelves[].capacity', 'shelf_count'],
        notes: `denominator: ${m.occupancyDenominator}. Clamped to 0..100.`,
        result: round1(m.occupancyScore),
        calc: m.occupancyCalc,
        // Per-shelf drill-down: detected facings (own + competitor) vs capacity.
        columns: [
          { key: 'shelf', label: 'Shelf' },
          { key: 'detected_facings', label: 'Detected' },
          { key: 'capacity', label: 'Capacity' },
          { key: 'fill_pct', label: 'Fill %' },
        ],
        rows: m.occupancyRows,
      },
      shelf_share: {
        formula: 'own or competitor facings / total detected facings × 100',
        inputs: ['detected_skus.facings', 'detected_skus.is_competitor'],
        notes: 'competitor_share is retained and equals shelf_share_competitor.',
        result: round1(m.shelfShare.ownShare),
        calc: `own ${round1(m.shelfShare.own)} / total ${round1(m.shelfShare.total)} × 100 = ${round1(
          m.shelfShare.ownShare,
        )}% (competitor ${round1(m.shelfShare.competitorShare)}%)`,
        // Own vs competitor drill-down.
        columns: [
          { key: 'group', label: 'Brand' },
          { key: 'facings', label: 'Facings' },
          { key: 'share_pct', label: 'Share %' },
        ],
        rows: [
          { group: 'Own', facings: m.shelfShare.own, share_pct: round1(m.shelfShare.ownShare) },
          {
            group: 'Competitors',
            facings: m.shelfShare.competitor,
            share_pct: round1(m.shelfShare.competitorShare),
          },
        ],
      },
      category: {
        formula: 'per-category facings and own/competitor share of that category',
        inputs: ['detected_skus.category', 'detected_skus.facings', 'detected_skus.is_competitor'],
        notes:
          'category is resolved from the detection category, else the matched expected-SKU category, else Uncategorized. Own/competitor % are within each category (own or competitor facings / that category\'s total facings).',
        // Per-category drill-down; no single headline result.
        columns: [
          { key: 'category', label: 'Category' },
          { key: 'facings', label: 'Facings' },
          { key: 'sku_count', label: 'SKUs' },
          { key: 'own_share', label: 'Own %' },
          { key: 'competitor_share', label: 'Competitor %' },
        ],
        rows: m.categoryBreakdown.map((c) => ({
          category: c.category,
          facings: c.facings,
          sku_count: c.sku_count,
          own_share: round1(c.own_share),
          competitor_share: round1(c.competitor_share),
        })),
      },
      zone: {
        formula: 'zone assigned by shelf_index vs shelf_count: bottom third → low, middle → eye, top → top',
        inputs: ['detected_skus.shelf_index', 'shelf_count'],
        notes: 'zone is computed by the backend; the model hint is ignored. A single-shelf image is treated as eye.',
      },
      composite: {
        formula: '0.5·presence + 0.25·facing + 0.2·position − 0.05·max(0, competitor_share − 25), clamped 0..100',
        inputs: ['presence_score', 'facing_score', 'position_score', 'competitor_share'],
        notes:
          'Occupancy and shelf-share are reported alongside but NOT folded into the composite; competitor share is tolerated up to 25% before it penalizes.',
        result: round1(c.score),
        calc: `0.5×${round1(c.presence)} + 0.25×${round1(c.facing)} + 0.2×${round1(
          c.position,
        )} − 0.05×${round1(c.competitorPenalty)} = ${round1(c.score)}`,
        columns: [
          { key: 'component', label: 'Component' },
          { key: 'value', label: 'Score' },
          { key: 'weight', label: 'Weight' },
          { key: 'contribution', label: 'Contribution' },
        ],
        rows: [
          { component: 'Presence', value: round1(c.presence), weight: 0.5, contribution: round1(0.5 * c.presence) },
          { component: 'Facings', value: round1(c.facing), weight: 0.25, contribution: round1(0.25 * c.facing) },
          { component: 'Position', value: round1(c.position), weight: 0.2, contribution: round1(0.2 * c.position) },
          {
            component: 'Competitor penalty',
            value: round1(c.competitorShare),
            weight: -0.05,
            contribution: round1(-0.05 * c.competitorPenalty),
          },
        ],
      },
    };
  }

  /** Prioritized "what to fix" list. */
  private static buildRecommendations(input: {
    missing_skus: ComplianceResult['missing_skus'];
    misplaced_skus: ComplianceResult['misplaced_skus'];
    facing_deltas: ComplianceResult['facing_deltas'];
    competitor_share: number;
    promotions: CompliancePromo[];
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

    // Promotions covering a missing / under-faced own SKU are an execution
    // opportunity — the offer is live but the product is absent or thin.
    const gapSkus = new Map<string, string>(); // sku_id → sku_name
    for (const m of input.missing_skus) gapSkus.set(m.sku_id, m.sku_name);
    for (const d of input.facing_deltas) if (d.delta < 0) gapSkus.set(d.sku_id, d.sku_name);
    for (const p of input.promotions) {
      const covered = (p.linked_sku_ids || []).filter((id) => gapSkus.has(id));
      if (covered.length) {
        const names = covered.map((id) => gapSkus.get(id)).filter(Boolean).join(', ');
        recs.push({
          priority: 'high',
          action: `Promo "${p.text}" is live but ${names} is missing/under-faced — restock to capture the offer`,
          rationale: 'An active promotion on an absent or thin SKU wastes promo spend and shopper demand.',
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
      .select('id, layout, expected_skus, expected_posm')
      .eq('id', planogramId)
      .single();
    if (error || !data) {
      throw new AppError(404, 'Planogram not found', 'NOT_FOUND');
    }
    return {
      shelves: data.layout?.shelves || [],
      expected_skus: data.expected_skus || [],
      competitors: Array.isArray(data.layout?.competitors) ? data.layout.competitors : [],
      tiling: data.layout?.tiling === true,
      expected_posm: Array.isArray(data.expected_posm) ? data.expected_posm : [],
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
   * Org-level fallback planogram: the most recently updated ACTIVE planogram for
   * the org. Used for captures that carry no store and no explicit planogram_id
   * (e.g. the MoiSoi free trial, where reps use on-device outlets with no server
   * store to assign a planogram to) so the audit still has a layout to score
   * against. Org-scoped, so it never crosses tenants. Returns null if the org has
   * no active planogram.
   */
  static async resolveDefaultPlanogramForOrg(orgId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('planograms')
      .select('id')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1);
    return data?.[0]?.id ?? null;
  }

  /** Max reference pack shots to fetch per capture (keeps token cost bounded). */
  private static readonly MAX_REFERENCE_IMAGES = 32;

  /**
   * Collect front-facing reference pack shots for a planogram's expected SKUs
   * and tracked competitors (`ref_image_url` on each), fetch + base64 them, and
   * shape them for the vision call. Best-effort: any missing/unreachable/oversized
   * image is skipped, so a bad URL never blocks a capture. Returns `undefined`
   * when there are no usable references (keeps the request identical to before).
   */
  private static async loadReferenceImages(
    layout: PlanogramLayout,
  ): Promise<RecognizeArgs['referenceImages']> {
    const entries: Array<{ sku_id: string; sku_name: string; url: string; is_competitor: boolean }> = [];
    // Primary pack-shots first (own then competitor) so every SKU's canonical
    // reference is kept before the bound crowds any of them out …
    for (const e of layout.expected_skus || []) {
      if (e.ref_image_url) entries.push({ sku_id: e.sku_id, sku_name: e.sku_name, url: e.ref_image_url, is_competitor: false });
    }
    for (const c of layout.competitors || []) {
      if (c.ref_image_url) entries.push({ sku_id: c.sku_id, sku_name: c.sku_name, url: c.ref_image_url, is_competitor: true });
    }
    // … then confirmed-crop extras (own then competitor), so the self-improving
    // library of confirmed detections also feeds recognition.
    for (const e of layout.expected_skus || []) {
      for (const u of e.additional_ref_urls || []) {
        if (u) entries.push({ sku_id: e.sku_id, sku_name: e.sku_name, url: u, is_competitor: false });
      }
    }
    for (const c of layout.competitors || []) {
      for (const u of c.additional_ref_urls || []) {
        if (u) entries.push({ sku_id: c.sku_id, sku_name: c.sku_name, url: u, is_competitor: true });
      }
    }
    const bounded = entries.slice(0, this.MAX_REFERENCE_IMAGES);

    const out: NonNullable<RecognizeArgs['referenceImages']> = [];
    for (const en of bounded) {
      try {
        const img = await this.fetchImageAsBase64(en.url);
        if (img) {
          out.push({
            sku_id: en.sku_id,
            sku_name: en.sku_name,
            imageBase64: img.base64,
            imageMediaType: img.mediaType,
            is_competitor: en.is_competitor,
          });
        }
      } catch {
        /* unreachable reference — skip, never block the capture */
      }
    }
    return out.length ? out : undefined;
  }

  private static mediaTypeFor(hint: string): 'image/jpeg' | 'image/png' | 'image/webp' {
    const h = hint.toLowerCase();
    return h.includes('png') ? 'image/png' : h.includes('webp') ? 'image/webp' : 'image/jpeg';
  }

  /**
   * Read a reference pack image bundled with the API (public/planogram-refs,
   * served at /assets/planogram-refs) straight off local disk. Reference URLs
   * that point at our own asset path resolve here instead of a self-HTTP fetch,
   * so recognition never depends on the API being able to reach its own public
   * hostname (self-fetch / hairpin) — the demo's reference images always load.
   * Returns null when the URL isn't one of ours (→ fall back to a real fetch).
   */
  private static readLocalReferenceImage(
    url: string,
  ): { base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' } | null {
    const m = url.match(/\/assets\/planogram-refs\/([A-Za-z0-9._-]+)$/);
    if (!m) return null;
    const file = path.join(process.cwd(), 'public', 'planogram-refs', m[1]);
    try {
      const buf = fs.readFileSync(file);
      if (buf.length === 0 || buf.length > 4_000_000) return null;
      return { base64: buf.toString('base64'), mediaType: this.mediaTypeFor(path.extname(file)) };
    } catch {
      return null; // not bundled — let the caller try the network
    }
  }

  /** Public bucket (per project) that holds field-rep shelf capture photos. */
  private static readonly CAPTURE_BUCKET = process.env.BUCKET_PLANOGRAM_CAPTURES || 'planogram-captures';

  /**
   * Public bucket that holds reference pack-shots — the SAME bucket the
   * dashboard uploads brand pack-shots to via POST /api/v1/upload/planogram_ref
   * (see upload.controller BUCKET_MAP.planogram_ref). Confirmed-detection crops
   * are uploaded here so they load identically to hand-uploaded references.
   */
  private static readonly REFERENCE_BUCKET = process.env.BUCKET_PLANOGRAM_REFS || 'planogram-refs';

  /** Ensure a bucket exists and is public (self-provision on first use). */
  private static async ensurePublicBucket(bucket: string): Promise<void> {
    const { data } = await supabaseAdmin.storage.getBucket(bucket);
    if (data) {
      if (!data.public) await supabaseAdmin.storage.updateBucket(bucket, { public: true });
      return;
    }
    const { error } = await supabaseAdmin.storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: 15 * 1024 * 1024,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    });
    if (error && !/exist/i.test(error.message)) throw error;
  }

  /**
   * Persist the shelf photo into THIS capture's own project (a public bucket),
   * from the base64 the client already sent. The app also uploads the photo via
   * /upload separately, but that call can land in the wrong project (its request
   * may resolve to the default tenant), leaving the capture row pointing at a
   * photo the viewing project can't read — a blank image in history. Storing it
   * here guarantees the photo lives with the capture and renders (public URL).
   * Best-effort: returns null on any failure so the caller falls back.
   */
  private static async storeCaptureImage(
    orgId: string,
    base64: string,
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  ): Promise<string | null> {
    try {
      await this.ensurePublicBucket(this.CAPTURE_BUCKET);
      const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
      const key = `${orgId}/${randomUUID()}.${ext}`;
      const buf = Buffer.from(base64, 'base64');
      if (!buf.length) return null;
      const { error } = await supabaseAdmin.storage
        .from(this.CAPTURE_BUCKET)
        .upload(key, buf, { contentType: mediaType, upsert: false });
      if (error) return null;
      const { data } = supabaseAdmin.storage.from(this.CAPTURE_BUCKET).getPublicUrl(key);
      return data?.publicUrl || null;
    } catch {
      return null;
    }
  }

  /** Fetch an image URL and return base64 + a supported media type, or null. */
  private static async fetchImageAsBase64(
    url: string,
  ): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' } | null> {
    const local = this.readLocalReferenceImage(url);
    if (local) return local;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 4_000_000) return null; // skip empty / oversized refs
    return { base64: buf.toString('base64'), mediaType: this.mediaTypeFor(res.headers.get('content-type') || '') };
  }

  /**
   * Fetch an image URL into a raw Buffer (local bundled asset OR remote), with a
   * generous size cap suitable for full-resolution capture photos. Unlike
   * fetchImageAsBase64 (tuned for small pack-shots) this tolerates larger shelf
   * captures so the confirm-crop flow can read the original photo. Returns null
   * on any failure so the caller can respond cleanly.
   */
  private static async fetchImageBuffer(
    url: string,
    maxBytes = 20_000_000,
  ): Promise<Buffer | null> {
    const local = this.readLocalReferenceImage(url);
    if (local) return Buffer.from(local.base64, 'base64');
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > maxBytes) return null;
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Crop a normalized [x, y, w, h] (0..1) region out of an image buffer with
   * `sharp`, clamping the box to the real pixel bounds. Returns a JPEG buffer, or
   * null if the region degenerates. `sharp` is imported lazily so a missing
   * native binary surfaces as a clean error rather than a process-level crash.
   */
  private static async cropNormalizedRegion(
    src: Buffer,
    bbox: [number, number, number, number],
  ): Promise<Buffer | null> {
    let sharp: (typeof import('sharp'))['default'];
    try {
      sharp = (await import('sharp')).default;
    } catch (e) {
      throw new AppError(500, 'Image processing unavailable (sharp not installed)', 'SHARP_UNAVAILABLE');
    }
    const meta = await sharp(src).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return null;
    const [x, y, w, h] = bbox;
    // normalized → pixels, clamped so extract() never reads outside the image.
    const left = Math.round(clamp(0, W - 1, x * W));
    const top = Math.round(clamp(0, H - 1, y * H));
    const width = Math.round(clamp(0, W - left, w * W));
    const height = Math.round(clamp(0, H - top, h * H));
    if (width < 1 || height < 1) return null; // degenerate box → 422 CROP_FAILED
    return sharp(src).extract({ left, top, width, height }).jpeg({ quality: 90 }).toBuffer();
  }

  /**
   * Upload a cropped reference JPEG into the reference pack-shot bucket (public)
   * and return its fetchable URL. Same bucket + public-URL mechanism the
   * dashboard's pack-shot upload uses, so recognition loads it with a plain GET.
   */
  private static async uploadReferenceCrop(orgId: string, buffer: Buffer): Promise<string | null> {
    try {
      await this.ensurePublicBucket(this.REFERENCE_BUCKET);
      const key = `${orgId}/confirmed/${randomUUID()}.jpg`;
      const { error } = await supabaseAdmin.storage
        .from(this.REFERENCE_BUCKET)
        .upload(key, buffer, { contentType: 'image/jpeg', upsert: false });
      if (error) return null;
      const { data } = supabaseAdmin.storage.from(this.REFERENCE_BUCKET).getPublicUrl(key);
      return data?.publicUrl || null;
    } catch {
      return null;
    }
  }

  /**
   * Confirm-crop-as-reference (self-improving library).
   *
   * A confirmed detection on a capture becomes a NEW reference pack-shot for that
   * SKU: load the capture photo, crop the given normalized bbox, upload the crop
   * to the reference bucket, append its URL to the SKU's `additional_ref_urls`
   * inside the planogram's `expected_skus` (own) or `layout.competitors`
   * (competitor) jsonb, and persist. The crop then feeds every future capture via
   * loadReferenceImages. Org-scoped like the other planogram routes.
   */
  static async confirmDetectionAsReference(args: {
    orgId: string;
    captureId: string;
    skuId: string;
    bbox: [number, number, number, number];
  }): Promise<{ ref_image_url: string }> {
    // 1. Capture (org-scoped) → its planogram + stored photo.
    const { data: cap, error: capErr } = await supabaseAdmin
      .from('planogram_captures')
      .select('id, org_id, planogram_id, image_url')
      .eq('id', args.captureId)
      .eq('org_id', args.orgId)
      .single();
    if (capErr || !cap) throw new AppError(404, 'Capture not found', 'NOT_FOUND');
    if (!cap.planogram_id) throw new AppError(400, 'Capture is not linked to a planogram', 'NO_PLANOGRAM');
    if (!cap.image_url) throw new AppError(422, 'Capture has no stored image to crop', 'IMAGE_UNAVAILABLE');

    // 2. Planogram row (org-scoped) — need the jsonb we will mutate + persist.
    const { data: pg, error: pgErr } = await supabaseAdmin
      .from('planograms')
      .select('id, layout, expected_skus')
      .eq('id', cap.planogram_id)
      .eq('org_id', args.orgId)
      .single();
    if (pgErr || !pg) throw new AppError(404, 'Planogram not found', 'NOT_FOUND');

    const expected_skus: ExpectedSKU[] = Array.isArray(pg.expected_skus) ? pg.expected_skus : [];
    const layout: any = pg.layout && typeof pg.layout === 'object' ? pg.layout : {};
    const competitors: PlanogramLayout['competitors'] = Array.isArray(layout.competitors)
      ? layout.competitors
      : [];

    // 3. Validate the sku_id belongs to this planogram (own or tracked competitor).
    const ownIdx = expected_skus.findIndex((s) => s.sku_id === args.skuId);
    const compIdx = ownIdx >= 0 ? -1 : competitors.findIndex((c) => c.sku_id === args.skuId);
    if (ownIdx < 0 && compIdx < 0) {
      throw new AppError(404, `sku_id "${args.skuId}" is not on this planogram`, 'SKU_NOT_FOUND');
    }

    // 4. Load the capture photo and crop the confirmed region.
    const src = await this.fetchImageBuffer(cap.image_url);
    if (!src) throw new AppError(422, 'Could not load the capture image to crop', 'IMAGE_UNAVAILABLE');
    const crop = await this.cropNormalizedRegion(src, args.bbox);
    if (!crop) throw new AppError(422, 'Crop region is empty after clamping to the image', 'CROP_FAILED');

    // 5. Upload the crop to the reference bucket (public, fetchable URL).
    const ref_image_url = await this.uploadReferenceCrop(args.orgId, crop);
    if (!ref_image_url) throw new AppError(500, 'Failed to store the cropped reference', 'UPLOAD_FAILED');

    // 6. Append to the SKU's additional_ref_urls and persist the mutated jsonb.
    if (ownIdx >= 0) {
      const cur = Array.isArray(expected_skus[ownIdx].additional_ref_urls)
        ? (expected_skus[ownIdx].additional_ref_urls as string[])
        : [];
      expected_skus[ownIdx] = { ...expected_skus[ownIdx], additional_ref_urls: [...cur, ref_image_url] };
      const { error: upErr } = await supabaseAdmin
        .from('planograms')
        .update({ expected_skus, updated_at: new Date().toISOString() })
        .eq('id', pg.id)
        .eq('org_id', args.orgId);
      if (upErr) throw new AppError(500, upErr.message, 'DB_ERROR');
    } else {
      const cur = Array.isArray(competitors[compIdx].additional_ref_urls)
        ? (competitors[compIdx].additional_ref_urls as string[])
        : [];
      competitors[compIdx] = { ...competitors[compIdx], additional_ref_urls: [...cur, ref_image_url] };
      const { error: upErr } = await supabaseAdmin
        .from('planograms')
        .update({ layout: { ...layout, competitors }, updated_at: new Date().toISOString() })
        .eq('id', pg.id)
        .eq('org_id', args.orgId);
      if (upErr) throw new AppError(500, upErr.message, 'DB_ERROR');
    }

    return { ref_image_url };
  }

  // ── Shared analysis / persistence helpers ────────────────────────────────
  //
  // Extracted so both the live capture pipeline (processCapture) and the
  // on-demand re-analysis (reprocessCapture) build the SAME recognition /
  // compliance rows and apply the SAME quality gate — a green typecheck on one
  // path shouldn't let the other drift.

  /**
   * Lever 3 — quality gate (flag only; never reject the capture). Flags a
   * capture for human review when it is likely unreliable, but always leaves it
   * (and its scores) persisted. Thresholds:
   *   • QUALITY_MIN 0.4  — blur/glare/angle are 0..1 (1 = best); below 0.4 the
   *     image is degraded enough that recognition may be wrong (the same 0.4
   *     floor recognizeShelf uses for blur/glare; angle is added here).
   *   • LOW_CONFIDENCE 0.6 — overall recognition confidence floor.
   *   • HIGH_MISS_RATE 0.5 — >50% of expected SKUs still absent AFTER the
   *     second-pass recall suggests a bad capture (or a truly empty shelf)
   *     rather than a few genuine gaps.
   * Only image-quality problems earn the "Re-shoot capture" action; miss-rate
   * and low-confidence just raise needs_review (re-shooting won't fix an empty
   * shelf or an inherently hard scene). Mutates `recognition.needs_review` and
   * may prepend a recommendation to `result`.
   */
  private static applyQualityGate(
    recognition: ShelfRecognition,
    result: ComplianceResult,
    layout: PlanogramLayout,
  ): void {
    const QUALITY_MIN = 0.4;
    const LOW_CONFIDENCE = 0.6;
    const HIGH_MISS_RATE = 0.5;
    const q = recognition.quality;
    const lowQuality =
      q.blur_score < QUALITY_MIN || q.glare_score < QUALITY_MIN || q.angle_score < QUALITY_MIN;
    const expectedCount = (layout.expected_skus || []).length;
    const missRate = expectedCount ? result.missing_skus.length / expectedCount : 0;
    const highMiss = expectedCount > 0 && missRate > HIGH_MISS_RATE;
    const lowConfidence = recognition.overall_confidence < LOW_CONFIDENCE;

    if (lowQuality || highMiss || lowConfidence) {
      recognition.needs_review = true;
    }
    if (lowQuality) {
      result.recommendations.unshift({
        priority: 'high',
        action: 'Re-shoot capture',
        rationale: 'Image quality low (blur/glare/angle) — recognition may be unreliable',
      });
    }
  }

  /** Build the `planogram_recognition` row payload for a capture (insert or update). */
  private static recognitionRow(captureId: string, orgId: string, recognition: ShelfRecognition) {
    return {
      capture_id: captureId,
      org_id: orgId,
      detected_skus: recognition.detected_skus,
      promotions: recognition.promotions,
      posm: recognition.posm,
      shelf_map: { shelf_count: recognition.shelf_count },
      overall_confidence: recognition.overall_confidence,
      model_versions: { vision: recognition.model_version },
      needs_review: recognition.needs_review,
    };
  }

  /**
   * The scored metric columns of a `planogram_compliance` row (everything the
   * engine computes) — WITHOUT the identity columns (org/client/capture/
   * planogram/store/fe) which never change on a re-score. Used both for the
   * initial insert (spread alongside the identity columns) and for in-place
   * updates by reprocess / the bulk re-score.
   */
  private static complianceScoreFields(result: ComplianceResult) {
    return {
      score: result.score,
      presence_score: result.presence_score,
      facing_score: result.facing_score,
      position_score: result.position_score,
      competitor_share: result.competitor_share,
      occupancy_score: result.occupancy_score,
      shelf_share_own: result.shelf_share_own,
      shelf_share_competitor: result.shelf_share_competitor,
      category_breakdown: result.category_breakdown,
      zone_breakdown: result.zone_breakdown,
      pricing: result.pricing,
      promotions: result.promotions,
      stock_summary: result.stock_summary,
      posm: result.posm,
      posm_score: result.posm_score,
      availability_rate: result.availability_rate,
      oos_count: result.oos_count,
      low_stock_count: result.low_stock_count,
      methodology: result.methodology,
      missing_skus: result.missing_skus,
      misplaced_skus: result.misplaced_skus,
      facing_deltas: result.facing_deltas,
      recommendations: result.recommendations,
    };
  }

  /**
   * UPSERT the recognition row for a capture: update in place if one already
   * exists (the reprocess case), else insert. Manual select-then-write (rather
   * than PostgREST `.upsert`) so it never depends on a DB unique constraint on
   * capture_id that we can't verify here.
   */
  private static async upsertRecognition(
    captureId: string,
    orgId: string,
    recognition: ShelfRecognition,
  ): Promise<void> {
    const row = this.recognitionRow(captureId, orgId, recognition);
    const { data: existing } = await supabaseAdmin
      .from('planogram_recognition')
      .select('id')
      .eq('capture_id', captureId)
      .maybeSingle();
    if (existing?.id) {
      const { error } = await supabaseAdmin
        .from('planogram_recognition')
        .update(row)
        .eq('id', existing.id);
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
    } else {
      const { error } = await supabaseAdmin.from('planogram_recognition').insert(row);
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
    }
  }

  /**
   * UPSERT the compliance row for a capture: update the metric columns in place
   * if a row exists (the reprocess case), else insert a full row. Same manual
   * select-then-write approach as upsertRecognition.
   */
  private static async upsertCompliance(args: {
    orgId: string;
    clientId?: string | null;
    captureId: string;
    planogramId: string;
    storeId?: string | null;
    feId: string;
    result: ComplianceResult;
  }): Promise<void> {
    const fields = this.complianceScoreFields(args.result);
    const { data: existing } = await supabaseAdmin
      .from('planogram_compliance')
      .select('id')
      .eq('capture_id', args.captureId)
      .eq('org_id', args.orgId)
      .maybeSingle();
    if (existing?.id) {
      const { error } = await supabaseAdmin
        .from('planogram_compliance')
        .update(fields)
        .eq('id', existing.id);
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
    } else {
      const { error } = await supabaseAdmin.from('planogram_compliance').insert({
        org_id: args.orgId,
        client_id: args.clientId ?? null,
        capture_id: args.captureId,
        planogram_id: args.planogramId,
        store_id: args.storeId ?? null,
        fe_id: args.feId,
        ...fields,
      });
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
    }
  }

  /**
   * Fetch a STORED capture photo (local bundled asset OR remote) as base64 + a
   * supported media type for a re-analysis vision call. Uses the larger cap
   * suitable for full-resolution shelf photos (fetchImageAsBase64's 4MB cap is
   * tuned for small pack-shots and would reject most captures). Media type is
   * taken from the response content-type, falling back to the URL extension.
   * Returns null on any failure so the caller can respond cleanly (422).
   */
  private static async fetchCaptureImageForVision(
    url: string,
  ): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' } | null> {
    const local = this.readLocalReferenceImage(url);
    if (local) return local;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > 20_000_000) return null;
      const ct = res.headers.get('content-type') || '';
      return { base64: buf.toString('base64'), mediaType: this.mediaTypeFor(ct || url) };
    } catch {
      return null;
    }
  }

  /**
   * On-demand RE-ANALYSIS of a single existing capture (the dashboard's
   * "Re-analyze" button). Re-runs the FULL pipeline — recognition (vision) →
   * score → quality gate — on the capture's STORED photo + its planogram layout,
   * then UPSERTs the recognition + compliance rows (update in place if present,
   * else insert). Org-scoped: a capture outside `orgId` 404s.
   *
   * The vision call is wrapped so a failure returns 502 and leaves the existing
   * recognition / compliance rows UNTOUCHED (nothing is written until scoring
   * succeeds). Returns the same shape as GET /captures/:id.
   */
  static async reprocessCapture(args: {
    orgId: string;
    captureId: string;
  }): Promise<{ capture: any; recognition: any; compliance: any }> {
    // 1. Load the capture (org-scoped). Same joins as GET /captures/:id so the
    //    returned `capture` matches that endpoint's shape.
    const { data: cap, error } = await supabaseAdmin
      .from('planogram_captures')
      .select('*, fe:users!fe_id(name), store:stores!store_id(name), planogram:planograms!planogram_id(name)')
      .eq('id', args.captureId)
      .eq('org_id', args.orgId)
      .single();
    if (error || !cap) throw new AppError(404, 'Capture not found', 'NOT_FOUND');
    if (!cap.image_url) {
      throw new AppError(422, 'Capture has no stored image to re-analyze', 'IMAGE_UNAVAILABLE');
    }

    // 2. Resolve the planogram (prefer the capture's own; else the store's active).
    let planogramId: string | null = cap.planogram_id ?? null;
    if (!planogramId && cap.store_id) {
      planogramId = await this.resolvePlanogramForStore(args.orgId, cap.store_id);
    }
    if (!planogramId) {
      throw new AppError(400, 'Capture is not linked to a planogram', 'NO_PLANOGRAM');
    }
    const layout = await this.loadPlanogramLayout(planogramId);

    // 3. Load the stored photo for the vision call (larger cap for real captures).
    const img = await this.fetchCaptureImageForVision(cap.image_url);
    if (!img) {
      throw new AppError(422, 'Could not load the stored capture image', 'IMAGE_UNAVAILABLE');
    }

    // 4. Store format (calibrates dense MT vs sparse GT), same as processCapture.
    let storeFormat: string | undefined;
    if (cap.store_id) {
      const { data: st } = await supabaseAdmin
        .from('stores')
        .select('store_type')
        .eq('id', cap.store_id)
        .maybeSingle();
      storeFormat = (st as { store_type?: string } | null)?.store_type || undefined;
    }

    // 5. Re-run vision — GUARDED. On failure return 502 and write NOTHING, so
    //    the existing recognition / compliance rows are never corrupted.
    const referenceImages = await this.loadReferenceImages(layout);
    let recognition: ShelfRecognition;
    try {
      recognition = await PlanogramVisionService.recognizeShelf({
        imageBase64: img.base64,
        imageMediaType: img.mediaType,
        expectedSkus: layout.expected_skus.map((s) => ({
          sku_id: s.sku_id,
          sku_name: s.sku_name,
          brand: s.brand ?? undefined,
          category: s.category ?? undefined,
        })),
        competitorSkus: (layout.competitors || []).map((c) => ({
          sku_id: c.sku_id,
          sku_name: c.sku_name,
          brand: c.brand,
          category: c.category ?? undefined,
        })),
        storeFormat,
        referenceImages,
        tiling: layout.tiling === true,
      });
    } catch (e: any) {
      logger.warn(`[planogram] reprocess vision failed for capture ${args.captureId}: ${e?.message || e}`);
      throw new AppError(
        502,
        'Vision re-analysis failed; the existing analysis was left unchanged',
        'VISION_FAILED',
      );
    }

    // 6. Score + quality gate (deterministic).
    const result = this.scoreShelf({ recognition, layout });
    this.applyQualityGate(recognition, result, layout);

    // 7. UPSERT recognition + compliance for this capture.
    await this.upsertRecognition(args.captureId, args.orgId, recognition);
    await this.upsertCompliance({
      orgId: args.orgId,
      clientId: cap.client_id ?? null,
      captureId: args.captureId,
      planogramId,
      storeId: cap.store_id ?? null,
      feId: cap.fe_id,
      result,
    });

    // 8. Return the freshly-written rows in the GET /captures/:id shape.
    const { data: rec } = await supabaseAdmin
      .from('planogram_recognition')
      .select('*')
      .eq('capture_id', args.captureId)
      .single();
    const { data: comp } = await supabaseAdmin
      .from('planogram_compliance')
      .select('*')
      .eq('capture_id', args.captureId)
      .single();
    return { capture: cap, recognition: rec, compliance: comp };
  }

  /**
   * Bulk deterministic re-score (cheap backfill, NO vision). Upgrades captures
   * whose compliance is stale / pre-v2 to the v2 metrics they can derive from
   * the detections ALREADY stored on their recognition row — occupancy,
   * shelf-share, zone/category rollups, pricing/promotions and the full
   * methodology — by re-running the pure `scoreShelf` from the existing
   * `recognition.detected_skus` + planogram layout. No AI, no image fetch.
   *
   * "Stale / pre-v2" predicate: `occupancy_score IS NULL OR methodology =
   * '{}'::jsonb`. Both columns were added by the SAME v2 migration
   * (planogram_v2_metrics.sql) with occupancy nullable and methodology
   * defaulting to '{}', so every pre-v2 compliance row matches. Only rows that
   * HAVE a recognition row are recomputable; the rest are skipped (they stay
   * stale and remain in `remaining`). Idempotent — a re-scored row is no longer
   * stale, so re-running only ever picks up rows not yet upgraded.
   *
   * Processes up to `limit` per call and returns `{ processed, remaining }`.
   */
  static async rescoreStaleCompliance(args: { limit: number }): Promise<{
    processed: number;
    remaining: number;
  }> {
    const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
    // Pre-v2 compliance is reliably identified by occupancy_score IS NULL — the
    // column was added in the v2 migration, so every pre-v2 row is null. We do
    // NOT also test methodology.eq.{}: it's redundant, and the unquoted {} is
    // fragile to parse inside a PostgREST filter. We also require a non-null
    // planogram_id so the sweep only ever selects recomputable rows (a row with
    // no layout can never be scored and must not wedge the resumable page).
    const STALE_OR = 'occupancy_score.is.null';

    // Total stale rows (for `remaining`). head:true → count only, no bodies.
    const { count: totalStale } = await supabaseAdmin
      .from('planogram_compliance')
      .select('id', { count: 'exact', head: true })
      .or(STALE_OR)
      .not('planogram_id', 'is', null);

    // A page of stale rows. Ordered by id for a stable, resumable sweep.
    const { data: staleRows, error } = await supabaseAdmin
      .from('planogram_compliance')
      .select('id, capture_id, planogram_id')
      .or(STALE_OR)
      .not('planogram_id', 'is', null)
      .order('id', { ascending: true })
      .limit(limit);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');

    const rows = (staleRows || []) as Array<{
      id: string;
      capture_id: string;
      planogram_id: string | null;
    }>;
    if (rows.length === 0) return { processed: 0, remaining: totalStale ?? 0 };

    // The stored detections for these captures — only rows WITH a recognition
    // row are recomputable (no vision here). Fetched in one round-trip.
    const captureIds = rows.map((r) => r.capture_id).filter(Boolean);
    const recByCapture = new Map<string, any>();
    if (captureIds.length) {
      const { data: recs } = await supabaseAdmin
        .from('planogram_recognition')
        .select('capture_id, detected_skus, promotions, shelf_map, overall_confidence, needs_review, model_versions')
        .in('capture_id', captureIds);
      for (const r of (recs || []) as any[]) recByCapture.set(r.capture_id as string, r);
    }

    // Cache layouts so N captures on one planogram load it once.
    const layoutCache = new Map<string, PlanogramLayout>();
    const loadLayout = async (pid: string): Promise<PlanogramLayout> => {
      let l = layoutCache.get(pid);
      if (!l) {
        l = await this.loadPlanogramLayout(pid);
        layoutCache.set(pid, l);
      }
      return l;
    };

    let processed = 0;
    for (const row of rows) {
      try {
        if (!row.planogram_id) continue; // can't score without a layout
        const rec = recByCapture.get(row.capture_id);
        if (!rec) continue; // no stored detections → nothing to recompute from
        const layout = await loadLayout(row.planogram_id);

        // Rebuild the minimal ShelfRecognition scoreShelf needs (it reads only
        // detected_skus / shelf_count / promotions; quality/confidence are unused
        // by the pure scorer, so neutral values are fine).
        const recognition: ShelfRecognition = {
          detected_skus: Array.isArray(rec.detected_skus) ? rec.detected_skus : [],
          promotions: Array.isArray(rec.promotions) ? rec.promotions : [],
          posm: Array.isArray(rec.posm) ? rec.posm : [],
          shelf_count: Number(rec.shelf_map?.shelf_count) || 0,
          overall_confidence: Number(rec.overall_confidence) || 0,
          needs_review: rec.needs_review === true,
          quality: { angle_score: 1, blur_score: 1, glare_score: 1 },
          model_version: (rec.model_versions?.vision as string) || '',
        };

        const result = this.scoreShelf({ recognition, layout });

        const { error: upErr } = await supabaseAdmin
          .from('planogram_compliance')
          .update(this.complianceScoreFields(result))
          .eq('id', row.id);
        if (upErr) throw new Error(upErr.message);
        processed += 1;
      } catch (e: any) {
        logger.warn(`[planogram] rescore failed for capture ${row.capture_id}: ${e?.message || e}`);
      }
    }

    const remaining = Math.max(0, (totalStale ?? processed) - processed);
    return { processed, remaining };
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
    // Fallback for storeless / unassigned captures (e.g. the MoiSoi free trial,
    // where reps use on-device outlets with no server store): use the org's
    // active planogram so the audit still has a layout. Org-scoped, so tenants
    // that always pass a store/planogram (Tata, …) are unaffected.
    if (!planogramId) {
      planogramId = await this.resolveDefaultPlanogramForOrg(args.orgId);
    }
    if (!planogramId) {
      throw new AppError(
        400,
        'No active planogram for this store. Provide planogram_id or assign one to the store.',
        'NO_PLANOGRAM',
      );
    }

    const layout = await this.loadPlanogramLayout(planogramId);

    // Pass the store's trade format (modern_trade / general_trade / …) so the
    // model calibrates for dense MT shelves vs sparse GT ones.
    let storeFormat: string | undefined;
    if (args.storeId) {
      const { data: st } = await supabaseAdmin
        .from('stores')
        .select('store_type')
        .eq('id', args.storeId)
        .maybeSingle();
      storeFormat = (st as { store_type?: string } | null)?.store_type || undefined;
    }

    // Front-facing reference pack shots (from expected_skus[].ref_image_url and
    // competitors[].ref_image_url), fetched + base64'd, so the model matches
    // look-alike variants/sizes and competitor packs by packaging. Best-effort:
    // any unreachable image is simply skipped.
    const referenceImages = await this.loadReferenceImages(layout);

    const recognition = await PlanogramVisionService.recognizeShelf({
      imageBase64: args.imageBase64,
      imageMediaType: args.imageMediaType,
      // Pass brand + category so the model matches by packaging and constrains
      // classification to the planogram's real taxonomy.
      expectedSkus: layout.expected_skus.map((s) => ({
        sku_id: s.sku_id,
        sku_name: s.sku_name,
        brand: s.brand ?? undefined,
        category: s.category ?? undefined,
      })),
      // Explicit competitor list → reliable is_competitor flags → accurate
      // share-of-shelf, instead of the model guessing which brands compete.
      competitorSkus: (layout.competitors || []).map((c) => ({
        sku_id: c.sku_id,
        sku_name: c.sku_name,
        brand: c.brand,
        category: c.category ?? undefined,
      })),
      storeFormat,
      referenceImages,
      // Dense-bay shelf-tiling augment: on when this planogram opts in via
      // layout.tiling (the PLANOGRAM_TILING=1 env flag also forces it on inside
      // recognizeShelf). Default off → single-pass behavior is unchanged.
      tiling: layout.tiling === true,
    });

    const result = this.scoreShelf({ recognition, layout });

    // ── Lever 3 — quality gate (flag only; never reject the capture) ──────
    this.applyQualityGate(recognition, result, layout);

    // Store the shelf photo in this capture's own project so history can render
    // it; fall back to the client-provided URL if the in-project upload fails.
    const storedImageUrl =
      (await this.storeCaptureImage(args.orgId, args.imageBase64, args.imageMediaType)) || args.imageUrl;

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
        image_url: storedImageUrl,
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

    await supabaseAdmin
      .from('planogram_recognition')
      .insert(this.recognitionRow(cap.id, args.orgId, recognition));

    const { data: comp, error: compErr } = await supabaseAdmin
      .from('planogram_compliance')
      .insert({
        org_id: args.orgId,
        client_id: args.clientId ?? null,
        capture_id: cap.id,
        planogram_id: planogramId,
        store_id: args.storeId ?? null,
        fe_id: args.feId,
        ...this.complianceScoreFields(result),
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
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
function clamp(min: number, max: number, v: number): number {
  return Math.max(min, Math.min(max, v));
}
function avg(nums: number[]): number {
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}
function zoneFor(shelfIndex: number, shelfCount: number): ShelfZone {
  const n = Math.max(1, shelfCount);
  if (n === 1) return 'eye';
  const third = n / 3;
  if (shelfIndex < third) return 'low';
  if (shelfIndex >= 2 * third) return 'top';
  return 'eye';
}
/** Human shelf-label word for a zone: low → bottom, eye → middle, top → top. */
function zoneLabel(zone: ShelfZone): string {
  return zone === 'low' ? 'bottom' : zone === 'top' ? 'top' : 'middle';
}

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
import { AppError } from '../utils';
import {
  PlanogramVisionService,
  ShelfRecognition,
  DetectedSKU,
  RecognizeArgs,
  ShelfZone,
  PriceSource,
  PromoOfferType,
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
  }>;
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
      .select('id, layout, expected_skus')
      .eq('id', planogramId)
      .single();
    if (error || !data) {
      throw new AppError(404, 'Planogram not found', 'NOT_FOUND');
    }
    return {
      shelves: data.layout?.shelves || [],
      expected_skus: data.expected_skus || [],
      competitors: Array.isArray(data.layout?.competitors) ? data.layout.competitors : [],
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
    for (const e of layout.expected_skus || []) {
      if (e.ref_image_url) entries.push({ sku_id: e.sku_id, sku_name: e.sku_name, url: e.ref_image_url, is_competitor: false });
    }
    for (const c of layout.competitors || []) {
      if (c.ref_image_url) entries.push({ sku_id: c.sku_id, sku_name: c.sku_name, url: c.ref_image_url, is_competitor: true });
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
    });

    const result = this.scoreShelf({ recognition, layout });

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

    await supabaseAdmin.from('planogram_recognition').insert({
      capture_id: cap.id,
      org_id: args.orgId,
      detected_skus: recognition.detected_skus,
      promotions: recognition.promotions,
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
        occupancy_score: result.occupancy_score,
        shelf_share_own: result.shelf_share_own,
        shelf_share_competitor: result.shelf_share_competitor,
        category_breakdown: result.category_breakdown,
        zone_breakdown: result.zone_breakdown,
        pricing: result.pricing,
        promotions: result.promotions,
        methodology: result.methodology,
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

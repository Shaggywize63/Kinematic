/**
 * planogram-vision.service.ts
 *
 * Shelf-recognition adapter. Wraps Anthropic's Messages API (multimodal) to
 * detect SKUs, facings, shelf positions, competitor placements, per-product
 * brand/category classification, verbatim shelf-tag pricing, and promotion
 * signage from a single shelf image. Returns a normalized ShelfRecognition
 * object that the compliance engine can compare against an expected planogram.
 *
 * Recognition uses **structured output via a single forced tool call**
 * (`report_shelf`) so the model must return a schema-valid object — we read the
 * tool_use block's `input` directly instead of string-slicing free-text JSON.
 *
 * Also exposes `parsePlanogramFromImage` for the dashboard's "upload a brand
 * planogram" flow — converts a planogram document (image/PDF page) into a
 * structured layout + expected_skus (with category / brand / expected_price)
 * that managers can edit and save.
 */

import { AIService } from './ai.service';
import { AppError } from '../utils';
import { logger } from '../lib/logger';

/** Where a price reading came from. */
export type PriceSource = 'shelf_tag' | 'on_pack' | 'promo';
/** Canonical shelf zone (backend recomputes this from shelf_index; the model may hint). */
export type ShelfZone = 'low' | 'eye' | 'top';

export interface DetectedSKU {
  sku_id: string | null;
  sku_name: string;
  brand: string | null;                    // NEW — brand as identified / read
  category: string | null;                 // NEW — constrained to the planogram's taxonomy
  facings: number;
  shelf_index: number;                     // 0 = bottom shelf, increases upward
  zone?: ShelfZone | null;                 // NEW — model hint only; backend recomputes canonically
  bbox: [number, number, number, number];  // [x, y, w, h] normalized 0..1
  bbox_area?: number | null;               // NEW — w * h (backend fills if the model omits it)
  price?: number | null;                   // NEW — numeric price read from tag / pack / promo
  price_currency?: string | null;          // NEW — currency code/symbol as seen (e.g. "INR", "₹")
  price_source?: PriceSource | null;       // NEW — where the price was read
  confidence: number;
  is_competitor: boolean;
  reasoning?: string | null;               // NEW — one-line why this identification was made
  recovered?: boolean;                     // NEW — found only by the second-pass targeted recall (Lever 1)
  tiled?: boolean;                         // NEW — found only by the shelf-tiling augment pass (dense bays)
}

export type PromoOfferType = 'price_off' | 'bundle' | 'bogo' | 'combo' | 'other';

export interface Promo {
  text: string;
  offer_type: PromoOfferType;
  bbox: [number, number, number, number] | null;
  confidence: number;
  linked_sku_ids: string[];
}

export interface ShelfRecognition {
  detected_skus: DetectedSKU[];
  promotions: Promo[];                      // NEW — visible offer / promotion signage
  shelf_count: number;
  overall_confidence: number;
  needs_review: boolean;
  quality: { angle_score: number; blur_score: number; glare_score: number };
  model_version: string;
}

export interface RecognizeArgs {
  imageBase64: string;
  imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  expectedSkus?: Array<{ sku_id: string; sku_name: string; brand?: string; category?: string }>;
  competitorSkus?: Array<{ sku_id: string; sku_name: string; brand?: string; category?: string }>;
  storeFormat?: 'modern_trade' | 'general_trade' | 'hyper' | string;
  /**
   * Optional front-facing reference pack images — one per SKU — so the model
   * matches products on the shelf by packaging (flavour / size / colour)
   * instead of by name alone. This is the single biggest accuracy lever for
   * look-alike variants (e.g. six popping-boba flavours in an identical can,
   * two gochujang sizes) and for telling competitor packs apart. Capped in
   * `recognizeShelf`.
   */
  referenceImages?: Array<{
    sku_id: string;
    sku_name: string;
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    is_competitor?: boolean;
  }>;
  /**
   * When true, run the shelf-tiling augment pass (dense bays). Sourced from the
   * planogram's `layout.tiling`. The tiling pass ALSO turns on when the
   * `PLANOGRAM_TILING=1` env flag is set; either enables it. Default off, so
   * omitting this leaves recognition behavior exactly as before.
   */
  tiling?: boolean;
  model?: string;
}

export interface ParsedPlanogramSku {
  sku_id: string;
  sku_name: string;
  shelf_index: number;
  facings: number;
  position?: number;
  weight?: number;
  brand?: string | null;          // NEW — seeds expected_skus[].brand
  category?: string | null;       // NEW — seeds expected_skus[].category
  expected_price?: number | null; // NEW — seeds expected_skus[].expected_price
}

export interface ParsedPlanogram {
  name_suggestion: string;
  category_suggestion: string | null;
  store_format_suggestion: string | null;
  layout: { shelves: Array<{ index: number; capacity?: number }> };
  expected_skus: ParsedPlanogramSku[];
  overall_confidence: number;
  model_version: string;
}

const MIN_CONFIDENCE_FOR_AUTOPILOT = 0.72;

const SYSTEM_PROMPT = `You are a retail shelf-recognition expert for a planogram-execution platform.
You receive a single shelf photo (optionally preceded by reference pack-shot
images) and must report every product you can see by calling the "report_shelf"
tool exactly once. Do not answer in prose — only the tool call is read.

For EACH product on the shelf:
- Identify the SKU. If it matches an entry in the provided expected_skus list,
  set sku_id to that id. If it matches an entry in competitor_skus (a KNOWN,
  tracked competitor), set is_competitor = true AND set sku_id to that
  competitor's sku_id, so the same competitor is identified consistently across
  captures. Competitor reference pack-shots are provided too — use them to match.
  If it is clearly a competitor product but not in competitor_skus, set
  is_competitor = true with sku_id = null.
  If you cannot read the label confidently, set sku_id = null and lower confidence.
- Assign a "brand" (the manufacturer/brand on the pack) and a "category". The
  category MUST be chosen from the provided category list (the real taxonomy for
  this shelf) whenever the product fits one — do not invent free-form categories.
  Use null only when no listed category applies.
- Read any PRICE shown on a shelf tag / label, on the pack, or in promo signage,
  VERBATIM: capture the numeric value in "price", the currency code or symbol in
  "price_currency", and set "price_source" to shelf_tag | on_pack | promo. If no
  price is legible, leave price null.
- Count "facings": one facing = one product front visible on the shelf.
- Report "shelf_index": 0 for the BOTTOM shelf, increasing upward.
- Report "bbox" as [x, y, w, h] in 0..1 normalized image coordinates, and
  "bbox_area" = w * h.
- You MAY hint a "zone" (low | eye | top) but the backend recomputes it
  canonically from shelf_index — do not agonize over it.
- Give a one-line "reasoning" for the identification (what packaging/label cue
  you used).

Also detect visible PROMOTION / OFFER signage (price-off flags, bundles, BOGO,
combo deals, wobblers) into the top-level "promotions" list: capture the offer
text verbatim, classify offer_type (price_off | bundle | bogo | combo | other),
give a bbox when locatable, and list linked_sku_ids for any SKUs the offer
clearly covers.

Reference pack images: you may be shown reference pack images BEFORE the shelf
image, each labelled "Reference - sku_id=...". Match shelf products to those
references by packaging (flavour / size / colour); prefer a confident reference
match over a name guess, and use them to distinguish look-alike variants and
competitor packs. A reference tagged "(competitor)" means is_competitor = true.

Be conservative: when unsure, lower the confidence rather than guessing.`;

// Lever 1 — second-pass targeted recall. A focused pass that only asks about a
// short list of EXPECTED OWN products the first scan missed (each shown by its
// reference pack-shot), so we recover recognition misses without re-scanning the
// whole shelf and can cleanly separate "we missed it" from "out of stock".
const RECALL_SYSTEM_PROMPT = `You are a retail shelf-recognition expert doing a SECOND, focused pass.
A first automated scan of this shelf may have MISSED some specific products. You
are shown the reference pack-shot of each such product (labelled with its
sku_id), then the shelf photo. For EACH referenced product, decide whether it is
actually present somewhere on this shelf. Call "report_recall" exactly once.

Return a detection ONLY for products you can actually SEE on the shelf: set its
sku_id to the matching reference's sku_id, and give its bbox ([x, y, w, h] in
0..1 normalized image coordinates), facings (product fronts visible), shelf_index
(0 = bottom shelf, increasing upward) and confidence. Do NOT invent products, do
NOT report ones you cannot clearly see, and do NOT report anything outside the
reference set. Be conservative: if you are not sure a referenced product is on
the shelf, OMIT it — omission means it is genuinely out of stock.`;

const PARSE_SYSTEM_PROMPT = `You are a retail planogram-parsing expert. You receive an image of a brand
planogram document (a diagrammatic shelf layout the brand publishes) and must
report the prescribed shelf structure by calling the "report_planogram" tool
exactly once. Do not answer in prose — only the tool call is read.

Rules:
- shelf_index starts at 0 from the BOTTOM shelf and increases upward.
- A "facing" is one product front visible on the shelf.
- Derive sku_id as a stable slug from sku_name (lowercase, hyphenated, no spaces).
- For each SKU also capture "brand", a "category" (the product's category as the
  document presents it), and "expected_price" if a prescribed / MRP price is
  shown (numeric; null otherwise).
- If priority callouts exist (highlights, bold, "key SKU"), set weight = 2.
- If you cannot read the document confidently, lower overall_confidence.`;

/** JSON-schema fragment for a normalized [x, y, w, h] bbox. */
const BBOX_SCHEMA = {
  type: 'array',
  items: { type: 'number' },
  minItems: 4,
  maxItems: 4,
  description: '[x, y, w, h] in 0..1 normalized image coordinates',
};

/** Forced-tool input schema for shelf recognition. */
const REPORT_SHELF_SCHEMA = {
  type: 'object',
  properties: {
    shelf_count: { type: 'integer', description: 'Number of physical shelves visible' },
    quality: {
      type: 'object',
      properties: {
        angle_score: { type: 'number', description: '0..1, 1 = perfectly square-on' },
        blur_score: { type: 'number', description: '0..1, 1 = sharp' },
        glare_score: { type: 'number', description: '0..1, 1 = no glare' },
      },
      required: ['angle_score', 'blur_score', 'glare_score'],
    },
    detected_skus: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sku_id: { type: ['string', 'null'] },
          sku_name: { type: 'string' },
          brand: { type: ['string', 'null'] },
          category: { type: ['string', 'null'] },
          facings: { type: 'integer' },
          shelf_index: { type: 'integer', description: '0 = bottom shelf, increases upward' },
          zone: { type: ['string', 'null'], enum: ['low', 'eye', 'top', null] },
          bbox: BBOX_SCHEMA,
          bbox_area: { type: ['number', 'null'], description: 'w * h of the bbox' },
          price: { type: ['number', 'null'] },
          price_currency: { type: ['string', 'null'] },
          price_source: { type: ['string', 'null'], enum: ['shelf_tag', 'on_pack', 'promo', null] },
          confidence: { type: 'number', description: '0..1' },
          is_competitor: { type: 'boolean' },
          reasoning: { type: ['string', 'null'] },
        },
        required: ['sku_name', 'facings', 'shelf_index', 'bbox', 'confidence', 'is_competitor'],
      },
    },
    promotions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          offer_type: { type: 'string', enum: ['price_off', 'bundle', 'bogo', 'combo', 'other'] },
          bbox: { anyOf: [BBOX_SCHEMA, { type: 'null' }] },
          confidence: { type: 'number', description: '0..1' },
          linked_sku_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'offer_type', 'confidence'],
      },
    },
    overall_confidence: { type: 'number', description: '0..1' },
  },
  required: ['shelf_count', 'detected_skus', 'overall_confidence'],
} as const;

/**
 * Forced-tool input schema for the second-pass targeted recall (Lever 1).
 * Same per-detection shape as report_shelf (so normalization is shared), but
 * only detected_skus is required — the recall reports just the products it
 * could actually find from the missing-SKU candidate list.
 */
const REPORT_RECALL_SCHEMA = {
  type: 'object',
  properties: {
    detected_skus: REPORT_SHELF_SCHEMA.properties.detected_skus,
  },
  required: ['detected_skus'],
} as const;

/** Forced-tool input schema for brand-planogram parsing. */
const REPORT_PLANOGRAM_SCHEMA = {
  type: 'object',
  properties: {
    name_suggestion: { type: 'string' },
    category_suggestion: { type: ['string', 'null'] },
    store_format_suggestion: {
      type: ['string', 'null'],
      enum: ['modern_trade', 'general_trade', 'hyper', null],
    },
    layout: {
      type: 'object',
      properties: {
        shelves: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              capacity: { type: ['integer', 'null'] },
            },
            required: ['index'],
          },
        },
      },
      required: ['shelves'],
    },
    expected_skus: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sku_id: { type: 'string' },
          sku_name: { type: 'string' },
          shelf_index: { type: 'integer' },
          facings: { type: 'integer' },
          position: { type: ['integer', 'null'] },
          weight: { type: ['number', 'null'] },
          brand: { type: ['string', 'null'] },
          category: { type: ['string', 'null'] },
          expected_price: { type: ['number', 'null'] },
        },
        required: ['sku_id', 'sku_name', 'shelf_index', 'facings'],
      },
    },
    overall_confidence: { type: 'number', description: '0..1' },
  },
  required: ['name_suggestion', 'layout', 'expected_skus', 'overall_confidence'],
} as const;

export class PlanogramVisionService {
  private static defaultModel(): string {
    // claude-sonnet-5: high-resolution (2576px) vision + structured-output capable.
    return process.env.PLANOGRAM_VISION_MODEL || 'claude-sonnet-5';
  }

  static async recognizeShelf(args: RecognizeArgs): Promise<ShelfRecognition> {
    const apiKey = await AIService.getFunctionalKey();
    const model = args.model || this.defaultModel();

    // Constrain classification to the real taxonomy present on this planogram:
    // pass the distinct categories from expected + competitor SKUs as few-shot
    // hints so the model picks from "Beverages / Noodles / …" rather than
    // inventing free-form buckets.
    const categorySet = new Set<string>();
    for (const s of args.expectedSkus || []) if (s.category) categorySet.add(s.category);
    for (const c of args.competitorSkus || []) if (c.category) categorySet.add(c.category);
    const categories = Array.from(categorySet);

    // Prepend up to MAX_REFERENCE_IMAGES front-facing pack shots (each labelled
    // with its sku_id) so the model matches shelf products by packaging. Bounded
    // to keep token cost predictable.
    const MAX_REFERENCE_IMAGES = 32;
    const refs = (args.referenceImages || []).slice(0, MAX_REFERENCE_IMAGES);
    if ((args.referenceImages?.length || 0) > MAX_REFERENCE_IMAGES) {
      logger.warn(`[PlanogramVision] ${args.referenceImages!.length} reference images supplied; using first ${MAX_REFERENCE_IMAGES}`);
    }

    const parsed = await this.callShelfRecognition({
      apiKey,
      model,
      imageBase64: args.imageBase64,
      imageMediaType: args.imageMediaType,
      refs,
      expectedSkus: args.expectedSkus || [],
      competitorSkus: args.competitorSkus || [],
      categories,
      storeFormat: args.storeFormat,
    });

    const detected_skus: DetectedSKU[] = (Array.isArray(parsed.detected_skus) ? parsed.detected_skus : [])
      .map((s: any): DetectedSKU => toDetectedSku(s))
      // Keep only detections with a valid bbox (tolerate slight over-1 values).
      .filter(hasValidBbox);

    const promotions: Promo[] = (Array.isArray(parsed.promotions) ? parsed.promotions : [])
      .map((p: any): Promo => ({
        text: String(p.text || '').trim(),
        offer_type: normalizeOfferType(p.offer_type),
        bbox: normalizeBbox(p.bbox),
        confidence: clamp01(p.confidence),
        linked_sku_ids: Array.isArray(p.linked_sku_ids) ? p.linked_sku_ids.map((x: any) => String(x)) : [],
      }))
      .filter((p: Promo) => p.text.length > 0);

    const result: ShelfRecognition = {
      detected_skus,
      promotions,
      shelf_count: Math.max(0, Math.round(Number(parsed.shelf_count) || 0)),
      overall_confidence: clamp01(parsed.overall_confidence),
      quality: {
        angle_score: clamp01(parsed?.quality?.angle_score),
        blur_score: clamp01(parsed?.quality?.blur_score),
        glare_score: clamp01(parsed?.quality?.glare_score),
      },
      needs_review: false,
      model_version: model,
    };

    result.needs_review =
      result.overall_confidence < MIN_CONFIDENCE_FOR_AUTOPILOT ||
      result.quality.blur_score < 0.4 ||
      result.quality.glare_score < 0.4;

    // ── Shelf tiling (dense bays) — DEFAULT OFF, guarded, AUGMENTS pass-1 ──
    // Crop the shelf into an overlapping grid and re-run the SAME structured
    // recognition on each tile, so small / edge SKUs that pass-1 skimmed over on
    // a densely-packed bay get picked up. Purely additive: tile finds are merged
    // in (deduped by sku_id and bbox IoU) and tagged `tiled: true`; nothing that
    // pass-1 already found is removed or double-counted. Gated behind the
    // PLANOGRAM_TILING env flag OR the planogram's layout.tiling, and wrapped so
    // any error/timeout leaves the pass-1 results exactly as they were.
    if (process.env.PLANOGRAM_TILING === '1' || args.tiling === true) {
      try {
        const tiled = await this.tileAugment({
          apiKey,
          model,
          imageBase64: args.imageBase64,
          imageMediaType: args.imageMediaType,
          pass1: result.detected_skus,
          refs,
          expectedSkus: args.expectedSkus || [],
          competitorSkus: args.competitorSkus || [],
          categories,
          storeFormat: args.storeFormat,
        });
        if (tiled.length) {
          result.detected_skus = result.detected_skus.concat(tiled);
          logger.info(`[PlanogramVision] tiling recovered ${tiled.length} SKU(s) missed by pass-1`);
        }
      } catch (e) {
        logger.warn(`[PlanogramVision] tiling pass failed (keeping pass-1 results): ${(e as Error)?.message}`);
      }
    }

    // ── Lever 1: second-pass targeted recall ─────────────────────────────
    // Recover EXPECTED OWN products that ARE on the shelf but pass-1 missed.
    // Guarded end-to-end: recallMissingSkus only makes a vision call when ≥1
    // expected own SKU with a reference pack-shot is absent from pass-1, and the
    // whole thing is wrapped so a failed/slow/timed-out recall NEVER breaks the
    // capture — on any error we keep the pass-1 results untouched.
    try {
      const recovered = await this.recallMissingSkus({
        apiKey,
        model,
        imageBase64: args.imageBase64,
        imageMediaType: args.imageMediaType,
        pass1: result.detected_skus,
        expectedSkus: args.expectedSkus || [],
        referenceImages: args.referenceImages || [],
      });
      if (recovered.length) {
        result.detected_skus = result.detected_skus.concat(recovered);
        logger.info(`[PlanogramVision] recall recovered ${recovered.length} missed SKU(s)`);
      }
    } catch (e) {
      logger.warn(`[PlanogramVision] recall pass failed (keeping pass-1 results): ${(e as Error)?.message}`);
    }

    return result;
  }

  /** Hard deadline for the second-pass recall so a slow recall never pins the capture. */
  private static readonly RECALL_TIMEOUT_MS = 30_000;

  /** Per-tile vision deadline for the tiling augment pass. */
  private static readonly TILE_TIMEOUT_MS = 25_000;
  /** Overall wall-clock budget for the whole tiling pass (all tiles combined). */
  private static readonly TILING_TOTAL_BUDGET_MS = 90_000;
  /** Hard cap on tile vision calls — the grid never exceeds this either. */
  private static readonly MAX_TILE_CALLS = 4;

  /**
   * Lever 1 — second-pass targeted recall.
   *
   * Given the pass-1 detections and the reference pack-shots already loaded for
   * this capture, ask the model — in ONE focused vision call — whether each
   * EXPECTED OWN SKU that pass-1 missed (and that has a reference pack-shot) is
   * actually on the shelf. This recovers recognition misses and cleanly
   * separates "we missed it" (recovered) from "genuinely out of stock" (omitted).
   *
   * Returns ONLY the newly found detections, each tagged `recovered: true` and
   * deduped against pass-1 by sku_id and bbox IoU. Best-effort: on any error the
   * caller keeps pass-1. Returns [] (without a vision call) when there is nothing
   * to recall, which is the primary guard.
   */
  private static async recallMissingSkus(opts: {
    apiKey: string;
    model: string;
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    pass1: DetectedSKU[];
    expectedSkus: NonNullable<RecognizeArgs['expectedSkus']>;
    referenceImages: NonNullable<RecognizeArgs['referenceImages']>;
  }): Promise<DetectedSKU[]> {
    // Own SKUs pass-1 already found (only own detections count as "present").
    const pass1OwnIds = new Set<string>();
    for (const d of opts.pass1) if (d.sku_id && !d.is_competitor) pass1OwnIds.add(d.sku_id);

    // Own reference pack-shots keyed by sku_id (the only ones we can targetedly
    // recall — a missing SKU with no reference has nothing to show the model).
    const ownRefById = new Map<string, NonNullable<RecognizeArgs['referenceImages']>[number]>();
    for (const r of opts.referenceImages) if (!r.is_competitor) ownRefById.set(r.sku_id, r);

    // Candidates = expected own SKUs absent from pass-1 that HAVE a reference.
    const missingIds = new Set<string>();
    const candidateRefs: NonNullable<RecognizeArgs['referenceImages']> = [];
    for (const e of opts.expectedSkus) {
      if (pass1OwnIds.has(e.sku_id)) continue;
      const ref = ownRefById.get(e.sku_id);
      if (!ref) continue;
      if (missingIds.has(e.sku_id)) continue;
      missingIds.add(e.sku_id);
      candidateRefs.push(ref);
    }

    // GUARD: nothing to recall → no vision call, pass-1 stands.
    if (candidateRefs.length === 0) return [];

    const content: Array<Record<string, unknown>> = [];
    content.push({ type: 'text', text: 'A first scan may have missed these specific products. Their reference pack-shots follow, each labelled with its sku_id.' });
    for (const r of candidateRefs) {
      content.push({ type: 'text', text: `Reference - sku_id=${r.sku_id}: ${r.sku_name}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: r.imageMediaType, data: r.imageBase64 } });
    }
    content.push({ type: 'text', text: 'End of references. Now analyze this SHELF image:' });
    content.push({ type: 'image', source: { type: 'base64', media_type: opts.imageMediaType, data: opts.imageBase64 } });
    content.push({
      type: 'text',
      text: [
        'For EACH referenced product, decide if it is present on this shelf; if yes',
        'return its sku_id, bbox, facings, shelf_index and confidence. Only report',
        'ones you can actually see — omit the rest (they are out of stock).',
        'candidate_missing_skus = ' + JSON.stringify(candidateRefs.map((r) => ({ sku_id: r.sku_id, sku_name: r.sku_name }))),
      ].join('\n'),
    });

    const parsed = await this.callVisionTool({
      apiKey: opts.apiKey,
      model: opts.model,
      system: RECALL_SYSTEM_PROMPT,
      content,
      toolName: 'report_recall',
      toolDescription: 'Report which of the specified previously-missed products are present on the shelf.',
      inputSchema: REPORT_RECALL_SCHEMA,
      errorCode: 'VISION_RECALL_ERROR',
      timeoutMs: this.RECALL_TIMEOUT_MS,
    });

    const found: DetectedSKU[] = (Array.isArray(parsed.detected_skus) ? parsed.detected_skus : [])
      .map((s: any): DetectedSKU => ({ ...toDetectedSku(s), is_competitor: false, recovered: true }))
      .filter(hasValidBbox);

    // Merge/dedup: accept only the specific missing SKUs we asked about, drop any
    // that collide with pass-1 (or an earlier recovery) by sku_id, and drop any
    // whose bbox strongly overlaps an existing detection (same physical facing).
    const out: DetectedSKU[] = [];
    const takenIds = new Set<string>();
    for (const r of found) {
      if (!r.sku_id || !missingIds.has(r.sku_id)) continue;
      if (pass1OwnIds.has(r.sku_id) || takenIds.has(r.sku_id)) continue;
      if (opts.pass1.some((d) => bboxIoU(d.bbox, r.bbox) > 0.5)) continue;
      takenIds.add(r.sku_id);
      out.push(r);
    }
    return out;
  }

  /**
   * Build the report_shelf content payload and force the structured tool call.
   * Shared by pass-1 and the tiling augment so a tile is analysed with the
   * IDENTICAL prompt, reference pack-shots, expected/competitor/category hints
   * and schema — only the image (a crop) and an optional per-call deadline
   * differ. Returns the raw tool `input`; the caller normalizes it.
   */
  private static async callShelfRecognition(opts: {
    apiKey: string;
    model: string;
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    refs: NonNullable<RecognizeArgs['referenceImages']>;
    expectedSkus: NonNullable<RecognizeArgs['expectedSkus']>;
    competitorSkus: NonNullable<RecognizeArgs['competitorSkus']>;
    categories: string[];
    storeFormat?: string;
    timeoutMs?: number;
  }): Promise<any> {
    const userText = [
      'Identify every product on this shelf and call report_shelf exactly once.',
      'expected_skus = ' + JSON.stringify(opts.expectedSkus),
      'competitor_skus = ' + JSON.stringify(opts.competitorSkus),
      'category list (choose category ONLY from these when a product fits) = ' +
        JSON.stringify(opts.categories),
      'store_format = ' + (opts.storeFormat || 'unknown'),
    ].join('\n');

    const content: Array<Record<string, unknown>> = [];
    if (opts.refs.length) {
      content.push({ type: 'text', text: 'Reference pack images follow — each is the front of one SKU, labelled with its sku_id. Use them to identify that exact product (flavour / size / variant) and to tell competitor packs apart on the shelf image that comes after them.' });
      for (const r of opts.refs) {
        content.push({ type: 'text', text: `Reference - sku_id=${r.sku_id}${r.is_competitor ? ' (competitor)' : ''}: ${r.sku_name}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: r.imageMediaType, data: r.imageBase64 } });
      }
      content.push({ type: 'text', text: 'End of references. Now analyze this SHELF image:' });
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: opts.imageMediaType, data: opts.imageBase64 } });
    content.push({ type: 'text', text: userText });

    return this.callVisionTool({
      apiKey: opts.apiKey,
      model: opts.model,
      system: SYSTEM_PROMPT,
      content,
      toolName: 'report_shelf',
      toolDescription: 'Report every product, price and promotion detected on the shelf image.',
      inputSchema: REPORT_SHELF_SCHEMA,
      errorCode: 'VISION_ERROR',
      timeoutMs: opts.timeoutMs,
    });
  }

  /**
   * Shelf tiling (dense bays) — augment pass.
   *
   * Crops the capture into an overlapping grid (≤ MAX_TILE_CALLS tiles chosen by
   * aspect ratio) and runs the SAME structured recognition on each tile, then
   * REMAPS every tile detection's normalized bbox back into full-image coords and
   * MERGES the finds into pass-1 — deduping by sku_id and by bbox IoU > 0.5 so a
   * SKU pass-1 already found is never removed or double-counted. Returns ONLY the
   * newly-recovered detections, each tagged `tiled: true`.
   *
   * Best-effort and fully bounded: `sharp` is imported lazily (a missing binary
   * just disables tiling), each tile is guarded independently, the whole pass has
   * a wall-clock budget, and per-tile vision calls carry a hard deadline. Any
   * failure returns whatever was recovered so far without disturbing pass-1.
   */
  private static async tileAugment(opts: {
    apiKey: string;
    model: string;
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    pass1: DetectedSKU[];
    refs: NonNullable<RecognizeArgs['referenceImages']>;
    expectedSkus: NonNullable<RecognizeArgs['expectedSkus']>;
    competitorSkus: NonNullable<RecognizeArgs['competitorSkus']>;
    categories: string[];
    storeFormat?: string;
  }): Promise<DetectedSKU[]> {
    // Lazy import so a missing/broken native binary can only ever disable tiling,
    // never crash recognition (which does not otherwise depend on sharp).
    let sharp: (typeof import('sharp'))['default'];
    try {
      sharp = (await import('sharp')).default;
    } catch (e) {
      logger.warn(`[PlanogramVision] sharp unavailable — tiling skipped: ${(e as Error)?.message}`);
      return [];
    }

    const srcBuf = Buffer.from(opts.imageBase64, 'base64');
    const meta = await sharp(srcBuf).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) {
      logger.warn('[PlanogramVision] tiling skipped — could not read image dimensions');
      return [];
    }

    // Wide bays → one row of two columns; squarer / taller bays → two rows. Both
    // are ≤ MAX_TILE_CALLS tiles; slice is a belt-and-braces bound on the count.
    const cols = 2;
    const rows = W / H >= 1.3 ? 1 : 2;
    const tiles = computeTiles(W, H, cols, rows).slice(0, this.MAX_TILE_CALLS);

    // Dedup working set grows as we accept tile finds, so two tiles that both see
    // the same edge product (in their overlap) can't both add it.
    const takenIds = new Set<string>();
    for (const d of opts.pass1) if (d.sku_id) takenIds.add(d.sku_id);
    const existing: DetectedSKU[] = opts.pass1.slice();
    const added: DetectedSKU[] = [];

    const start = Date.now();
    for (const tile of tiles) {
      if (Date.now() - start > this.TILING_TOTAL_BUDGET_MS) {
        logger.warn('[PlanogramVision] tiling budget exhausted — stopping early');
        break;
      }
      try {
        const tileBuf = await sharp(srcBuf)
          .extract({ left: tile.x, top: tile.y, width: tile.w, height: tile.h })
          .jpeg({ quality: 90 })
          .toBuffer();

        const parsed = await this.callShelfRecognition({
          apiKey: opts.apiKey,
          model: opts.model,
          imageBase64: tileBuf.toString('base64'),
          imageMediaType: 'image/jpeg',
          refs: opts.refs,
          expectedSkus: opts.expectedSkus,
          competitorSkus: opts.competitorSkus,
          categories: opts.categories,
          storeFormat: opts.storeFormat,
          timeoutMs: this.TILE_TIMEOUT_MS,
        });

        const tileDetections: DetectedSKU[] = (Array.isArray(parsed.detected_skus) ? parsed.detected_skus : [])
          .map((s: any): DetectedSKU => toDetectedSku(s))
          .filter(hasValidBbox);

        for (const det of tileDetections) {
          // Remap the tile-local bbox back to full-image normalized coords.
          det.bbox = remapTileBbox(det.bbox, tile, W, H);
          det.bbox_area = round4(det.bbox[2] * det.bbox[3]);
          if (!hasValidBbox(det)) continue;
          // Dedup: same sku_id already present, or same physical facing (IoU>0.5).
          if (det.sku_id && takenIds.has(det.sku_id)) continue;
          if (existing.some((e) => bboxIoU(e.bbox, det.bbox) > 0.5)) continue;
          det.tiled = true;
          if (det.sku_id) takenIds.add(det.sku_id);
          existing.push(det);
          added.push(det);
        }
      } catch (e) {
        // One bad tile (crop or vision error/timeout) must not lose the others.
        logger.warn(`[PlanogramVision] tile [${tile.x},${tile.y},${tile.w},${tile.h}] failed: ${(e as Error)?.message}`);
      }
    }

    return added;
  }

  /**
   * Parse a brand-published planogram document (image) into a structured
   * layout + expected_skus (with brand / category / expected_price) that the
   * dashboard can present for review/save.
   */
  static async parsePlanogramFromImage(args: {
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    model?: string;
  }): Promise<ParsedPlanogram> {
    const apiKey = await AIService.getFunctionalKey();
    const model = args.model || this.defaultModel();

    const parsed = await this.callVisionTool({
      apiKey,
      model,
      system: PARSE_SYSTEM_PROMPT,
      content: [
        { type: 'image', source: { type: 'base64', media_type: args.imageMediaType, data: args.imageBase64 } },
        { type: 'text', text: 'Extract the planogram structure and call report_planogram exactly once.' },
      ],
      toolName: 'report_planogram',
      toolDescription: 'Report the prescribed planogram layout and expected SKUs.',
      inputSchema: REPORT_PLANOGRAM_SCHEMA,
      errorCode: 'PLANOGRAM_PARSE_ERROR',
    });

    const seen = new Set<string>();
    const expected_skus: ParsedPlanogramSku[] = (Array.isArray(parsed.expected_skus) ? parsed.expected_skus : [])
      .map((s: any) => ({
        sku_id: String(s.sku_id || slugify(s.sku_name || '')),
        sku_name: String(s.sku_name || '').trim(),
        shelf_index: Math.max(0, Number(s.shelf_index) || 0),
        facings: Math.max(1, Number(s.facings) || 1),
        position: s.position == null ? undefined : Number(s.position),
        weight: s.weight == null ? undefined : Number(s.weight),
        brand: s.brand == null ? null : String(s.brand),
        category: s.category == null ? null : String(s.category),
        expected_price: s.expected_price == null || !Number.isFinite(Number(s.expected_price)) ? null : Number(s.expected_price),
      }))
      .filter((s: ParsedPlanogramSku) => {
        if (!s.sku_id || !s.sku_name) return false;
        if (seen.has(s.sku_id)) return false;
        seen.add(s.sku_id);
        return true;
      });

    const shelves = Array.isArray(parsed?.layout?.shelves) ? parsed.layout.shelves : [];
    return {
      name_suggestion: String(parsed.name_suggestion || 'New planogram'),
      category_suggestion: parsed.category_suggestion ?? null,
      store_format_suggestion: parsed.store_format_suggestion ?? null,
      layout: {
        shelves: shelves
          .map((s: any) => ({
            index: Math.max(0, Number(s.index) || 0),
            capacity: s.capacity == null ? undefined : Number(s.capacity),
          }))
          .filter((s: any) => Number.isFinite(s.index)),
      },
      expected_skus,
      overall_confidence: clamp01(parsed.overall_confidence),
      model_version: model,
    };
  }

  /**
   * Shared Messages-API call that forces a single tool call and returns the
   * tool_use block's `input` object. Replaces the old brittle free-text JSON
   * slicing — a schema-valid object is guaranteed by `tool_choice`.
   */
  private static async callVisionTool(opts: {
    apiKey: string;
    model: string;
    system: string;
    content: Array<Record<string, unknown>>;
    toolName: string;
    toolDescription: string;
    inputSchema: unknown;
    errorCode: string;
    // Optional hard deadline (ms). Used by the second-pass recall so a slow
    // recall aborts instead of pinning the capture. Existing callers pass none
    // → behavior is unchanged (plain fetch, no signal).
    timeoutMs?: number;
  }): Promise<any> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        // Dense shelves now emit category + price + zone + reasoning per detection
        // plus promotions, so give the structured tool call room.
        max_tokens: 8000,
        system: opts.system,
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            input_schema: opts.inputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: opts.toolName },
        messages: [{ role: 'user', content: opts.content }],
      }),
    };

    let response: Response;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      // Same AbortController + hard-deadline pattern used across AIService.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', { ...init, signal: ac.signal });
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === 'AbortError') {
          throw new AppError(504, 'Vision request timed out', opts.errorCode);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    } else {
      response = await fetch('https://api.anthropic.com/v1/messages', init);
    }

    if (!response.ok) {
      const err: any = await response.json().catch(() => ({}));
      throw new AppError(response.status, err?.error?.message || `Vision request failed (${response.status})`, opts.errorCode);
    }

    const data: any = await response.json();
    const block = Array.isArray(data?.content)
      ? data.content.find((c: any) => c?.type === 'tool_use' && c?.name === opts.toolName)
      : null;
    if (!block || typeof block.input !== 'object' || block.input === null) {
      logger.warn(`[PlanogramVision] No ${opts.toolName} tool_use block in response (stop_reason=${data?.stop_reason})`);
      throw new AppError(502, 'AI did not return a structured shelf/planogram report.', opts.errorCode);
    }
    return block.input;
  }
}

function clamp01(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function normalizeBbox(v: any): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const nums = v.map((x) => Number(x));
  if (!nums.every((x) => Number.isFinite(x))) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

function normalizeZone(v: any): ShelfZone | null {
  return v === 'low' || v === 'eye' || v === 'top' ? v : null;
}

function normalizePriceSource(v: any): PriceSource | null {
  return v === 'shelf_tag' || v === 'on_pack' || v === 'promo' ? v : null;
}

function normalizeOfferType(v: any): PromoOfferType {
  return v === 'price_off' || v === 'bundle' || v === 'bogo' || v === 'combo' ? v : 'other';
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/**
 * Normalize one raw model detection into a DetectedSKU. Shared by the first
 * pass and the second-pass recall so both produce identically-shaped rows.
 */
function toDetectedSku(s: any): DetectedSKU {
  const bbox = normalizeBbox(s.bbox);
  const bbox_area = bbox
    ? (s.bbox_area == null ? round4(bbox[2] * bbox[3]) : Number(s.bbox_area))
    : null;
  return {
    sku_id: s.sku_id == null ? null : String(s.sku_id),
    sku_name: String(s.sku_name || '').trim(),
    brand: s.brand == null ? null : String(s.brand),
    category: s.category == null ? null : String(s.category),
    facings: Math.max(0, Math.round(Number(s.facings) || 0)),
    shelf_index: Math.max(0, Math.round(Number(s.shelf_index) || 0)),
    zone: normalizeZone(s.zone),
    bbox: bbox || [0, 0, 0, 0],
    bbox_area,
    price: s.price == null || !Number.isFinite(Number(s.price)) ? null : Number(s.price),
    price_currency: s.price_currency == null ? null : String(s.price_currency),
    price_source: normalizePriceSource(s.price_source),
    confidence: clamp01(s.confidence),
    is_competitor: Boolean(s.is_competitor),
    reasoning: s.reasoning == null ? null : String(s.reasoning),
  };
}

/** Keep only detections with a usable bbox (tolerate slight over-1 values). */
function hasValidBbox(s: DetectedSKU): boolean {
  return (
    Array.isArray(s.bbox) &&
    s.bbox.length === 4 &&
    s.bbox.every((v) => v >= 0 && v <= 1.5) &&
    (s.bbox[2] > 0 || s.bbox[3] > 0)
  );
}

/** A pixel-space crop rectangle taken from the full capture image. */
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Split a W×H image into a `cols`×`rows` grid of OVERLAPPING pixel tiles.
 * Each interior edge is expanded by `overlap` (fraction of the cell size) so a
 * product straddling a cut line is fully visible in at least one tile; tiles are
 * clamped to the image bounds. Pure + deterministic (unit-testable).
 */
export function computeTiles(
  W: number,
  H: number,
  cols: number,
  rows: number,
  overlap = 0.12,
): Tile[] {
  const tiles: Tile[] = [];
  if (!(W > 0) || !(H > 0) || cols < 1 || rows < 1) return tiles;
  const cellW = W / cols;
  const cellH = H / rows;
  const ox = cellW * overlap;
  const oy = cellH * overlap;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, Math.floor(c * cellW - ox));
      const y0 = Math.max(0, Math.floor(r * cellH - oy));
      const x1 = Math.min(W, Math.ceil((c + 1) * cellW + ox));
      const y1 = Math.min(H, Math.ceil((r + 1) * cellH + oy));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w > 0 && h > 0) tiles.push({ x: x0, y: y0, w, h });
    }
  }
  return tiles;
}

/**
 * Remap a detection bbox expressed in a TILE's normalized 0..1 coords back to
 * the FULL image's normalized 0..1 coords, clamped to [0,1]. Pure (unit-tested):
 *   full_px = tile_offset + tile_norm × tile_size ; then ÷ image_size.
 */
export function remapTileBbox(
  bbox: [number, number, number, number],
  tile: Tile,
  imageW: number,
  imageH: number,
): [number, number, number, number] {
  const [tx, ty, tw, th] = bbox;
  let fx = (tile.x + tx * tile.w) / imageW;
  let fy = (tile.y + ty * tile.h) / imageH;
  let fw = (tw * tile.w) / imageW;
  let fh = (th * tile.h) / imageH;
  // Clamp origin into the image, then clamp size so the box stays inside it.
  fx = Math.max(0, Math.min(1, fx));
  fy = Math.max(0, Math.min(1, fy));
  fw = Math.max(0, Math.min(1 - fx, fw));
  fh = Math.max(0, Math.min(1 - fy, fh));
  return [round4(fx), round4(fy), round4(fw), round4(fh)];
}

/** Intersection-over-union of two normalized [x, y, w, h] boxes (0 when disjoint). */
function bboxIoU(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0;
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const areaA = Math.max(0, a[2]) * Math.max(0, a[3]);
  const areaB = Math.max(0, b[2]) * Math.max(0, b[3]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

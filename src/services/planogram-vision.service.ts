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
  set sku_id to that id; if it matches competitor_skus, set is_competitor = true.
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

    const userText = [
      'Identify every product on this shelf and call report_shelf exactly once.',
      'expected_skus = ' + JSON.stringify(args.expectedSkus || []),
      'competitor_skus = ' + JSON.stringify(args.competitorSkus || []),
      'category list (choose category ONLY from these when a product fits) = ' +
        JSON.stringify(categories),
      'store_format = ' + (args.storeFormat || 'unknown'),
    ].join('\n');

    // Prepend up to MAX_REFERENCE_IMAGES front-facing pack shots (each labelled
    // with its sku_id) so the model matches shelf products by packaging. Bounded
    // to keep token cost predictable.
    const MAX_REFERENCE_IMAGES = 32;
    const refs = (args.referenceImages || []).slice(0, MAX_REFERENCE_IMAGES);
    if ((args.referenceImages?.length || 0) > MAX_REFERENCE_IMAGES) {
      logger.warn(`[PlanogramVision] ${args.referenceImages!.length} reference images supplied; using first ${MAX_REFERENCE_IMAGES}`);
    }

    const content: Array<Record<string, unknown>> = [];
    if (refs.length) {
      content.push({ type: 'text', text: 'Reference pack images follow — each is the front of one SKU, labelled with its sku_id. Use them to identify that exact product (flavour / size / variant) and to tell competitor packs apart on the shelf image that comes after them.' });
      for (const r of refs) {
        content.push({ type: 'text', text: `Reference - sku_id=${r.sku_id}${r.is_competitor ? ' (competitor)' : ''}: ${r.sku_name}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: r.imageMediaType, data: r.imageBase64 } });
      }
      content.push({ type: 'text', text: 'End of references. Now analyze this SHELF image:' });
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: args.imageMediaType, data: args.imageBase64 } });
    content.push({ type: 'text', text: userText });

    const parsed = await this.callVisionTool({
      apiKey,
      model,
      system: SYSTEM_PROMPT,
      content,
      toolName: 'report_shelf',
      toolDescription: 'Report every product, price and promotion detected on the shelf image.',
      inputSchema: REPORT_SHELF_SCHEMA,
      errorCode: 'VISION_ERROR',
    });

    const detected_skus: DetectedSKU[] = (Array.isArray(parsed.detected_skus) ? parsed.detected_skus : [])
      .map((s: any): DetectedSKU => {
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
      })
      // Keep only detections with a valid bbox (tolerate slight over-1 values).
      .filter((s: DetectedSKU) => Array.isArray(s.bbox) && s.bbox.length === 4 && s.bbox.every((v) => v >= 0 && v <= 1.5) && (s.bbox[2] > 0 || s.bbox[3] > 0));

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

    return result;
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
  }): Promise<any> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
    });

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

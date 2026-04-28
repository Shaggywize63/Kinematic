/**
 * planogram-vision.service.ts
 *
 * Shelf-recognition adapter. Wraps Anthropic's Messages API (multimodal) to
 * detect SKUs, facings, shelf positions, and competitor placements from a
 * single shelf image. Returns a normalized ShelfRecognition object that the
 * compliance engine can compare against an expected planogram.
 *
 * Also exposes `parsePlanogramFromImage` for the dashboard's "upload a brand
 * planogram" flow — converts a planogram document (image/PDF page) into a
 * structured layout + expected_skus that managers can edit and save.
 */

import { AIService } from './ai.service';
import { AppError } from '../utils';
import { logger } from '../lib/logger';

export interface DetectedSKU {
  sku_id: string | null;
  sku_name: string;
  facings: number;
  shelf_index: number;
  bbox: [number, number, number, number];
  confidence: number;
  is_competitor: boolean;
}

export interface ShelfRecognition {
  detected_skus: DetectedSKU[];
  shelf_count: number;
  overall_confidence: number;
  needs_review: boolean;
  quality: { angle_score: number; blur_score: number; glare_score: number };
  model_version: string;
}

export interface RecognizeArgs {
  imageBase64: string;
  imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  expectedSkus?: Array<{ sku_id: string; sku_name: string; brand?: string }>;
  competitorSkus?: Array<{ sku_id: string; sku_name: string; brand?: string }>;
  storeFormat?: 'modern_trade' | 'general_trade' | 'hyper' | string;
  model?: string;
}

export interface ParsedPlanogramSku {
  sku_id: string;
  sku_name: string;
  shelf_index: number;
  facings: number;
  position?: number;
  weight?: number;
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
You receive a single shelf image and must return ONLY valid JSON describing
the products you can see. No prose, no markdown.

Schema:
{
  "shelf_count": int,
  "quality": { "angle_score": 0..1, "blur_score": 0..1, "glare_score": 0..1 },
  "detected_skus": [
    {
      "sku_id": string | null,
      "sku_name": string,
      "facings": int,
      "shelf_index": int (0 = bottom shelf, increases upward),
      "bbox": [x, y, w, h] in 0..1 normalized image coordinates,
      "confidence": 0..1,
      "is_competitor": boolean
    }
  ],
  "overall_confidence": 0..1
}

Rules:
- If a SKU appears in the provided "expected_skus" list, set sku_id to that id.
- If a SKU appears in "competitor_skus", set is_competitor = true.
- Be conservative: if you cannot read a label, set sku_id = null and lower confidence accordingly.
- Count facings carefully: a facing is one product front visible on the shelf.
- shelf_index starts at 0 from the BOTTOM shelf.`;

const PARSE_SYSTEM_PROMPT = `You are a retail planogram-parsing expert. You receive an image of a brand
planogram document (a diagrammatic shelf layout the brand publishes) and must
return ONLY valid JSON describing the prescribed shelf structure. No prose, no markdown.

Schema:
{
  "name_suggestion": string,
  "category_suggestion": string | null,
  "store_format_suggestion": "modern_trade" | "general_trade" | "hyper" | null,
  "layout": { "shelves": [ { "index": int, "capacity": int? } ] },
  "expected_skus": [
    {
      "sku_id": string,
      "sku_name": string,
      "shelf_index": int,
      "facings": int,
      "position": int | null,
      "weight": number | null
    }
  ],
  "overall_confidence": 0..1
}

Rules:
- shelf_index starts at 0 from the BOTTOM shelf and increases upward.
- A "facing" is one product front visible on the shelf.
- Derive sku_id as a stable slug from sku_name (lowercase, hyphenated, no spaces).
- If priority callouts exist (highlights, bold, "key SKU"), set weight = 2.
- If you cannot read the document confidently, lower overall_confidence.`;

export class PlanogramVisionService {
  private static defaultModel(): string {
    return process.env.PLANOGRAM_VISION_MODEL || 'claude-sonnet-4-5-20250929';
  }

  static async recognizeShelf(args: RecognizeArgs): Promise<ShelfRecognition> {
    const apiKey = await AIService.getFunctionalKey();
    const model = args.model || this.defaultModel();

    const userText = [
      'Identify every product on this shelf.',
      'expected_skus = ' + JSON.stringify(args.expectedSkus || []),
      'competitor_skus = ' + JSON.stringify(args.competitorSkus || []),
      'store_format = ' + (args.storeFormat || 'unknown'),
      'Return JSON only.',
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: args.imageMediaType, data: args.imageBase64 } },
            { type: 'text', text: userText },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err: any = await response.json().catch(() => ({}));
      throw new AppError(response.status, err?.error?.message || `Vision request failed (${response.status})`, 'VISION_ERROR');
    }

    const data: any = await response.json();
    const text: string = data?.content?.[0]?.text || '';

    let parsed: any;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      parsed = JSON.parse(text.substring(start, end + 1));
    } catch (e: any) {
      logger.warn(`[PlanogramVision] Failed to parse JSON: ${e.message}`);
      throw new AppError(502, 'AI returned an unparsable shelf description.', 'VISION_PARSE_ERROR');
    }

    const result: ShelfRecognition = {
      detected_skus: Array.isArray(parsed.detected_skus) ? parsed.detected_skus : [],
      shelf_count: Number(parsed.shelf_count) || 0,
      overall_confidence: clamp01(parsed.overall_confidence),
      quality: {
        angle_score: clamp01(parsed?.quality?.angle_score),
        blur_score: clamp01(parsed?.quality?.blur_score),
        glare_score: clamp01(parsed?.quality?.glare_score),
      },
      needs_review: false,
      model_version: model,
    };

    result.detected_skus = result.detected_skus.filter(
      (s) => Array.isArray(s.bbox) && s.bbox.length === 4 && s.bbox.every((v) => v >= 0 && v <= 1.5),
    );

    result.needs_review =
      result.overall_confidence < MIN_CONFIDENCE_FOR_AUTOPILOT ||
      result.quality.blur_score < 0.4 ||
      result.quality.glare_score < 0.4;

    return result;
  }

  /**
   * Parse a brand-published planogram document (image) into a structured
   * layout + expected_skus that the dashboard can present for review/save.
   */
  static async parsePlanogramFromImage(args: {
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    model?: string;
  }): Promise<ParsedPlanogram> {
    const apiKey = await AIService.getFunctionalKey();
    const model = args.model || this.defaultModel();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        system: PARSE_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: args.imageMediaType, data: args.imageBase64 } },
            { type: 'text', text: 'Extract the planogram structure. Return JSON only.' },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err: any = await response.json().catch(() => ({}));
      throw new AppError(response.status, err?.error?.message || `Planogram parse failed (${response.status})`, 'PLANOGRAM_PARSE_ERROR');
    }

    const data: any = await response.json();
    const text: string = data?.content?.[0]?.text || '';

    let parsed: any;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      parsed = JSON.parse(text.substring(start, end + 1));
    } catch (e: any) {
      logger.warn(`[PlanogramVision] Failed to parse planogram JSON: ${e.message}`);
      throw new AppError(502, 'AI returned an unparsable planogram description.', 'PLANOGRAM_PARSE_ERROR');
    }

    const seen = new Set<string>();
    const expected_skus: ParsedPlanogramSku[] = (Array.isArray(parsed.expected_skus) ? parsed.expected_skus : [])
      .map((s: any) => ({
        sku_id: String(s.sku_id || slugify(s.sku_name || '')),
        sku_name: String(s.sku_name || '').trim(),
        shelf_index: Math.max(0, Number(s.shelf_index) || 0),
        facings: Math.max(1, Number(s.facings) || 1),
        position: s.position == null ? undefined : Number(s.position),
        weight: s.weight == null ? undefined : Number(s.weight),
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
}

function clamp01(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

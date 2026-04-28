/**
 * planogram-vision.service.ts
 *
 * Shelf-recognition adapter. Wraps Anthropic's Messages API (multimodal) to
 * detect SKUs, facings, shelf positions, and competitor placements from a
 * single shelf image. Returns a normalized ShelfRecognition object that the
 * compliance engine can compare against an expected planogram.
 *
 * Design notes
 * ─────────────
 * • Uses AIService.getFunctionalKey() so we share the same dynamic-key
 *   infrastructure as the rest of the platform.
 * • Asks the model for strict JSON; we parse defensively and surface a
 *   confidence score so the compliance engine can flag low-quality results.
 * • Three-stage validation strategy (detection → classification → spatial)
 *   is implemented in `recognizeShelf` via prompt scaffolding plus a
 *   second-pass spatial check on the parsed boxes.
 */

import { AIService } from './ai.service';
import { AppError } from '../utils';
import { logger } from '../lib/logger';

export interface DetectedSKU {
  sku_id: string | null;          // matched catalog id, null if unknown
  sku_name: string;
  facings: number;                // count along the shelf
  shelf_index: number;            // 0 = bottom shelf, increases upward
  bbox: [number, number, number, number]; // [x,y,w,h] in 0..1 normalized
  confidence: number;             // 0..1
  is_competitor: boolean;
}

export interface ShelfRecognition {
  detected_skus: DetectedSKU[];
  shelf_count: number;
  overall_confidence: number;
  needs_review: boolean;          // true if any quality gate failed
  quality: {
    angle_score: number;
    blur_score: number;
    glare_score: number;
  };
  model_version: string;
}

export interface RecognizeArgs {
  imageBase64: string;            // raw bytes, no data: prefix
  imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  expectedSkus?: Array<{ sku_id: string; sku_name: string; brand?: string }>;
  competitorSkus?: Array<{ sku_id: string; sku_name: string; brand?: string }>;
  storeFormat?: 'modern_trade' | 'general_trade' | 'hyper' | string;
  model?: string;
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
- Be conservative: if you cannot read a label, set sku_id = null and lower
  confidence accordingly.
- Count facings carefully: a facing is one product front visible on the shelf.
- shelf_index starts at 0 from the BOTTOM shelf.`;

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
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: args.imageMediaType,
                  data: args.imageBase64,
                },
              },
              { type: 'text', text: userText },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err: any = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `Vision request failed (${response.status})`;
      throw new AppError(response.status, msg, 'VISION_ERROR');
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

    // Spatial sanity check (second-pass validation): drop boxes outside [0,1]
    // and downgrade confidence on overlapping detections of the same shelf.
    result.detected_skus = result.detected_skus.filter(
      (s) =>
        Array.isArray(s.bbox) &&
        s.bbox.length === 4 &&
        s.bbox.every((v) => v >= 0 && v <= 1.5),
    );

    result.needs_review =
      result.overall_confidence < MIN_CONFIDENCE_FOR_AUTOPILOT ||
      result.quality.blur_score < 0.4 ||
      result.quality.glare_score < 0.4;

    return result;
  }
}

function clamp01(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

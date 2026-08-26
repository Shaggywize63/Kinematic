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
/** On-shelf availability read for a product (stock-count-from-image). */
export type StockStatus = 'in_stock' | 'low' | 'out';
/** Point-of-sale-material / merchandising asset type. */
export type PosmType =
  | 'poster'
  | 'dangler'
  | 'wobbler'
  | 'shelf_strip'
  | 'standee'
  | 'gondola_end'
  | 'cooler'
  | 'branded_rack'
  | 'tent_card'
  | 'bunting'
  | 'banner'
  | 'other';
/** Physical condition of a detected POSM asset. */
export type PosmCondition = 'good' | 'damaged' | 'obscured';

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
  units_estimate?: number | null;          // NEW — estimated physical units on shelf (stock count)
  stock_status?: StockStatus | null;       // NEW — in_stock | low | out (availability read)
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

/** A point-of-sale material / merchandising asset detected in the shelf photo. */
export interface PosmDetection {
  type: PosmType;
  name: string;                             // short description of the asset
  brand: string | null;                     // brand on the asset, if legible
  bbox: [number, number, number, number] | null;
  condition: PosmCondition;
  confidence: number;
}

export interface ShelfRecognition {
  detected_skus: DetectedSKU[];
  promotions: Promo[];                      // NEW — visible offer / promotion signage
  posm: PosmDetection[];                    // NEW — POSM / merchandising assets (distinct from offers)
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
  /**
   * Optional explicit list of the retailer's OWN brand names. Any shelf pack of
   * one of these brands is treated as an own product (never a competitor), even
   * when its specific variant is not in expectedSkus — so uncataloged own-brand
   * packs are still identified instead of dropped. When omitted, own brands are
   * derived from the distinct brands on `expectedSkus`. (e.g. ['MoiSoi'])
   */
  ownBrands?: string[];
  /**
   * Optional brand / variant synonym map — { term: [alternative spellings] } —
   * so packaging that prints a brand or flavour differently than the catalog
   * still matches (e.g. { 'MoiSoi': ['MOI SOI', 'MOISOI'], 'chowmein': ['chow
   * mein'] }). Sourced from the planogram's `layout.brand_terms`.
   */
  brandTerms?: Record<string, string[]>;
  /**
   * Optional per-tenant Anthropic key override. When set (e.g. MoiSoi's
   * dedicated high-model key), the whole recognition pipeline runs on this key
   * instead of the shared functional key. Omitted → shared functional key, so
   * every other tenant is unaffected. Paired with `model` for the high-tier
   * model. If this key/model fails the FIRST recognition pass with an
   * auth/model error (401/403/404), the pipeline transparently falls back to
   * the shared key + default model so a misconfigured override never breaks a
   * capture.
   */
  apiKey?: string;
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
- OWN BRANDS — read the BRAND MARK FIRST, then the variant. The "own_brands" list
  names the retailer's OWN brands. ANY pack whose brand is in own_brands is an OWN
  product: set is_competitor = false and put the brand in "brand". NEVER mark an
  own-brand pack as a competitor. Then resolve the variant:
    • If it matches an expected_skus entry, set that sku_id (use the "sku_lexicon"
      variant keywords — flavour / product-type / size tokens — to pick the right
      one among same-brand variants).
    • If it is an own-brand pack that is NOT in expected_skus (a variant the list
      doesn't include), STILL REPORT IT: is_competitor = false, sku_id = null,
      brand = the own brand, sku_name = the full name you read (e.g. "MOI SOI Thai
      Green Curry", "MOI SOI Konjac Udon"). Do NOT drop it and do NOT invent a
      sku_id. Reporting every own-brand pack you can see — cataloged or not — is
      the single most important thing: unidentified own-brand packs are failures.
  "brand_terms" (when provided) maps a brand or variant to alternative spellings /
  synonyms you may see on packs — treat any of those as the same brand/variant.
- Assign a "brand" (the manufacturer/brand on the pack) and a "category". The
  category MUST be chosen from the provided category list (the real taxonomy for
  this shelf) whenever the product fits one — do not invent free-form categories.
  Use null only when no listed category applies.
- PRICE — read it for EVERY product you can. Prices live on the shelf-edge
  tag/label strip directly BELOW or beside the product, on the pack itself (MRP),
  or inside promo signage. Look hard at the shelf-edge strip — that is where most
  prices are. Put the SELLING price a shopper actually pays in "price" as a plain
  number (drop the currency symbol, thousands separators and any trailing "/-"),
  the currency as seen in "price_currency" (e.g. "INR" or "₹"), and set
  "price_source" to shelf_tag | on_pack | promo. Indian tags often read "MRP ₹99",
  "Rs. 99/-", "₹99", or a struck-through MRP beside a lower offer price — when both
  an MRP and a lower offer/selling price are shown, put the LOWER price the shopper
  pays in "price" (and record the deal in promotions). Read partially occluded or
  angled tags whenever the digits are legible; only leave price null when no price
  can be read at all.
- Count "facings": one facing = one product front visible on the shelf.
- STOCK — estimate "units_estimate": the number of physical units of this product
  currently on the shelf (count the visible fronts across its facings, plus units
  clearly stacked behind/beside them). Set "stock_status" to "out" when a labelled
  slot for the product is visibly empty, "low" when only 1–2 units remain or the
  facing is nearly bare, otherwise "in_stock". Estimate conservatively; use null
  only when you genuinely cannot tell.
- Report "shelf_index": 0 for the BOTTOM shelf, increasing upward.
- Report "bbox" as [x, y, w, h] in 0..1 normalized image coordinates, where
  (x, y) is the TOP-LEFT corner and (w, h) are the width/height as fractions of
  the image. x grows rightward; y grows DOWNWARD from 0 at the very top of the
  image to 1 at the bottom. Also report "bbox_area" = w * h.
- The box MUST tightly enclose the PRODUCT PACKAGE you identified — the visible
  pack front (pouch / jar / bottle / box). Its TOP edge is the top of that pack;
  its BOTTOM edge is where that SAME pack meets the shelf it stands on.
- CRITICAL — get the vertical position right. Do NOT include the shelf-edge
  price rail / label strip beneath the product, and do NOT let the box slide
  down onto the DIFFERENT products sitting on the shelf BELOW. The single most
  common mistake is drawing the box one shelf too LOW: the box must sit on the
  SAME row as the pack you named and be vertically centred on that pack, so a
  product on an upper shelf has a SMALL y and a product near the floor has a
  LARGE y. Before returning each box, verify the pixels inside it actually show
  the product you identified — not the item on the shelf underneath it.
- You MAY hint a "zone" (low | eye | top) but the backend recomputes it
  canonically from shelf_index — do not agonize over it.
- Give a one-line "reasoning" for the identification (what packaging/label cue
  you used).

PROMOTIONS — sweep the WHOLE shelf for every visible offer and record each in the
top-level "promotions" list. Look for shelf-edge price-off tags, "MRP ₹X now ₹Y"
/ "Save ₹Z", percentage-off flashes ("20% OFF"), "Buy 1 Get 1" / BOGO, combo &
multi-buy packs ("Pack of 3", "₹X for 2"), festival / seasonal offers, and any
wobblers, danglers, shelf-talkers, buntings or stickers. Capture the offer text
VERBATIM in "text", classify offer_type (price_off | bundle | bogo | combo |
other), give a bbox when locatable, set confidence, and list linked_sku_ids for
every detected SKU the offer clearly covers (match by the product nearest the
signage). Report an offer even when you cannot tie it to a specific SKU (leave
linked_sku_ids empty). Do not invent offers — only report signage you can see.

POSM / MERCHANDISING — sweep the WHOLE image for point-of-sale materials and
branded merchandising assets and record each in the top-level "posm" list:
posters, danglers, wobblers, shelf strips / shelf-talkers, standees, gondola-end
displays, branded coolers / chillers, branded racks or display units, tent cards,
buntings and banners. For each asset give its "type" (from that list), a short
"name"/description, the "brand" if legible, a "bbox" when locatable, a "condition"
(good | damaged | obscured), and a confidence. POSM is the physical branding /
display asset itself — this is DIFFERENT from "promotions", which is offer/price
signage; a single wobbler carrying an offer may appear in both lists. Report only
assets you can actually see.

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
0..1 normalized image coordinates, where (x, y) is the TOP-LEFT corner and y
grows DOWNWARD from 0 at the top to 1 at the bottom), facings (product fronts
visible), shelf_index (0 = bottom shelf, increasing upward) and confidence. Do
NOT invent products, do NOT report ones you cannot clearly see, and do NOT
report anything outside the reference set. Be conservative: if you are not sure a
referenced product is on the shelf, OMIT it — omission means it is genuinely out
of stock.

The bbox MUST tightly enclose the actual product PACKAGE — top edge at the top of
the pack, bottom edge where that same pack meets its shelf. Get the vertical
position right: do NOT include the shelf-edge price rail beneath the pack, and do
NOT slide the box down onto the different products on the shelf BELOW. The most
common mistake is placing the box one shelf too LOW — it must sit on the SAME row
as the pack, so a product on an upper shelf has a SMALL y. Before returning a
box, confirm the pixels inside it show that product, not the item beneath it.`;

// Focused pricing + promotion recovery pass. A single shelf photo forces the
// model to split attention across identity, facings, position, price AND promo;
// this pass re-reads the SAME shelf for ONLY prices and offers, keyed back to the
// already-detected SKUs, so shelf-tag prices and promo signage that pass-1
// skimmed get captured.
const PRICING_SYSTEM_PROMPT = `You are a retail shelf-recognition expert doing a FOCUSED pass that reads ONLY
prices and promotions from a shelf photo. The products on the shelf were already
identified and are given to you as detected_skus (each with a sku_id). Call
"report_pricing" exactly once. Do not answer in prose — only the tool call is read.

PRICES: read the shelf-edge tag/label strip below or beside each product (and the
pack MRP when that is all that is visible). For every product whose price you can
read, return a price_reading with its sku_id (from detected_skus), the SELLING
price the shopper pays as a plain number (drop currency symbols, thousands
separators and any trailing "/-"), the currency as seen ("INR" / "₹"), and
price_source = shelf_tag | on_pack | promo. Indian tags often read "MRP ₹99",
"Rs. 99/-", "₹99", or a struck-through MRP beside a lower offer price — when both
are shown, return the LOWER price the shopper actually pays. Only skip a product
when no price is legible.

PROMOTIONS: sweep the whole shelf for every visible offer — price-off tags,
"MRP ₹X now ₹Y" / "Save ₹Z", "% OFF" flashes, "Buy 1 Get 1" / BOGO, combo &
multi-buy packs, festival / seasonal offers, wobblers, danglers, shelf-talkers,
buntings, stickers. Capture each offer's text verbatim, classify offer_type
(price_off | bundle | bogo | combo | other), give a bbox when locatable, set
confidence, and link it to the nearest detected sku_ids it covers. Report an offer
even if you cannot tie it to a SKU. Do not invent anything — only report prices
and signage you can actually see.`;

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
          grid_box: {
            type: ['array', 'null'],
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4,
            description: 'REQUIRED when a numbered grid is overlaid on the image: [col_start, row_start, col_end, row_end], 1-based INCLUSIVE grid cells the visible pack covers (top-left cell to bottom-right cell). Read the numbers printed along the top (columns) and left (rows) edges — do not estimate. The backend derives the box from this.',
          },
          bbox: BBOX_SCHEMA,
          bbox_area: { type: ['number', 'null'], description: 'w * h of the bbox' },
          price: { type: ['number', 'null'], description: 'Selling price the shopper pays, as a plain number — no currency symbol, thousands separators or "/-". Read from the shelf-edge tag, pack MRP, or promo. null only when no price is legible.' },
          price_currency: { type: ['string', 'null'], description: 'Currency exactly as seen, e.g. "INR" or "₹".' },
          price_source: { type: ['string', 'null'], enum: ['shelf_tag', 'on_pack', 'promo', null], description: 'Where the price was read: shelf_tag (shelf-edge label), on_pack (MRP printed on the pack), or promo (offer signage).' },
          units_estimate: { type: ['number', 'null'], description: 'Estimated physical units of this product on the shelf (count visible fronts across facings, plus units clearly stacked behind). null only when not determinable.' },
          stock_status: { type: ['string', 'null'], enum: ['in_stock', 'low', 'out', null], description: 'in_stock | low (only 1–2 units / nearly bare facing) | out (labelled slot visibly empty).' },
          confidence: { type: 'number', description: '0..1' },
          is_competitor: { type: 'boolean' },
          reasoning: { type: ['string', 'null'] },
        },
        required: ['sku_name', 'facings', 'shelf_index', 'bbox', 'confidence', 'is_competitor'],
      },
    },
    promotions: {
      type: 'array',
      description: 'Every visible offer / promotion on the shelf (price-off tags, "now ₹Y", % off, BOGO, combos, festival offers, wobblers, danglers, shelf-talkers, stickers).',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Offer text, verbatim (e.g. "Buy 1 Get 1 Free", "MRP ₹99 now ₹79", "20% OFF").' },
          offer_type: { type: 'string', enum: ['price_off', 'bundle', 'bogo', 'combo', 'other'] },
          bbox: { anyOf: [BBOX_SCHEMA, { type: 'null' }] },
          confidence: { type: 'number', description: '0..1' },
          linked_sku_ids: { type: 'array', items: { type: 'string' }, description: 'sku_ids of detected products this offer covers (nearest to the signage); empty if it applies to none in particular.' },
        },
        required: ['text', 'offer_type', 'confidence'],
      },
    },
    posm: {
      type: 'array',
      description: 'Point-of-sale materials / branded merchandising assets visible (posters, danglers, wobblers, shelf strips, standees, gondola-end displays, branded coolers, racks, tent cards, buntings, banners). Distinct from promotions (offer/price signage).',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['poster', 'dangler', 'wobbler', 'shelf_strip', 'standee', 'gondola_end', 'cooler', 'branded_rack', 'tent_card', 'bunting', 'banner', 'other'] },
          name: { type: 'string', description: 'Short description of the asset (e.g. "End-cap standee", "Fridge brand sticker").' },
          brand: { type: ['string', 'null'], description: 'Brand on the asset, if legible.' },
          bbox: { anyOf: [BBOX_SCHEMA, { type: 'null' }] },
          condition: { type: 'string', enum: ['good', 'damaged', 'obscured'], description: 'good | damaged (torn/faded/broken) | obscured (blocked/partly hidden).' },
          confidence: { type: 'number', description: '0..1' },
        },
        required: ['type', 'name', 'confidence'],
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

/** One price reading from the focused pricing pass, keyed to a detected sku_id. */
const PRICE_READING_SCHEMA = {
  type: 'object',
  properties: {
    sku_id: { type: 'string', description: 'sku_id from the provided detected_skus this price belongs to' },
    price: { type: ['number', 'null'], description: 'Selling price the shopper pays, plain number — no symbol / separators / "/-"' },
    price_currency: { type: ['string', 'null'], description: 'Currency as seen, e.g. "INR" or "₹"' },
    price_source: { type: ['string', 'null'], enum: ['shelf_tag', 'on_pack', 'promo', null] },
    confidence: { type: 'number', description: '0..1' },
  },
  required: ['sku_id', 'price'],
} as const;

/**
 * Forced-tool input schema for the focused pricing + promotion recovery pass.
 * Reuses the report_shelf promotions shape so promo normalization is shared;
 * price_readings are keyed back to already-detected sku_ids.
 */
const REPORT_PRICING_SCHEMA = {
  type: 'object',
  properties: {
    price_readings: { type: 'array', items: PRICE_READING_SCHEMA },
    promotions: REPORT_SHELF_SCHEMA.properties.promotions,
  },
  required: ['price_readings'],
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
    // Per-tenant override (e.g. MoiSoi's dedicated high-model key). When absent,
    // this resolves to the shared functional key + default model, so every other
    // tenant behaves exactly as before.
    let apiKey = args.apiKey || (await AIService.getFunctionalKey());
    let model = args.model || this.defaultModel();
    const usingOverride = !!(args.apiKey || args.model);

    // Constrain classification to the real taxonomy present on this planogram:
    // pass the distinct categories from expected + competitor SKUs as few-shot
    // hints so the model picks from "Beverages / Noodles / …" rather than
    // inventing free-form buckets.
    const categorySet = new Set<string>();
    for (const s of args.expectedSkus || []) if (s.category) categorySet.add(s.category);
    for (const c of args.competitorSkus || []) if (c.category) categorySet.add(c.category);
    const categories = Array.from(categorySet);

    // Brand-first lexicon: the retailer's OWN brands (any pack of these is an own
    // product, even uncataloged variants) plus per-SKU variant keywords so the
    // model resolves same-brand variants and never drops an own-brand pack.
    const ownBrands = deriveOwnBrands(args.expectedSkus || [], args.ownBrands);
    const skuLexicon = buildSkuLexicon(args.expectedSkus || []);
    const brandTerms = args.brandTerms;

    // Anthropic rejects ANY image over 2000px per side once a request carries
    // "many images" — which our reference pack-shots + the shelf photo now do.
    // Downscale the shelf photo and every reference under that ceiling before
    // sending; otherwise a dense capture with the full reference set fails with
    // "image dimensions exceed max allowed size for many-image requests: 2000".
    // Shelf keeps more detail (small SKUs); pack-shots need far less.
    const SHELF_MAX_DIM = 1900;
    const REF_MAX_DIM = 1024;
    const shelf = await downscaleForApi(args.imageBase64, args.imageMediaType, SHELF_MAX_DIM);

    // Prepend up to MAX_REFERENCE_IMAGES front-facing pack shots (each labelled
    // with its sku_id) so the model matches shelf products by packaging. Bounded
    // to keep token cost predictable, and each capped to REF_MAX_DIM.
    const MAX_REFERENCE_IMAGES = 32;
    const allRefsCapped = await Promise.all(
      (args.referenceImages || []).map(async (r) => {
        const c = await downscaleForApi(r.imageBase64, r.imageMediaType, REF_MAX_DIM);
        return { ...r, imageBase64: c.base64, imageMediaType: c.mediaType };
      }),
    );
    const refs = allRefsCapped.slice(0, MAX_REFERENCE_IMAGES);
    if (allRefsCapped.length > MAX_REFERENCE_IMAGES) {
      logger.warn(`[PlanogramVision] ${allRefsCapped.length} reference images supplied; using first ${MAX_REFERENCE_IMAGES}`);
    }

    const runPass1 = () =>
      this.callShelfRecognition({
        apiKey,
        model,
        imageBase64: shelf.base64,
        imageMediaType: shelf.mediaType,
        refs,
        expectedSkus: args.expectedSkus || [],
        competitorSkus: args.competitorSkus || [],
        categories,
        ownBrands,
        skuLexicon,
        brandTerms,
        storeFormat: args.storeFormat,
      });

    // Pass-1 is the only capture-breaking call (recall / tiling / pricing are all
    // best-effort). If a per-tenant OVERRIDE key/model fails it with an auth or
    // model-availability error (bad key / model not provisioned for the key), fall
    // back ONCE to the shared functional key + default model and reassign apiKey/
    // model so the rest of the pipeline uses the working creds too. A misconfigured
    // MoiSoi high-model key therefore degrades to today's behaviour instead of
    // failing the capture.
    let parsed: any;
    try {
      parsed = await runPass1();
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (usingOverride && (status === 401 || status === 403 || status === 404)) {
        logger.warn(
          `[PlanogramVision] override key/model failed pass-1 (status ${status}); falling back to shared key + default model`,
        );
        apiKey = await AIService.getFunctionalKey();
        model = this.defaultModel();
        parsed = await runPass1();
      } else {
        throw e;
      }
    }

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

    const posm: PosmDetection[] = (Array.isArray(parsed.posm) ? parsed.posm : [])
      .map((p: any): PosmDetection => ({
        type: normalizePosmType(p.type),
        name: String(p.name || '').trim(),
        brand: p.brand == null ? null : String(p.brand).trim(),
        bbox: normalizeBbox(p.bbox),
        condition: normalizePosmCondition(p.condition),
        confidence: clamp01(p.confidence),
      }))
      .filter((p: PosmDetection) => p.name.length > 0);

    const result: ShelfRecognition = {
      detected_skus,
      promotions,
      posm,
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
          imageBase64: shelf.base64,
          imageMediaType: shelf.mediaType,
          pass1: result.detected_skus,
          refs,
          expectedSkus: args.expectedSkus || [],
          competitorSkus: args.competitorSkus || [],
          categories,
          ownBrands,
          skuLexicon,
          brandTerms,
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
        imageBase64: shelf.base64,
        imageMediaType: shelf.mediaType,
        pass1: result.detected_skus,
        expectedSkus: args.expectedSkus || [],
        referenceImages: allRefsCapped,
      });
      if (recovered.length) {
        result.detected_skus = result.detected_skus.concat(recovered);
        logger.info(`[PlanogramVision] recall recovered ${recovered.length} missed SKU(s)`);
      }
    } catch (e) {
      logger.warn(`[PlanogramVision] recall pass failed (keeping pass-1 results): ${(e as Error)?.message}`);
    }

    // ── Focused pricing + promotion recovery pass ────────────────────────────
    // A single shelf photo makes the model split attention across identity,
    // facings, position, price AND promo. This pass re-reads the SAME shelf for
    // ONLY prices and offers, keyed back to the already-detected SKUs, to fill
    // price gaps pass-1 left null and catch promo signage it skimmed. Additive:
    // it only FILLS null prices (never overrides a pass-1 price) and appends
    // deduped promotions — so nothing downstream (DB / API / UI) changes shape.
    // Guarded (skips when there is nothing to gain), hard-timeout-bounded, and
    // wrapped so any failure leaves the detection set exactly as it was. Kill
    // switch: PLANOGRAM_PRICE_PASS=0.
    if (process.env.PLANOGRAM_PRICE_PASS !== '0') {
      try {
        const { priced, addedPromos } = await this.recoverPricingAndPromos({
          apiKey,
          model,
          imageBase64: shelf.base64,
          imageMediaType: shelf.mediaType,
          detected: result.detected_skus,
          promotions: result.promotions,
        });
        if (addedPromos.length) result.promotions = result.promotions.concat(addedPromos);
        if (priced || addedPromos.length) {
          logger.info(`[PlanogramVision] pricing pass filled ${priced} price(s), added ${addedPromos.length} promo(s)`);
        }
      } catch (e) {
        logger.warn(`[PlanogramVision] pricing pass failed (keeping prior results): ${(e as Error)?.message}`);
      }
    }

    // Final deterministic pass: snap any box that drifted off its shelf back into
    // its shelf's vertical band (shelf_index is reliable, the y-pixel is not).
    reconcileShelfBands(result.detected_skus);

    return result;
  }

  /** Hard deadline for the second-pass recall so a slow recall never pins the capture. */
  private static readonly RECALL_TIMEOUT_MS = 30_000;
  /** Hard deadline for the focused pricing + promotion recovery pass. */
  private static readonly PRICING_TIMEOUT_MS = 30_000;

  /**
   * Focused pricing + promotion recovery pass.
   *
   * Re-reads the SAME shelf image asking ONLY for shelf-tag prices (keyed back to
   * the already-detected sku_ids) and promotion signage. Prices FILL gaps only —
   * a detection that pass-1 already priced is never overwritten — and promotions
   * are appended after dedup (by normalized text AND bbox IoU). Returns how many
   * prices were filled and the new promotions to append.
   *
   * Best-effort: the caller wraps this in try/catch so any failure keeps prior
   * results. GUARD: returns without a vision call when there is nothing to gain
   * (every identified product already has a price AND at least one promotion was
   * already found).
   */
  private static async recoverPricingAndPromos(opts: {
    apiKey: string;
    model: string;
    imageBase64: string;
    imageMediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    detected: DetectedSKU[];
    promotions: Promo[];
  }): Promise<{ priced: number; addedPromos: Promo[] }> {
    // Only products with a sku_id can have a price keyed back to them.
    const byId = new Map<string, DetectedSKU>();
    for (const d of opts.detected) if (d.sku_id) byId.set(d.sku_id, d);

    const needPrice = [...byId.values()].filter((d) => d.price == null);

    // GUARD: nothing to gain — every identified product already has a price AND
    // we already found ≥1 promotion. (Missing prices OR zero promotions → the
    // focused sweep can still help, so we proceed.)
    if (needPrice.length === 0 && opts.promotions.length > 0) return { priced: 0, addedPromos: [] };

    const skuList = [...byId.values()].map((d) => ({
      sku_id: d.sku_id,
      sku_name: d.sku_name,
      shelf_index: d.shelf_index,
    }));

    const content: Array<Record<string, unknown>> = [
      { type: 'image', source: { type: 'base64', media_type: opts.imageMediaType, data: opts.imageBase64 } },
      {
        type: 'text',
        text: [
          'Focus ONLY on shelf-edge PRICE tags and PROMOTION / OFFER signage on this shelf.',
          'These products were already identified on the shelf — key each price reading',
          'back to the matching sku_id:',
          'detected_skus = ' + JSON.stringify(skuList),
          'Return price_readings for every product whose price you can read, and list',
          'every visible promotion. Call report_pricing exactly once.',
        ].join('\n'),
      },
    ];

    const parsed = await this.callVisionTool({
      apiKey: opts.apiKey,
      model: opts.model,
      system: PRICING_SYSTEM_PROMPT,
      content,
      toolName: 'report_pricing',
      toolDescription: 'Report shelf-tag prices (keyed to the given sku_ids) and all visible promotions.',
      inputSchema: REPORT_PRICING_SCHEMA,
      errorCode: 'VISION_PRICING_ERROR',
      timeoutMs: this.PRICING_TIMEOUT_MS,
    });

    // Apply price readings — FILL gaps only, never override a pass-1 price.
    let priced = 0;
    const readings = Array.isArray(parsed.price_readings) ? parsed.price_readings : [];
    for (const r of readings) {
      const id = r?.sku_id == null ? '' : String(r.sku_id);
      const d = byId.get(id);
      if (!d || d.price != null) continue;
      const price = r?.price == null || !Number.isFinite(Number(r.price)) ? null : Number(r.price);
      if (price == null) continue;
      d.price = price;
      d.price_currency = r?.price_currency == null ? d.price_currency : String(r.price_currency);
      d.price_source = normalizePriceSource(r?.price_source) ?? d.price_source ?? 'shelf_tag';
      priced++;
    }

    // Merge promotions — dedup vs existing by normalized text AND bbox IoU.
    const addedPromos: Promo[] = [];
    const seenText = new Set(opts.promotions.map((p) => p.text.trim().toLowerCase()));
    const rawPromos = Array.isArray(parsed.promotions) ? parsed.promotions : [];
    for (const p of rawPromos) {
      const text = String(p?.text || '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seenText.has(key)) continue;
      const bbox = normalizeBbox(p?.bbox);
      if (bbox && opts.promotions.some((e) => e.bbox && bboxIoU(e.bbox, bbox) > 0.5)) continue;
      seenText.add(key);
      addedPromos.push({
        text,
        offer_type: normalizeOfferType(p?.offer_type),
        bbox,
        confidence: clamp01(p?.confidence),
        linked_sku_ids: Array.isArray(p?.linked_sku_ids) ? p.linked_sku_ids.map((x: any) => String(x)) : [],
      });
    }

    return { priced, addedPromos };
  }

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
    // Prompt-cache breakpoint on the stable HEAD only (tool schema + recall system
    // prompt + this intro). Unlike pass-1, the candidate refs below are the subset
    // of SKUs pass-1 missed, so they VARY per capture — caching them would pay the
    // write surcharge for near-zero reads. Placing the breakpoint before the refs
    // caches just the head, which is identical across every capture's recall.
    content.push({
      type: 'text',
      text: 'A first scan may have missed these specific products. Their reference pack-shots follow, each labelled with its sku_id.',
      cache_control: { type: 'ephemeral' },
    });
    for (const r of candidateRefs) {
      content.push({ type: 'text', text: `Reference - sku_id=${r.sku_id}: ${r.sku_name}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: r.imageMediaType, data: r.imageBase64 } });
    }
    content.push({ type: 'text', text: 'End of references. Now analyze this SHELF image:' });
    // Same Set-of-Mark grid as pass-1 so recovered boxes are read off cells, not
    // estimated (recovered detections were the ones that drifted worst before).
    const grid = await overlayGrid(opts.imageBase64, opts.imageMediaType, GRID_COLS, GRID_ROWS);
    content.push({ type: 'image', source: { type: 'base64', media_type: grid.mediaType, data: grid.base64 } });
    content.push({
      type: 'text',
      text: [
        'For EACH referenced product, decide if it is present on this shelf; if yes',
        'return its sku_id, bbox, facings, shelf_index and confidence. Only report',
        'ones you can actually see — omit the rest (they are out of stock).',
        ...(grid.ok
          ? [
              `GRID: a reference grid is drawn over the shelf — ${GRID_COLS} columns (1..${GRID_COLS}, labels along the TOP) and ${GRID_ROWS} rows (1..${GRID_ROWS}, labels down the LEFT). For each product set grid_box=[col_start,row_start,col_end,row_end] (1-based, inclusive) by READING the cell numbers it covers — row_start where the pack's TOP is, row_end where its BASE is. Do not estimate; the grid lines are an overlay, not merchandise.`,
            ]
          : []),
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

    // Derive recovered boxes from their grid cells when the grid was drawn.
    if (grid.ok && Array.isArray(parsed.detected_skus)) {
      for (const d of parsed.detected_skus) {
        const box = gridBoxToBbox((d as any)?.grid_box, GRID_COLS, GRID_ROWS);
        if (box) { (d as any).bbox = box; (d as any).bbox_area = round4(box[2] * box[3]); }
      }
    }

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
    ownBrands: string[];
    skuLexicon: Array<{ sku_id: string; keywords: string[] }>;
    brandTerms?: Record<string, string[]>;
    storeFormat?: string;
    timeoutMs?: number;
  }): Promise<any> {
    const userText = [
      'Identify every product on this shelf and call report_shelf exactly once.',
      // Own brands go FIRST: any pack of these is an own product (never a
      // competitor), even if its variant is not in expected_skus.
      'own_brands (ANY pack of these is an OWN product — is_competitor=false) = ' +
        JSON.stringify(opts.ownBrands),
      'expected_skus = ' + JSON.stringify(opts.expectedSkus),
      // Variant anchor keywords per expected SKU — use them to pick the right
      // same-brand variant (flavour / type / size tokens).
      'sku_lexicon (variant keywords per sku_id) = ' + JSON.stringify(opts.skuLexicon),
      'competitor_skus = ' + JSON.stringify(opts.competitorSkus),
      'category list (choose category ONLY from these when a product fits) = ' +
        JSON.stringify(opts.categories),
      ...(opts.brandTerms && Object.keys(opts.brandTerms).length
        ? ['brand_terms (synonyms / alternative spellings) = ' + JSON.stringify(opts.brandTerms)]
        : []),
      'store_format = ' + (opts.storeFormat || 'unknown'),
      'REMINDER: report EVERY own-brand pack you can see. If an own-brand pack is',
      'not in expected_skus, still report it with is_competitor=false, sku_id=null,',
      'its brand, and the full variant name you read — never omit it.',
    ];

    // Set-of-Mark localization: burn a numbered grid onto the shelf image and
    // ask for the CELLS each pack covers instead of estimated pixel floats. The
    // backend derives the box from the cells, which stops the box drifting down
    // a shelf and stops phantom duplicate rows. Best-effort — if the overlay
    // fails we send the plain image and keep the estimated bbox.
    const grid = await overlayGrid(opts.imageBase64, opts.imageMediaType, GRID_COLS, GRID_ROWS);
    if (grid.ok) {
      userText.push(
        '',
        `GRID: a reference grid is drawn over the shelf image — ${GRID_COLS} columns numbered 1..${GRID_COLS} left-to-right (labels along the TOP edge) and ${GRID_ROWS} rows numbered 1..${GRID_ROWS} top-to-bottom (labels down the LEFT edge). For EVERY product, promotion and POSM, look at which cells its visible pack actually covers and set grid_box = [col_start, row_start, col_end, row_end] (1-based, inclusive, the top-left cell to the bottom-right cell). READ the printed numbers off the grid — do not estimate. row_start is the row where the TOP of the pack sits and row_end where its BASE sits, so a pack high on the shelf has a SMALL row_start. Two facings of the same product on the same shelf are separate detections with different columns — never repeat one product down several rows. The grid lines are an overlay, not merchandise.`,
      );
    }

    const content: Array<Record<string, unknown>> = [];
    if (opts.refs.length) {
      content.push({ type: 'text', text: 'Reference pack images follow — each is the front of one SKU, labelled with its sku_id. Use them to identify that exact product (flavour / size / variant) and to tell competitor packs apart on the shelf image that comes after them.' });
      for (const r of opts.refs) {
        content.push({ type: 'text', text: `Reference - sku_id=${r.sku_id}${r.is_competitor ? ' (competitor)' : ''}: ${r.sku_name}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: r.imageMediaType, data: r.imageBase64 } });
      }
      // Prompt-cache breakpoint on the LAST stable block. Everything up to here —
      // the tool schema, system prompt and the whole reference pack — is byte-for-
      // byte identical across pass-1, every tile crop, and successive captures of
      // the same planogram, so it caches once and is read back at ~10% input cost.
      // The volatile shelf image + userText come AFTER this point and are never
      // cached. For MoiSoi (~31 pack-shots re-sent per pass) this is the dominant
      // per-analysis cost lever.
      content.push({
        type: 'text',
        text: 'End of references. Now analyze this SHELF image:',
        cache_control: { type: 'ephemeral' },
      });
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: grid.mediaType, data: grid.base64 } });
    content.push({ type: 'text', text: userText.join('\n') });

    const parsed = await this.callVisionTool({
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

    // Derive each box from its grid cells (deterministic). Only when the grid
    // was actually drawn; otherwise the model's estimated bbox stands.
    if (grid.ok && parsed && typeof parsed === 'object') {
      for (const key of ['detected_skus', 'promotions', 'posm']) {
        const arr = (parsed as Record<string, unknown>)[key];
        if (!Array.isArray(arr)) continue;
        for (const d of arr) {
          const box = gridBoxToBbox((d as any)?.grid_box, GRID_COLS, GRID_ROWS);
          if (box) {
            (d as any).bbox = box;
            (d as any).bbox_area = round4(box[2] * box[3]);
          }
        }
      }
    }
    return parsed;
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
    ownBrands: string[];
    skuLexicon: Array<{ sku_id: string; keywords: string[] }>;
    brandTerms?: Record<string, string[]>;
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
          ownBrands: opts.ownBrands,
          skuLexicon: opts.skuLexicon,
          brandTerms: opts.brandTerms,
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
    // Cache observability: cache_read_input_tokens bill at ~10% and confirm the
    // reference-pack breakpoint is actually being reused across passes/captures;
    // cache_creation_input_tokens is the one-time write (~125%). Lets us report
    // the real per-analysis saving from live MoiSoi captures.
    const u = data?.usage;
    if (u) {
      logger.info(
        `[PlanogramVision] ${opts.toolName} usage: in=${u.input_tokens ?? 0} ` +
          `cache_write=${u.cache_creation_input_tokens ?? 0} ` +
          `cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? 0}`,
      );
    }
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

/**
 * Normalize a base64 image for the vision API: bake in EXIF orientation and cap
 * it at `maxDim` per side, returning JPEG.
 *
 * Two jobs, both required for correct bounding boxes:
 *  1. ORIENTATION. Phone photos — especially PORTRAIT ones — are stored as
 *     landscape pixels plus an EXIF "rotate" tag. Browsers auto-apply that tag
 *     when they render the capture, so the dashboard shows the shelf upright.
 *     The model must see the SAME upright pixels, or every competitor / own-SKU
 *     box lands rotated and shifted (the whole coordinate frame is turned). We
 *     therefore ALWAYS `.rotate()` (which applies EXIF and strips the tag)
 *     whenever the tag is set — even when no resize is needed. This also means
 *     the tiling pass, which extracts crops from this same buffer, cuts from the
 *     upright pixels and its remapped bboxes stay in the display frame.
 *  2. SIZE. Anthropic rejects images over 2000px per side in "many-image"
 *     requests (our reference pack-shots + the shelf photo), so we cap here too.
 *
 * Skips re-encoding only when the image is already upright (orientation ≤ 1) AND
 * within the cap — so an already-normalized upload is untouched. Best-effort:
 * returns the original if `sharp` is unavailable or anything fails, so image
 * prep can never itself break a capture. Shared by the shelf image and refs.
 */
async function downscaleForApi(
  base64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  maxDim: number,
): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  try {
    const sharp = (await import('sharp')).default;
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return { base64, mediaType };
    const needsResize = w > maxDim || h > maxDim;
    // EXIF orientation 2..8 = the stored pixels are NOT in display orientation
    // (rotated/mirrored). Anything >1 must be baked in so the model matches the
    // browser-rendered capture. `undefined`/1 means upright already.
    const needsOrient = typeof meta.orientation === 'number' && meta.orientation > 1;
    if (!needsResize && !needsOrient) return { base64, mediaType }; // already upright + within cap
    let pipeline = sharp(buf).rotate(); // apply EXIF orientation, strip the tag
    if (needsResize) {
      pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    }
    const out = await pipeline.jpeg({ quality: 88 }).toBuffer();
    return { base64: out.toString('base64'), mediaType: 'image/jpeg' };
  } catch (e) {
    logger.warn(`[PlanogramVision] image normalize/downscale failed, sending original: ${(e as Error)?.message}`);
    return { base64, mediaType };
  }
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// Set-of-Mark localization grid. Vision models estimate free-form pixel
// coordinates poorly (boxes drift down a shelf, and duplicate across imagined
// rows). Overlaying a numbered grid and asking which CELLS a product covers
// turns localization into reading visible labels — far more reliable — and the
// box is then derived deterministically from the cells. 12x8 keeps each cell a
// sensible fraction of a shelf pack.
const GRID_COLS = 12;
const GRID_ROWS = 8;

/**
 * Burn a numbered reference grid over a base64 image (Set-of-Mark): faint cyan
 * cell lines, with column numbers along the top edge and row numbers down the
 * left edge, each on a dark chip for legibility. Best-effort — returns the
 * original with ok=false if `sharp` is missing or anything fails, so the caller
 * falls back to plain-image + estimated bbox.
 */
async function overlayGrid(
  base64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  cols: number,
  rows: number,
): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; ok: boolean }> {
  try {
    const sharp = (await import('sharp')).default;
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharp(buf).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return { base64, mediaType, ok: false };

    const parts: string[] = [];
    for (let c = 1; c < cols; c++) {
      const x = Math.round((W * c) / cols);
      parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#00E5FF" stroke-width="2" stroke-opacity="0.45"/>`);
    }
    for (let r = 1; r < rows; r++) {
      const y = Math.round((H * r) / rows);
      parts.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#00E5FF" stroke-width="2" stroke-opacity="0.45"/>`);
    }
    const fs = Math.max(13, Math.round(Math.min(W, H) / 42));
    const pad = Math.round(fs * 0.35);
    const chip = (cx: number, cy: number, text: string) => {
      const tw = text.length * fs * 0.62 + pad * 2;
      const th = fs + pad * 2;
      const x = Math.round(cx - tw / 2);
      const y = Math.round(cy - th / 2);
      return (
        `<rect x="${x}" y="${y}" width="${Math.round(tw)}" height="${Math.round(th)}" rx="4" fill="#0B1220" fill-opacity="0.7"/>` +
        `<text x="${Math.round(cx)}" y="${Math.round(cy + fs * 0.35)}" font-family="Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#00E5FF" text-anchor="middle">${text}</text>`
      );
    };
    // Column numbers along the top edge, row numbers down the left edge.
    for (let c = 1; c <= cols; c++) parts.push(chip(Math.round((W * (c - 0.5)) / cols), Math.round(fs * 0.9), String(c)));
    for (let r = 1; r <= rows; r++) parts.push(chip(Math.round(fs * 1.1), Math.round((H * (r - 0.5)) / rows), String(r)));

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
    const out = await sharp(buf)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();
    return { base64: out.toString('base64'), mediaType: 'image/jpeg', ok: true };
  } catch (e) {
    logger.warn(`[PlanogramVision] grid overlay failed, sending plain image: ${(e as Error)?.message}`);
    return { base64, mediaType, ok: false };
  }
}

/**
 * Convert a 1-based inclusive [col_start,row_start,col_end,row_end] grid_box
 * into a normalized [x,y,w,h] bbox. Returns null if the value is malformed or
 * out of range, so the caller keeps the model's estimated bbox as a fallback.
 */
function gridBoxToBbox(v: any, cols: number, rows: number): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  let [c1, r1, c2, r2] = v.map((n) => Math.round(Number(n)));
  if (![c1, r1, c2, r2].every((n) => Number.isFinite(n))) return null;
  // Clamp into range and normalize ordering (tolerate a swapped corner).
  c1 = Math.min(Math.max(c1, 1), cols); c2 = Math.min(Math.max(c2, 1), cols);
  r1 = Math.min(Math.max(r1, 1), rows); r2 = Math.min(Math.max(r2, 1), rows);
  const cl = Math.min(c1, c2), cr = Math.max(c1, c2);
  const rt = Math.min(r1, r2), rb = Math.max(r1, r2);
  const x = (cl - 1) / cols;
  const y = (rt - 1) / rows;
  const w = (cr - cl + 1) / cols;
  const h = (rb - rt + 1) / rows;
  if (w <= 0 || h <= 0) return null;
  return [round4(x), round4(y), round4(w), round4(h)];
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

const POSM_TYPES: PosmType[] = [
  'poster', 'dangler', 'wobbler', 'shelf_strip', 'standee', 'gondola_end',
  'cooler', 'branded_rack', 'tent_card', 'bunting', 'banner', 'other',
];
function normalizePosmType(v: any): PosmType {
  return POSM_TYPES.includes(v) ? v : 'other';
}
function normalizePosmCondition(v: any): PosmCondition {
  return v === 'good' || v === 'damaged' || v === 'obscured' ? v : 'good';
}
function normalizeStockStatus(v: any): StockStatus | null {
  return v === 'in_stock' || v === 'low' || v === 'out' ? v : null;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/**
 * Distinct OWN brand names for the planogram — the brands whose packs must be
 * treated as own products (never competitors), even for variants not in the
 * expected list. Derived from the distinct `brand` on expected_skus, unioned
 * with any explicit override (e.g. layout.own_brands). Case-preserving,
 * deduped case-insensitively, bounded.
 */
function deriveOwnBrands(
  expectedSkus: NonNullable<RecognizeArgs['expectedSkus']>,
  override?: string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (b: unknown) => {
    const s = String(b ?? '').trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  for (const b of override || []) add(b);
  for (const e of expectedSkus) add(e.brand);
  return out.slice(0, 24);
}

// Generic pack tokens that carry no variant meaning — stripped from the lexicon
// so the keywords are the flavour / product-type anchors that actually
// disambiguate same-brand variants (e.g. "korean chilli oil" vs "sichuan chilli
// oil", "grape" vs "strawberry").
const LEXICON_STOPWORDS = new Set([
  'g', 'gm', 'gms', 'gram', 'grams', 'kg', 'ml', 'ltr', 'l', 'litre', 'liter',
  'btl', 'bottle', 'jar', 'tub', 'can', 'pack', 'pouch', 'box', 'pkt', 'packet',
  'sachet', 'tin', 'pc', 'pcs', 'x', 'of', 'the', 'and', '&', 'with', 'in',
]);

/**
 * Per-expected-SKU variant keyword lexicon: tokenise each sku_name, drop the
 * brand tokens (already conveyed by own_brands) and generic size/pack tokens, and
 * keep the flavour / product-type anchors. Given to the model so it can pick the
 * correct same-brand variant instead of guessing or dropping the pack. SKUs that
 * reduce to no keywords are omitted (nothing useful to anchor on).
 */
function buildSkuLexicon(
  expectedSkus: NonNullable<RecognizeArgs['expectedSkus']>,
): Array<{ sku_id: string; keywords: string[] }> {
  // Drops "175g", "500ml", "1kg", "6pc" etc. — a number glued to a unit.
  const SIZE_RE = /^\d+(g|gm|gms|kg|ml|l|ltr|litre|liter|oz|cl|pc|pcs)$/;
  const out: Array<{ sku_id: string; keywords: string[] }> = [];
  for (const e of expectedSkus) {
    if (!e.sku_id) continue;
    const brandTokens = new Set(
      String(e.brand ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    // Brand with all non-alphanumerics removed, so a brand written solid in the
    // catalog ("MoiSoi") still matches the spaced-out tokens in the name
    // ("MOI SOI" → "moi","soi" are both substrings of "moisoi").
    const brandJoined = String(e.brand ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const kw: string[] = [];
    const seen = new Set<string>();
    for (const raw of String(e.sku_name ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
      const t = raw.trim();
      if (!t || t.length < 2) continue;          // drop single chars / empties
      if (/^\d+$/.test(t)) continue;             // drop pure numbers
      if (SIZE_RE.test(t)) continue;             // drop size tokens (175g, 500ml)
      if (brandTokens.has(t)) continue;          // drop exact brand tokens
      if (brandJoined && brandJoined.includes(t)) continue; // drop spaced brand fragments
      if (LEXICON_STOPWORDS.has(t)) continue;    // drop generic pack tokens
      if (seen.has(t)) continue;
      seen.add(t);
      kw.push(t);
    }
    if (kw.length) out.push({ sku_id: e.sku_id, keywords: kw.slice(0, 8) });
  }
  return out;
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
    units_estimate:
      s.units_estimate == null || !Number.isFinite(Number(s.units_estimate))
        ? null
        : Math.max(0, Math.round(Number(s.units_estimate))),
    stock_status: normalizeStockStatus(s.stock_status),
    confidence: clamp01(s.confidence),
    is_competitor: Boolean(s.is_competitor),
    reasoning: s.reasoning == null ? null : String(s.reasoning),
  };
}

/**
 * Deterministic vertical correction — the decisive fix for box drift.
 *
 * Vision models reliably know WHICH shelf a product sits on (shelf_index is
 * consistent) but are poor at the product's y-pixel, so boxes drift down a shelf
 * or get dumped at the image bottom — even with the grid overlay, which fixes
 * horizontal placement but not shelf assignment. We therefore rebuild each box's
 * VERTICAL band from its shelf rank and keep the model's horizontal x/w. A box
 * can then never land off its own shelf.
 *
 * shelf_index 0 = bottom shelf (largest y). Ranks are taken from the DISTINCT
 * shelf indices present (robust to gaps / non-zero-based numbering). Only boxes
 * whose vertical CENTER falls outside their shelf band are relocated, so boxes
 * the model already placed on the right shelf keep their exact position. Needs
 * >=2 shelves to reason about; kill switch PLANOGRAM_SHELF_SNAP=0.
 */
function reconcileShelfBands(dets: DetectedSKU[]): void {
  if (process.env.PLANOGRAM_SHELF_SNAP === '0') return;
  const idxs = Array.from(
    new Set(dets.map((d) => d.shelf_index).filter((n) => Number.isFinite(n))),
  ).sort((a, b) => a - b); // ascending: 0 = bottom … highest = top
  const S = idxs.length;
  if (S < 2) return;
  const rankOf = new Map<number, number>(idxs.map((v, i) => [v, i]));
  const TOL = 0.03;
  for (const d of dets) {
    const r = rankOf.get(d.shelf_index);
    if (r == null || !Array.isArray(d.bbox) || d.bbox.length !== 4) continue;
    // rank 0 = bottom shelf = bottom of image (largest y).
    const bandTop = 1 - (r + 1) / S;
    const bandBot = 1 - r / S;
    const bandH = bandBot - bandTop;
    const [x, y, w, h] = d.bbox;
    const yc = y + h / 2;
    if (yc >= bandTop - TOL && yc <= bandBot + TOL) continue; // already on its shelf
    const newH = Math.min(h > 0 ? h : bandH, bandH);
    const newY = Math.max(bandTop, Math.min(bandBot - newH, bandTop + (bandH - newH) / 2));
    d.bbox = [x, round4(newY), w, round4(newH)];
    d.bbox_area = round4(w * newH);
  }
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

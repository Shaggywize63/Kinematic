/**
 * planogram.routes.ts
 *
 * REST endpoints for the AI planogram engine. Mounted at /api/v1/planograms.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../utils';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { PlanogramService } from '../services/planogram.service';
import { PlanogramAnalyticsService } from '../services/planogram-analytics.service';
import { PlanogramVisionService } from '../services/planogram-vision.service';

const router = Router();
router.use(requireAuth);

// ── Planogram CRUD ─────────────────────────────────────────────────────

// ── AI parse: convert a brand planogram image into structured layout ───

const parseSchema = z.object({
  image_base64: z.string().min(100),
  image_media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

router.post('/parse', asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = parseSchema.parse(req.body);
  const parsed = await PlanogramVisionService.parsePlanogramFromImage({
    imageBase64: body.image_base64,
    imageMediaType: body.image_media_type,
  });
  res.json({ success: true, data: parsed });
}));

// ── Capture + score (the field-rep flow) ───────────────────────────────

// Optional UUID that tolerates junk: an empty string or a non-UUID value
// (e.g. a client-side visit id that isn't a real UUID) is coerced to undefined
// instead of hard-failing the WHOLE request with "Invalid request body". A bad
// optional id must never block a shelf capture — it just isn't linked.
const optionalUuid = z.preprocess(
  (v) =>
    typeof v === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)
      ? v
      : undefined,
  z.string().uuid().optional(),
);

const captureSchema = z.object({
  store_id: optionalUuid,
  visit_id: optionalUuid,
  planogram_id: optionalUuid,
  image_url: z.string().url(),
  image_base64: z.string().min(100),
  image_media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  capture_lat: z.number().optional(),
  capture_lng: z.number().optional(),
  angle_score: z.number().optional(),   // client-side frame-alignment quality (0..1)
  device_meta: z.any().optional(),
});

router.post('/captures', asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = captureSchema.parse(req.body);
  const out = await PlanogramService.processCapture({
    orgId: req.user.org_id,
    clientId: req.user.client_id ?? null,
    feId: req.user.id,
    storeId: body.store_id ?? null,
    visitId: body.visit_id ?? null,
    planogramId: body.planogram_id ?? null,
    imageUrl: body.image_url,
    imageBase64: body.image_base64,
    imageMediaType: body.image_media_type,
    capture: { lat: body.capture_lat, lng: body.capture_lng, deviceMeta: body.device_meta },
  });
  res.status(201).json({ success: true, data: out });
}));

// Captures list for the redesigned module (Captures tab + Review queue). Org-
// scoped; returns the pinned dashboard shape { total, captures:[...] }. The
// Review queue is just this with needs_review=true.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const parseBoolParam = (v: unknown): boolean | undefined => {
  if (v === undefined) return undefined;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return undefined;
};
const parseNumParam = (v: unknown): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

router.get('/captures', asyncHandler(async (req: AuthRequest, res: Response) => {
  const q = req.query;
  const data = await PlanogramAnalyticsService.listCaptures(req.user.org_id, {
    city: typeof q.city === 'string' && q.city.trim() ? q.city.trim() : undefined,
    storeId: typeof q.store_id === 'string' && UUID_RE.test(q.store_id) ? q.store_id : undefined,
    needsReview: parseBoolParam(q.needs_review),
    minScore: parseNumParam(q.min_score),
    maxScore: parseNumParam(q.max_score),
    limit: parseNumParam(q.limit),
    offset: parseNumParam(q.offset),
  });
  res.json({ success: true, data });
}));

// Overview aggregate for the redesigned module's landing view. Org-scoped,
// last `period_days` (default 30), optional city filter.
router.get('/overview', asyncHandler(async (req: AuthRequest, res: Response) => {
  const q = req.query;
  const data = await PlanogramAnalyticsService.overview(req.user.org_id, {
    periodDays: parseNumParam(q.period_days),
    city: typeof q.city === 'string' && q.city.trim() ? q.city.trim() : undefined,
  });
  res.json({ success: true, data });
}));

router.get('/captures/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const captureId = req.params.id;
  const { data: cap, error } = await supabaseAdmin.from('planogram_captures')
    .select('*, fe:users!fe_id(name), store:stores!store_id(name), planogram:planograms!planogram_id(name)')
    .eq('id', captureId).eq('org_id', req.user.org_id).single();
  if (error || !cap) throw new AppError(404, 'Capture not found', 'NOT_FOUND');
  const { data: rec } = await supabaseAdmin.from('planogram_recognition').select('*').eq('capture_id', captureId).single();
  const { data: comp } = await supabaseAdmin.from('planogram_compliance').select('*').eq('capture_id', captureId).single();
  res.json({ success: true, data: { capture: cap, recognition: rec, compliance: comp } });
}));

// ── Confirm a detection as a reference pack-shot (self-improving library) ──
// A confirmed detection on a capture is cropped out of the capture photo and
// stored as an extra reference pack-shot for that SKU (own or tracked
// competitor), so it improves recognition on the next scan. Org-scoped like the
// sibling capture routes.
router.post('/captures/:id/confirm-detection', asyncHandler(async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    sku_id: z.string().min(1),
    // [x, y, w, h] normalized 0..1 — validated as finite + in-range below so a
    // bad box returns a clean 400 rather than cropping garbage.
    bbox: z.array(z.number()).length(4),
  });
  const body = schema.parse(req.body);
  const bbox = body.bbox as [number, number, number, number];
  if (!bbox.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw new AppError(400, 'bbox must be 4 finite numbers in 0..1 ([x, y, w, h] normalized)', 'INVALID_BBOX');
  }
  const out = await PlanogramService.confirmDetectionAsReference({
    orgId: req.user.org_id,
    captureId: req.params.id,
    skuId: body.sku_id,
    bbox,
  });
  res.status(201).json({ success: true, data: out });
}));

// ── Re-analyze an existing capture (on-demand, re-runs the AI) ─────────────
// The dashboard "Re-analyze" button. Re-runs the FULL pipeline (recognition →
// score → quality gate) on the capture's STORED photo + its planogram layout,
// then UPSERTs the recognition + compliance rows so an OLDER capture gains the
// full v2 analysis (occupancy, shelf-share, zones, categories, pricing,
// promotions, methodology, …). Org-scoped: a capture outside the caller's org
// 404s; a capture with no stored image 422s; a vision failure 502s and leaves
// the existing rows untouched. Returns the same shape as GET /captures/:id.
router.post('/captures/:id/reprocess', asyncHandler(async (req: AuthRequest, res: Response) => {
  const out = await PlanogramService.reprocessCapture({
    orgId: req.user.org_id,
    captureId: req.params.id,
  });
  res.json({ success: true, data: out });
}));

// ── Detection feedback (accept / "this detection is wrong" learning loop) ──
// A per-detection thumbs-down from the Captures / Review queue UI. Validates the
// capture belongs to the caller's org (404 otherwise) and that `reason` is in
// the allowed set (zod → 400 otherwise), then records a planogram_feedback row.
// Org-scoped; client_id + created_by stamped from the caller like the capture
// pipeline. Shares the planogram_feedback table with the corrections loop.
const DETECTION_FEEDBACK_REASONS = ['wrong_product', 'not_a_product', 'wrong_facings', 'wrong_price', 'other'] as const;

router.post('/captures/:id/detection-feedback', asyncHandler(async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    sku_id: z.string().min(1).nullable().optional(),
    bbox: z.array(z.number()).nullable().optional(),
    reason: z.enum(DETECTION_FEEDBACK_REASONS),
    correct_sku_id: z.string().min(1).nullable().optional(),
    note: z.string().nullable().optional(),
  });
  const body = schema.parse(req.body);

  // Capture must exist AND belong to the caller's org (else 404 — no leak).
  const { data: cap, error: capErr } = await supabaseAdmin
    .from('planogram_captures')
    .select('id')
    .eq('id', req.params.id)
    .eq('org_id', req.user.org_id)
    .single();
  if (capErr || !cap) throw new AppError(404, 'Capture not found', 'NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('planogram_feedback')
    .insert({
      org_id: req.user.org_id,
      client_id: req.user.client_id ?? null,
      capture_id: req.params.id,
      sku_id: body.sku_id ?? null,
      bbox: body.bbox ?? null,
      reason: body.reason,
      correct_sku_id: body.correct_sku_id ?? null,
      note: body.note ?? null,
      created_by: req.user.id,
    })
    .select('id')
    .single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.status(201).json({ success: true, data: { id: data.id } });
}));

// ── Analytics ──────────────────────────────────────────────────────────

router.get('/analytics/trend', asyncHandler(async (req: AuthRequest, res: Response) => {
  const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
  res.json({ success: true, data: await PlanogramAnalyticsService.orgTrend(req.user.org_id, days) });
}));
router.get('/analytics/store-ranking', asyncHandler(async (req: AuthRequest, res: Response) => {
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
  res.json({ success: true, data: await PlanogramAnalyticsService.storeRanking(req.user.org_id, days) });
}));
router.get('/analytics/chronic-gaps', asyncHandler(async (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: await PlanogramAnalyticsService.chronicGaps(req.user.org_id) });
}));
router.get('/analytics/sku-visibility', asyncHandler(async (req: AuthRequest, res: Response) => {
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
  res.json({ success: true, data: await PlanogramAnalyticsService.skuVisibility(req.user.org_id, days) });
}));
router.get('/analytics/risk-forecast', asyncHandler(async (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: await PlanogramAnalyticsService.riskForecast(req.user.org_id) });
}));
// Cross-store trend analytics for the redesigned module's Insights view.
// Org-scoped; last `days` (default 90, max 365).
router.get('/analytics/insights', asyncHandler(async (req: AuthRequest, res: Response) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
  res.json({ success: true, data: await PlanogramAnalyticsService.insights(req.user.org_id, { periodDays: days }) });
}));

// ── Planogram CRUD ─────────────────────────────────────────────────────

const upsertPlanogramSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  store_format: z.string().optional(),
  client_id: z.string().uuid().optional(),
  source_url: z.string().url().optional(),
  layout: z.object({
    shelves: z.array(z.object({ index: z.number(), capacity: z.number().optional() })),
    category_definition: z.string().optional(),
    // Opt-in dense-bay shelf-tiling augment for this planogram (default off).
    tiling: z.boolean().optional(),
    // Tracked competitor SKUs (with optional reference pack shots) live on the
    // planogram layout and are threaded into the vision call at capture time.
    competitors: z.array(z.object({
      sku_id: z.string(),
      sku_name: z.string(),
      brand: z.string().optional(),
      ref_image_url: z.string().url().optional(),
      // v2 metrics: category feeds per-category rollups; expected_price feeds pricing deltas.
      category: z.string().nullable().optional(),
      expected_price: z.number().nullable().optional(),
      // Confirmed-crop reference pack-shots (grown by /confirm-detection); kept so
      // the field round-trips through a save instead of being stripped.
      additional_ref_urls: z.array(z.string().url()).optional(),
    })).optional(),
  }).optional(),
  expected_skus: z.array(z.object({
    sku_id: z.string(),
    sku_name: z.string(),
    shelf_index: z.number().int().min(0),
    facings: z.number().int().min(1),
    position: z.number().int().optional(),
    weight: z.number().optional(),
    brand: z.string().optional(),
    // Front-facing pack shot URL → used as a vision reference for exact matching.
    ref_image_url: z.string().url().optional(),
    // v2 metrics: category constrains the model's taxonomy + drives category
    // rollups; expected_price is the baseline for shelf-tag pricing deltas.
    category: z.string().nullable().optional(),
    expected_price: z.number().nullable().optional(),
    // Confirmed-crop reference pack-shots (grown by /confirm-detection); kept so
    // the field round-trips through a save instead of being stripped.
    additional_ref_urls: z.array(z.string().url()).optional(),
  })),
});

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin.from('planograms')
    .select('id, name, category, store_format, client_id, version, is_active, updated_at')
    .eq('org_id', req.user.org_id).order('updated_at', { ascending: false });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data });
}));

router.get('/:id([0-9a-fA-F-]{36})', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin.from('planograms').select('*')
    .eq('id', req.params.id).eq('org_id', req.user.org_id).single();
  if (error || !data) throw new AppError(404, 'Planogram not found', 'NOT_FOUND');
  res.json({ success: true, data });
}));

router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = upsertPlanogramSchema.parse(req.body);
  const { data, error } = await supabaseAdmin.from('planograms').insert({
    org_id: req.user.org_id,
    client_id: body.client_id ?? req.user.client_id ?? null,
    name: body.name,
    category: body.category ?? null,
    store_format: body.store_format ?? null,
    source_url: body.source_url ?? null,
    layout: body.layout ?? { shelves: [] },
    expected_skus: body.expected_skus,
    created_by: req.user.id,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.status(201).json({ success: true, data });
}));

router.patch('/:id([0-9a-fA-F-]{36})', asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = upsertPlanogramSchema.partial().parse(req.body);
  const { data, error } = await supabaseAdmin.from('planograms')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', req.user.org_id).select('*').single();
  if (error || !data) throw new AppError(404, 'Planogram not found', 'NOT_FOUND');
  res.json({ success: true, data });
}));

router.delete('/:id([0-9a-fA-F-]{36})', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { error } = await supabaseAdmin.from('planograms').delete()
    .eq('id', req.params.id).eq('org_id', req.user.org_id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true });
}));

// ── Assignments ────────────────────────────────────────────────────────

router.get('/:id/assignments', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin.from('planogram_assignments').select('*')
    .eq('org_id', req.user.org_id).eq('planogram_id', req.params.id)
    .order('valid_from', { ascending: false });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data });
}));

router.post('/:id/assignments', asyncHandler(async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    store_id: z.string().uuid().optional(),
    zone_id: z.string().uuid().optional(),
    city_id: z.string().uuid().optional(),
    valid_from: z.string().optional(),
    valid_to: z.string().nullable().optional(),
  });
  const body = schema.parse(req.body);
  const { data, error } = await supabaseAdmin.from('planogram_assignments')
    .insert({ org_id: req.user.org_id, planogram_id: req.params.id, ...body })
    .select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.status(201).json({ success: true, data });
}));

router.delete('/:id/assignments/:assignmentId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { error } = await supabaseAdmin.from('planogram_assignments').delete()
    .eq('org_id', req.user.org_id)
    .eq('planogram_id', req.params.id)
    .eq('id', req.params.assignmentId);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true });
}));

// ── Human-in-the-loop feedback (learning loop) ─────────────────────────

router.post('/captures/:id/feedback', asyncHandler(async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    corrections: z.array(z.object({
      sku_id: z.string().nullable(),
      action: z.enum(['add', 'remove', 'relabel']),
      bbox: z.array(z.number()).length(4).optional(),
      note: z.string().optional(),
    })),
    notes: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const { data, error } = await supabaseAdmin.from('planogram_feedback').insert({
    org_id: req.user.org_id,
    capture_id: req.params.id,
    corrected_by: req.user.id,
    corrections: body.corrections,
    notes: body.notes ?? null,
  }).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.status(201).json({ success: true, data });
}));

export default router;

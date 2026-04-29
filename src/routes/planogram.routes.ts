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

const upsertPlanogramSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  store_format: z.string().optional(),
  client_id: z.string().uuid().optional(),
  source_url: z.string().url().optional(),
  layout: z.object({ shelves: z.array(z.object({ index: z.number(), capacity: z.number().optional() })) }).optional(),
  expected_skus: z.array(z.object({
    sku_id: z.string(),
    sku_name: z.string(),
    shelf_index: z.number().int().min(0),
    facings: z.number().int().min(1),
    position: z.number().int().optional(),
    weight: z.number().optional(),
  })),
});

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin.from('planograms')
    .select('id, name, category, store_format, client_id, version, is_active, updated_at')
    .eq('org_id', req.user.org_id).order('updated_at', { ascending: false });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  res.json({ success: true, data });
}));

router.get('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
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

router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = upsertPlanogramSchema.partial().parse(req.body);
  const { data, error } = await supabaseAdmin.from('planograms')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', req.user.org_id).select('*').single();
  if (error || !data) throw new AppError(404, 'Planogram not found', 'NOT_FOUND');
  res.json({ success: true, data });
}));

router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
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

const captureSchema = z.object({
  store_id: z.string().uuid().optional(),
  visit_id: z.string().uuid().optional(),
  planogram_id: z.string().uuid().optional(),
  image_url: z.string().url(),
  image_base64: z.string().min(100),
  image_media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  capture_lat: z.number().optional(),
  capture_lng: z.number().optional(),
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

router.get('/captures', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('planogram_captures')
    .select(`
      *,
      fe:users!fe_id(name),
      store:stores!store_id(name),
      planogram:planograms!planogram_id(name),
      compliance:planogram_compliance!capture_id(score)
    `)
    .eq('org_id', req.user.org_id)
    .order('captured_at', { ascending: false });

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
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

export default router;

import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const materialSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['video','pdf','slides','document','link']),
  file_url: z.string().url(),
  thumbnail_url: z.string().url().optional(),
  duration_min: z.number().int().optional(),
  page_count: z.number().int().optional(),
  target_roles: z.array(z.string()).default(['executive']),
  is_mandatory: z.boolean().default(false),
});

// GET /api/v1/learning
export const getMaterials = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  const { data, error } = await supabaseAdmin
    .from('learning_materials')
    .select(`
      *,
      learning_progress!left(is_completed, progress_pct, last_accessed)
    `)
    .eq('org_id', user.org_id)
    .eq('is_active', true)
    .contains('target_roles', [user.role])
    .order('is_mandatory', { ascending: false })
    .order('published_at', { ascending: false });

  if (error) return badRequest(res, error.message);

  const enriched = (data || []).map((m) => ({
    ...m,
    my_progress: Array.isArray(m.learning_progress) && m.learning_progress.length > 0
      ? m.learning_progress[0]
      : null,
    learning_progress: undefined,
  }));

  return ok(res, enriched);
});

// POST /api/v1/learning  (admin+)
export const createMaterial = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = materialSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('learning_materials')
    .insert({ ...body.data, org_id: user.org_id, created_by: user.id, published_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Material published');
});

// POST /api/v1/learning/:id/progress
export const updateProgress = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { progress_pct, is_completed } = req.body;

  const { data: material } = await supabaseAdmin
    .from('learning_materials')
    .select('id')
    .eq('id', id)
    .eq('org_id', user.org_id)
    .single();

  if (!material) return notFound(res, 'Material not found');

  const { data, error } = await supabaseAdmin
    .from('learning_progress')
    .upsert({
      material_id: id,
      user_id: user.id,
      org_id: user.org_id,
      progress_pct: progress_pct ?? 0,
      is_completed: is_completed ?? false,
      last_accessed: new Date().toISOString(),
      ...(is_completed && { completed_at: new Date().toISOString() }),
    }, { onConflict: 'material_id,user_id' })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

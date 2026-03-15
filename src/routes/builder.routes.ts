import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, sendSuccess, AppError } from '../utils';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();
const ORG = '00000000-0000-0000-0000-000000000001';

/* ── Forms ─────────────────────────────────────────────────────────────── */

// GET /api/v1/builder/forms
router.get('/forms', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('builder_forms')
    .select('*')
    .eq('org_id', ORG)
    .order('created_at', { ascending: false });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data);
}));

// POST /api/v1/builder/forms
router.post('/forms', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { title, description, icon, cover_color } = req.body;
  if (!title?.trim()) throw new AppError(400, 'title is required', 'VALIDATION_ERROR');
  const { data, error } = await supabaseAdmin
    .from('builder_forms')
    .insert({ org_id: ORG, title: title.trim(), description, icon: icon||'📋', cover_color: cover_color||'#E01E2C', status:'draft', version:1 })
    .select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data, 201);
}));

// PATCH /api/v1/builder/forms/:id
router.patch('/forms/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const allowed = ['title','description','status','icon','cover_color'];
  const updates: any = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('builder_forms').update(updates).eq('id', req.params.id).eq('org_id', ORG).select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data);
}));

// DELETE /api/v1/builder/forms/:id
router.delete('/forms/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await supabaseAdmin.from('builder_forms').delete().eq('id', req.params.id).eq('org_id', ORG);
  return sendSuccess(res, { deleted: true });
}));

/* ── Pages ─────────────────────────────────────────────────────────────── */

// GET /api/v1/builder/forms/:id/pages
router.get('/forms/:id/pages', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('builder_pages').select('*').eq('form_id', req.params.id).order('page_order');
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data);
}));

// POST /api/v1/builder/forms/:id/pages
router.post('/forms/:id/pages', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { title, description, page_order } = req.body;
  const { data, error } = await supabaseAdmin
    .from('builder_pages')
    .insert({ form_id: req.params.id, title: title||'Page', description, page_order: page_order||0 })
    .select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data, 201);
}));

// PATCH /api/v1/builder/pages/:id
router.patch('/pages/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { title, description, page_order } = req.body;
  const { data, error } = await supabaseAdmin
    .from('builder_pages').update({ title, description, page_order }).eq('id', req.params.id).select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data);
}));

// DELETE /api/v1/builder/pages/:id
router.delete('/pages/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await supabaseAdmin.from('builder_pages').delete().eq('id', req.params.id);
  return sendSuccess(res, { deleted: true });
}));

/* ── Questions ──────────────────────────────────────────────────────────── */

// GET /api/v1/builder/forms/:id/questions
router.get('/forms/:id/questions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('builder_questions').select('*').eq('form_id', req.params.id).order('q_order');
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data);
}));

// POST /api/v1/builder/forms/:id/questions
router.post('/forms/:id/questions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { page_id, qtype, label, placeholder, helper_text, is_required, q_order, options, validation, logic, prefill_key, media_config } = req.body;
  if (!qtype) throw new AppError(400, 'qtype is required', 'VALIDATION_ERROR');
  const { data, error } = await supabaseAdmin
    .from('builder_questions')
    .insert({
      form_id: req.params.id, page_id, qtype, label: label||'Question',
      placeholder, helper_text, is_required: is_required||false,
      q_order: q_order||0, options: options||[], validation: validation||{},
      logic: logic||[], prefill_key, media_config: media_config||{}
    })
    .select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data, 201);
}));

// PATCH /api/v1/builder/questions/:id
router.patch('/questions/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const allowed = ['label','placeholder','helper_text','is_required','q_order','options','validation','logic','prefill_key','media_config','page_id'];
  const updates: any = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabaseAdmin
    .from('builder_questions').update(updates).eq('id', req.params.id).select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data);
}));

// DELETE /api/v1/builder/questions/:id
router.delete('/questions/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await supabaseAdmin.from('builder_questions').delete().eq('id', req.params.id);
  return sendSuccess(res, { deleted: true });
}));

/* ── Submissions ────────────────────────────────────────────────────────── */

// GET /api/v1/builder/forms/:id/submissions
router.get('/forms/:id/submissions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('builder_submissions')
    .select('*, users(name, employee_id)')
    .eq('form_id', req.params.id)
    .order('submitted_at', { ascending: false });
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data);
}));

// POST /api/v1/builder/forms/:id/submissions
router.post('/forms/:id/submissions', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { answers, location_lat, location_lng, is_offline } = req.body;
  const user = (req as any).user;
  const { data, error } = await supabaseAdmin
    .from('builder_submissions')
    .insert({ form_id: req.params.id, submitted_by: user?.id, answers: answers||{}, location_lat, location_lng, is_offline: is_offline||false, status:'submitted' })
    .select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data, 201);
}));

export default router;

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, sendSuccess, AppError } from '../utils';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();
const ORG_ID = '00000000-0000-0000-0000-000000000001';

// GET /api/v1/settings/:key
router.get('/:key', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.params;
  const { data, error } = await supabaseAdmin
    .from('org_settings')
    .select('value')
    .eq('org_id', ORG_ID)
    .eq('key', key)
    .single();

  if (error || !data) {
    return sendSuccess(res, null);
  }
  return sendSuccess(res, data.value);
}));

// POST /api/v1/settings/:key  (upsert)
router.post('/:key', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.params;
  const value = req.body;

  if (!value || typeof value !== 'object') {
    throw new AppError(400, 'Invalid settings value', 'VALIDATION_ERROR');
  }

  const { data, error } = await supabaseAdmin
    .from('org_settings')
    .upsert(
      { org_id: ORG_ID, key, value, updated_at: new Date().toISOString() },
      { onConflict: 'org_id,key' }
    )
    .select()
    .single();

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return sendSuccess(res, data.value);
}));

export default router;

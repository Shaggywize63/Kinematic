import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const visitSchema = z.object({
  visitor_id: z.string().uuid(),
  rating: z.enum(['excellent','good','average','poor']).default('good'),
  remarks: z.string().optional(),
  photo_url: z.string().url().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

// POST /api/v1/visits
export const logVisit = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = visitSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .insert({ ...body.data, org_id: user.org_id, executive_id: user.id, zone_id: user.zone_id })
    .select('*, users!visitor_id(name, role)')
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Visit logged');
});

// GET /api/v1/visits/mine
export const getMyVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = req.query.date as string | undefined;

  let query = supabaseAdmin
    .from('visit_logs')
    .select('*, users!visitor_id(name, role)')
    .eq('executive_id', user.id)
    .order('visited_at', { ascending: false });

  if (date) query = query.eq('date', date);

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

// GET /api/v1/visits/team  (supervisor+)
export const getTeamVisits = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('visit_logs')
    .select('*, users!executive_id(name), users!visitor_id(name, role), zones(name)')
    .eq('org_id', user.org_id)
    .eq('date', date)
    .order('visited_at', { ascending: false });

  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

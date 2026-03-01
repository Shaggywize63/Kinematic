import { Request, Response } from 'express';
import { z } from 'zod';
import { supabase, supabaseAdmin, getUserClient } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, unauthorized, serverError } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../lib/logger';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fcm_token: z.string().optional(),
  device_id: z.string().optional(),
});

const refreshSchema = z.object({
  refresh_token: z.string(),
});

// POST /api/v1/auth/login
export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = loginSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { email, password, fcm_token, device_id } = body.data;

  // Sign in directly with email + password via Supabase Auth
  const { data: session, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !session.session) {
    logger.warn(`Failed login attempt for email: ${email}`);
    return unauthorized(res, 'Invalid email or password');
  }

  // Fetch user profile from users table using the auth user id
  const { data: userProfile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, org_id, name, role, is_active')
    .eq('id', session.user.id)
    .single();

  if (profileError || !userProfile) return unauthorized(res, 'User profile not found');
  if (!userProfile.is_active) return unauthorized(res, 'Account is deactivated. Contact your admin.');

  // Update FCM token and device ID if provided
  if (fcm_token || device_id) {
    await supabaseAdmin
      .from('users')
      .update({ ...(fcm_token && { fcm_token }), ...(device_id && { device_id }) })
      .eq('id', userProfile.id);
  }

  return ok(res, {
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
    expires_at: session.session.expires_at,
    user: {
      id: userProfile.id,
      org_id: userProfile.org_id,
      name: userProfile.name,
      role: userProfile.role,
    },
  });
});

// POST /api/v1/auth/refresh
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const body = refreshSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'refresh_token is required');

  const { data: session, error } = await supabase.auth.refreshSession({
    refresh_token: body.data.refresh_token,
  });

  if (error || !session.session) return unauthorized(res, 'Invalid or expired refresh token');

  return ok(res, {
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
    expires_at: session.session.expires_at,
  });
});

// POST /api/v1/auth/logout
export const logout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (req.accessToken) {
    const client = getUserClient(req.accessToken);
    await client.auth.signOut();
  }
  // Clear FCM token on logout
  if (req.user) {
    await supabaseAdmin.from('users').update({ fcm_token: null }).eq('id', req.user.id);
  }
  return ok(res, null, 'Logged out successfully');
});

// GET /api/v1/auth/me
export const me = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) return unauthorized(res);

  const { data, error } = await supabaseAdmin
    .from('users')
    .select(`
      id, org_id, name, mobile, role, employee_id,
      zone_id, supervisor_id, city, state, avatar_url,
      is_active, joined_date, created_at,
      zones(id, name, city, meeting_lat, meeting_lng, geofence_radius),
      organisations(id, name, logo_url)
    `)
    .eq('id', req.user.id)
    .single();

  if (error) return serverError(res);
  return ok(res, data);
});

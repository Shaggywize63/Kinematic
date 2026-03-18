import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest, UserRole } from '../types';
import { unauthorized, forbidden } from '../utils/response';

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(res, 'Missing or invalid Authorization header');
  }

  const token = authHeader.split(' ')[1];

  // Verify JWT with Supabase
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return unauthorized(res, 'Invalid or expired token');
  }

  // Fetch user profile from our users table
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, org_id, name, mobile, role, zone_id, supervisor_id, fcm_token, is_active')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return unauthorized(res, 'User profile not found');
  }

  if (!profile.is_active) {
    return forbidden(res, 'Account is deactivated');
  }

  req.user = profile as AuthRequest['user'];
  req.accessToken = token;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);
    if (!roles.includes(req.user.role)) {
      return forbidden(res, `Requires one of: ${roles.join(', ')}`);
    }
    next();
  };
}

export function requireSupervisorOrAbove(req: AuthRequest, res: Response, next: NextFunction) {
  return requireRole('super_admin', 'admin', 'city_manager', 'supervisor')(req, res, next);
}

export function requireAdminOrAbove(req: AuthRequest, res: Response, next: NextFunction) {
  return requireRole('super_admin', 'admin', 'city_manager')(req, res, next);
}

import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest, UserRole } from '../types';
import { unauthorized, forbidden } from '../utils/response';

const JWT_SECRET = process.env.JWT_SECRET || 'kinematic-secret-2024';

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(res, 'Missing authorization header');
  }

  const token = authHeader.split(' ')[1];

  // Verify the custom JWT signed by auth.controller.ts
  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return unauthorized(res, 'Invalid or expired token');
  }

  if (!decoded?.id) {
    return unauthorized(res, 'Invalid token payload');
  }

  // Look up the user from our DB using the id embedded in the JWT
  const { data: dbUser, error: dbError } = await supabaseAdmin
    .from('users')
    .select('id, org_id, name, mobile, email, role, employee_id, zone_id, supervisor_id, fcm_token, is_active')
    .eq('id', decoded.id)
    .eq('is_active', true)
    .single();

  if (dbError || !dbUser) {
    return unauthorized(res, 'User not found or inactive');
  }

  req.user = {
    id: dbUser.id,
    org_id: dbUser.org_id,
    name: dbUser.name,
    mobile: dbUser.mobile,
    role: dbUser.role as UserRole,
    employee_id: dbUser.employee_id,
    zone_id: dbUser.zone_id,
    supervisor_id: dbUser.supervisor_id,
    fcm_token: dbUser.fcm_token,
    is_active: dbUser.is_active,
  };
  req.accessToken = token;

  next();
};

export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return unauthorized(res);
    if (!roles.includes(req.user.role)) {
      return forbidden(res, 'Insufficient permissions');
    }
    next();
  };
};

import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest, UserRole } from '../types';
import { DEMO_ORG_ID } from '../utils/demoData';
import { unauthorized, forbidden } from '../utils/response';
import { logger } from '../lib/logger';

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(res, 'Missing or invalid Authorization header');
  }

  const token = authHeader.split(' ')[1].replace(/['"]+/g, '').trim();

  // --- DEMO TOKEN BYPASS ---
  if (token === 'demo-token-jwt-placeholder') {
    req.user = {
      id: 'demo-user-id',
      org_id: DEMO_ORG_ID,
      client_id: null,
      name: 'Demo Admin',
      email: 'demo@kinematic.com',
      role: 'admin',
      is_active: true,
      permissions: ['dashboard', 'analytics', 'users', 'attendance', 'zones', 'inventory', 'form_builder'],
      assigned_cities: []
    } as any;
    req.accessToken = token;
    return next();
  }

  // Verify JWT with Supabase
  let user = null;
  let error = null;

  try {
    const { data, error: authError } = await supabaseAdmin.auth.getUser(token);
    user = data?.user;
    error = authError;
  } catch (e: any) {
    logger.error(`[Auth] Exception in admin.getUser: ${e.message}`);
    error = e;
  }

  if (error || !user) {
    logger.error(`[Auth] Verification failed. Error: ${JSON.stringify(error)}. Token start: ${token.substring(0, 10)}...`);
    return unauthorized(res, 'Invalid or expired token');
  }

  // Fetch user profile
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, org_id, client_id, name, mobile, role, zone_id, supervisor_id, fcm_token, is_active')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    logger.error(`[Auth] Profile lookup failed for user ${user.id}: ${profileError?.message || 'Profile not found'}`);
    return unauthorized(res, 'User profile not found');
  }

  // Fetch permissions separately (Bypass join relationship requirements)
  const { data: permsData } = await supabaseAdmin
    .from('user_module_permissions')
    .select('module_id')
    .eq('user_id', user.id);

  // Fetch city assignments separately
  const { data: citiesData } = await supabaseAdmin
    .from('user_city_assignments')
    .select('city_id')
    .eq('user_id', user.id);

  const permissions = permsData?.map(p => p.module_id) || [];
  const assigned_cities = citiesData?.map(c => c.city_id) || [];

  if (!profile.is_active) {
    return forbidden(res, 'Account is deactivated');
  }

  // Normalize role to lowercase for consistent permission checks
  if (profile.role) {
    profile.role = profile.role.toLowerCase();
  }

  req.user = {
    ...profile,
    permissions,
    assigned_cities
  } as AuthRequest['user'];
  req.accessToken = token;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const userRole = req.user.role?.toLowerCase();
    const allowedRoles = roles.map(r => r.toLowerCase());
    
    if (!allowedRoles.includes(userRole)) {
      return forbidden(res, `Requires one of: ${roles.join(', ')}`);
    }
    next();
  };
}

export function requireSupervisorOrAbove(req: AuthRequest, res: Response, next: NextFunction) {
  return requireRole('super_admin', 'admin', 'main_admin', 'sub_admin', 'client', 'city_manager', 'supervisor')(req, res, next);
}

export function requireAdminOrAbove(req: AuthRequest, res: Response, next: NextFunction) {
  return requireRole('super_admin', 'admin', 'main_admin', 'client', 'city_manager')(req, res, next);
}

export function requireModule(moduleName: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.user.role?.toLowerCase();
    const permissions = req.user.permissions || [];
    
    if (role === 'super_admin') return next();
    if (permissions.includes(moduleName)) return next();
    
    return forbidden(res, `Unauthorized: Missing ${moduleName} module`);
  };
}

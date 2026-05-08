import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest, UserRole } from '../types';
import { DEMO_ORG_ID, isDemo } from '../utils/demoData';
import { unauthorized, forbidden } from '../utils/response';
import { logger } from '../lib/logger';

// In-memory profile cache. Keyed by token (so a refreshed token re-validates).
// TTL is min(5 min, JWT exp). Eliminates 3 sequential round-trips per request:
//   1. supabaseAdmin.auth.getUser  → Supabase gotrue
//   2. SELECT users WHERE id=...
//   3. SELECT user_module_permissions + user_city_assignments
type CachedAuth = {
  expiresAt: number;
  user: AuthRequest['user'];
};
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_CACHE_MAX = 5000; // soft cap; FIFO drop on overflow
const authCache = new Map<string, CachedAuth>();

function cacheGet(token: string): AuthRequest['user'] | null {
  const hit = authCache.get(token);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    authCache.delete(token);
    return null;
  }
  return hit.user;
}

function cacheSet(token: string, user: AuthRequest['user'], jwtExpSec?: number) {
  if (authCache.size >= AUTH_CACHE_MAX) {
    // FIFO eviction — drop the oldest insertion order key
    const firstKey = authCache.keys().next().value;
    if (firstKey !== undefined) authCache.delete(firstKey);
  }
  const ttl = jwtExpSec
    ? Math.min(AUTH_CACHE_TTL_MS, jwtExpSec * 1000 - Date.now())
    : AUTH_CACHE_TTL_MS;
  if (ttl <= 0) return;
  authCache.set(token, { user, expiresAt: Date.now() + ttl });
}

/** Invalidate every cached profile for a user — call this on role/permission changes. */
export function invalidateAuthCache(predicate?: (u: AuthRequest['user']) => boolean) {
  if (!predicate) { authCache.clear(); return; }
  for (const [token, entry] of authCache) {
    if (predicate(entry.user)) authCache.delete(token);
  }
}

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

/** Verify the access token. Prefer local HS256 verify against the Supabase JWT
 *  secret (no network); fall back to the gotrue round-trip if local verify
 *  throws OR the secret isn't configured. Defensive fallback prevents a
 *  misconfigured SUPABASE_JWT_SECRET from 401-ing every request. */
let warnedLocalVerify = false;
async function verifyToken(token: string): Promise<{ sub: string; exp?: number } | null> {
  if (SUPABASE_JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, SUPABASE_JWT_SECRET) as jwt.JwtPayload;
      if (decoded?.sub) return { sub: decoded.sub as string, exp: decoded.exp };
      // No `sub` in payload — treat as invalid, no point falling back.
      return null;
    } catch (e: any) {
      // Local verify failed (wrong secret, JWT shape mismatch, etc.). Don't
      // fail the request — fall through to gotrue so users keep working while
      // the operator fixes the env var. Log once per process.
      if (!warnedLocalVerify) {
        warnedLocalVerify = true;
        logger.warn(`[Auth] Local JWT verify failed (${e.message}); falling back to gotrue. Check SUPABASE_JWT_SECRET.`);
      }
    }
  }
  // Network fallback (slower).
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return { sub: data.user.id };
  } catch (e: any) {
    logger.error(`[Auth] supabase.auth.getUser exception: ${e.message}`);
    return null;
  }
}

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
      role: 'super_admin',
      is_active: true,
      permissions: [
        'dashboard', 'analytics', 'users', 'attendance', 'zones', 'inventory',
        'form_builder', 'reports', 'broadcast', 'broadcasts', 'grievances',
        'wms', 'warehouse', 'clients', 'management', 'settings', 'skus', 'assets',
        'crm', 'distribution', 'planograms', 'route_plans', 'visit_logs',
        'campaigns', 'leaderboard', 'notifications', 'sos', 'candidates',
        'learning', 'manpower', 'work_activity', 'audit', 'integrations'
      ],
      assigned_cities: []
    } as any;
    req.accessToken = token;
    return next();
  }

  // Hot path — cache hit avoids both JWT verification AND profile lookup.
  const cached = cacheGet(token);
  if (cached) {
    req.user = cached;
    req.accessToken = token;
    return next();
  }

  const verified = await verifyToken(token);
  if (!verified) return unauthorized(res, 'Invalid or expired token');

  // Cold path — fetch profile + permissions + cities in parallel (was sequential).
  const [profileRes, permsRes, citiesRes] = await Promise.all([
    supabaseAdmin
      .from('users')
      .select('id, org_id, client_id, name, mobile, role, zone_id, supervisor_id, fcm_token, is_active')
      .eq('id', verified.sub)
      .single(),
    supabaseAdmin.from('user_module_permissions').select('module_id').eq('user_id', verified.sub),
    supabaseAdmin.from('user_city_assignments').select('city_id').eq('user_id', verified.sub),
  ]);

  if (profileRes.error || !profileRes.data) {
    logger.error(`[Auth] Profile lookup failed for ${verified.sub}: ${profileRes.error?.message || 'not found'}`);
    return unauthorized(res, 'User profile not found');
  }

  const profile = profileRes.data;
  if (!profile.is_active) return forbidden(res, 'Account is deactivated');

  if (profile.role) profile.role = profile.role.toLowerCase();

  const user = {
    ...profile,
    permissions: permsRes.data?.map(p => p.module_id) || [],
    assigned_cities: citiesRes.data?.map(c => c.city_id) || [],
  } as AuthRequest['user'];

  cacheSet(token, user, verified.exp);
  req.user = user;
  req.accessToken = token;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (isDemo(req.user)) return next();
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

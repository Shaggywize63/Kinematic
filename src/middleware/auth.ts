import { Response, NextFunction } from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest, UserRole } from '../types';
import { DEMO_ORG_ID, DEMO_USER_ID, isDemo } from '../utils/demoData';
import { unauthorized, forbidden } from '../utils/response';
import { logger } from '../lib/logger';
import { resolveEntitlements } from '../lib/entitlements';

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

// Real Supabase accounts that should be treated as the demo user. When the
// caller signs in with one of these emails the rest of the code (demoCrm,
// demoExtensions, isDemo()) treats them exactly like the placeholder-token
// demo user — they get the canned fixtures across every module. Useful for
// sales / sandbox tours that need a stable login but full demo data.
const DEMO_EMAIL_ALLOWLIST = new Set([
  'demo@kinematicapp.com',
  'demo@kinematic.com',
  'demo@kinematic.app',
]);

// Permissions/role payload applied to any user the auth layer elevates to
// the demo account. Kept identical to the placeholder-token branch below so
// the two paths produce equivalent req.user objects.
const DEMO_PERMISSIONS = [
  'dashboard', 'analytics', 'users', 'attendance', 'zones', 'inventory',
  'form_builder', 'reports', 'broadcast', 'broadcasts', 'grievances',
  'wms', 'warehouse', 'clients', 'management', 'settings', 'skus', 'assets',
  'crm', 'distribution', 'planograms', 'route_plans', 'visit_logs',
  'campaigns', 'leaderboard', 'notifications', 'sos', 'candidates',
  'learning', 'manpower', 'work_activity', 'audit', 'integrations',
];

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

// Token verification — three paths in order of preference:
//   1. Asymmetric (RS256/ES256) via JWKS — for projects on Supabase's modern
//      Signing Keys. Set SUPABASE_JWKS_URL to the .well-known/jwks.json URL
//      (typically https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json).
//      jose caches the JWKS and refreshes on key rotation.
//   2. Symmetric HS256 via legacy shared secret — for projects still using
//      the old JWT secret. Set SUPABASE_JWT_SECRET.
//   3. Network fallback to supabaseAdmin.auth.getUser — if both env vars are
//      missing OR local verify rejects (wrong key/alg/expired). Slower but
//      keeps auth working through misconfiguration.
const SUPABASE_JWKS_URL   = process.env.SUPABASE_JWKS_URL || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const JWKS = SUPABASE_JWKS_URL
  ? createRemoteJWKSet(new URL(SUPABASE_JWKS_URL), { cooldownDuration: 30_000 })
  : null;
const HS256_KEY = SUPABASE_JWT_SECRET ? new TextEncoder().encode(SUPABASE_JWT_SECRET) : null;

let warnedJwks = false;
let warnedHs256 = false;

async function verifyToken(token: string): Promise<{ sub: string; exp?: number; email?: string } | null> {
  // 1. JWKS / asymmetric path
  if (JWKS) {
    try {
      const { payload } = await jwtVerify(token, JWKS);
      if (payload.sub) return { sub: payload.sub, exp: payload.exp, email: (payload as any).email };
    } catch (e: any) {
      if (!warnedJwks) {
        warnedJwks = true;
        logger.warn(`[Auth] JWKS verify failed (${e.code || e.message}); falling back. Check SUPABASE_JWKS_URL.`);
      }
    }
  }
  // 2. Legacy HS256 secret
  if (HS256_KEY) {
    try {
      const { payload } = await jwtVerify(token, HS256_KEY);
      if (payload.sub) return { sub: payload.sub, exp: payload.exp, email: (payload as any).email };
    } catch (e: any) {
      if (!warnedHs256) {
        warnedHs256 = true;
        logger.warn(`[Auth] HS256 verify failed (${e.code || e.message}); falling back to gotrue.`);
      }
    }
  }
  // 3. Network fallback (slow but always correct)
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return { sub: data.user.id, email: data.user.email ?? undefined };
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
      id: DEMO_USER_ID,
      org_id: DEMO_ORG_ID,
      client_id: null,
      name: 'Demo Admin',
      email: 'demo@kinematic.com',
      role: 'super_admin',
      is_active: true,
      permissions: DEMO_PERMISSIONS,
      assigned_cities: [],
      // Demo super_admin sees every module/package (resolveEntitlements bypasses).
      enabled_modules: [],
      enabled_packages: []
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
      .select('id, org_id, client_id, name, email, mobile, role, zone_id, supervisor_id, fcm_token, is_active')
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

  // --- DEMO EMAIL ELEVATION ---
  // If the caller signed in as one of the demo emails, promote the user
  // object to the same shape the placeholder-token bypass produces above.
  // Downstream isDemo() checks and the demo middleware (demoCrm, demoExtensions)
  // then serve the canned fixtures across every module — even though the
  // underlying Supabase row has a real org_id.
  const callerEmail = (verified.email || profile.email || '').toLowerCase();
  const isDemoEmail = callerEmail && DEMO_EMAIL_ALLOWLIST.has(callerEmail);
  if (isDemoEmail) {
    profile.org_id = DEMO_ORG_ID;
    profile.role = 'super_admin';
    logger.info(`[Auth] Demo email elevation applied for ${callerEmail} (sub=${verified.sub})`);
  }

  const entitlements = await resolveEntitlements({
    role: profile.role,
    clientId: profile.client_id,
    orgId: profile.org_id,
  });

  const user = {
    ...profile,
    permissions: isDemoEmail ? DEMO_PERMISSIONS : (permsRes.data?.map(p => p.module_id) || []),
    assigned_cities: citiesRes.data?.map(c => c.city_id) || [],
    enabled_modules: entitlements.enabled_modules,
    enabled_packages: entitlements.enabled_packages,
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
    if (!req.user) return unauthorized(res);
    const role = req.user.role?.toLowerCase();
    const permissions = req.user.permissions || [];
    const entitlements = req.user.enabled_modules || [];

    if (role === 'super_admin') return next();
    // Entitlement gate: client must have purchased/been-granted the module.
    if (entitlements.length > 0 && !entitlements.includes(moduleName)) {
      return forbidden(res, `Module not enabled for your account: ${moduleName}`);
    }
    // Per-user RBAC inside a client: legacy permissions array still respected.
    if (permissions.includes(moduleName)) return next();
    // If no per-user permissions exist (admin/main_admin defaults), entitlement is sufficient.
    if (entitlements.includes(moduleName)) return next();

    return forbidden(res, `Unauthorized: Missing ${moduleName} module`);
  };
}

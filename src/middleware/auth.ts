import { Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { currentProjectKey, verifyProjectToken } from '../lib/projects';
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

// Single demo account. When the caller signs in as this email, requireAuth
// promotes the user object to the same shape the placeholder-token bypass
// produces (super_admin role + DEMO_ORG_ID + full module permissions) so the
// downstream demo middleware (demoCrm, demoExtensions, isDemo) treats them
// as the demo user across every module.
const DEMO_EMAIL = 'demo@kinematic.com';

// Demo mode grants super_admin via a guessable static token / email and is a
// finding for any pen-test (SECURITY_AUDIT_2026-07.md H-1). It is scoped to the
// sentinel DEMO_ORG_ID (fixture data only), but we still make it secure-by-default:
// DISABLED in production unless an operator explicitly opts in with DEMO_MODE=on.
// In non-production it stays on for developer convenience.
// NOTE for ops: if the live customer-facing demo login relies on this in prod,
// set DEMO_MODE=on on the production server — otherwise demo login is rejected.
const DEMO_MODE_ENABLED =
  process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE === 'on';

// Permissions/role payload applied to the demo account. Kept identical to
// the placeholder-token branch below so the two paths produce equivalent
// req.user objects.
const DEMO_PERMISSIONS = [
  'dashboard', 'analytics', 'users', 'attendance', 'zones', 'inventory',
  'form_builder', 'reports', 'broadcast', 'broadcasts', 'grievances',
  'wms', 'warehouse', 'clients', 'management', 'settings', 'skus', 'assets',
  'crm', 'distribution', 'planograms', 'route_plans', 'visit_logs',
  'campaigns', 'leaderboard', 'notifications', 'sos', 'candidates',
  'learning', 'manpower', 'work_activity', 'audit', 'integrations',
  'hr',
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

const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Super-admin "Login as client": when a super_admin sends an X-Org-Id that
// differs from their own org, scope THIS request to that org (impersonation).
// Returns a CLONE so the token-keyed auth cache is never polluted — the cached
// entry always holds the real profile org. Gated strictly to super_admin; for
// every other role org always comes from the profile, so this is a no-op.
// Normal super-admin traffic sends their own org (X-Org-Id === own) → no-op.
function maybeImpersonate(user: AuthRequest['user'], req: AuthRequest): AuthRequest['user'] {
  if (!user || (user as { role?: string }).role !== 'super_admin') return user;
  const raw = req.headers['x-org-id'];
  const target = Array.isArray(raw) ? raw[0] : raw;
  if (!target || !ORG_UUID_RE.test(target) || target === (user as { org_id?: string }).org_id) return user;
  logger.info(`[Auth] super_admin acting as org ${target}`);
  return { ...(user as object), org_id: target } as AuthRequest['user'];
}

/** Invalidate every cached profile for a user — call this on role/permission changes. */
export function invalidateAuthCache(predicate?: (u: AuthRequest['user']) => boolean) {
  if (!predicate) { authCache.clear(); return; }
  for (const [token, entry] of authCache) {
    if (predicate(entry.user)) authCache.delete(token);
  }
}

// Token verification — three paths in order of preference, all scoped to the
// CURRENT request's Supabase project (resolved from AsyncLocalStorage):
//   1. Asymmetric (RS256/ES256) via the project's JWKS — modern Signing Keys.
//   2. Symmetric HS256 via the project's legacy shared secret.
//      (Both are configured per project in lib/projects from {,KINEMATIC_}
//       SUPABASE_JWKS_URL / SUPABASE_JWT_SECRET; jose caches + rotates JWKS.)
//   3. Network fallback to supabaseAdmin.auth.getUser for the current project —
//      if local verify is unavailable OR rejects. Slower but always correct,
//      and supabaseAdmin already points at the current project's gotrue.
// A token minted by one project will NOT verify against another project's
// keys, so cross-project token confusion fails closed.
async function verifyToken(token: string): Promise<{ sub: string; exp?: number; email?: string; act_org_id?: string } | null> {
  const projectKey = currentProjectKey();

  // 1 + 2. Local verification against this project's keys.
  const result = await verifyProjectToken(projectKey, token);
  if (result?.payload?.sub) {
    const p = result.payload as { email?: string; act?: boolean; act_org_id?: string };
    return {
      sub: result.payload.sub,
      exp: result.payload.exp,
      email: p.email,
      // Super-admin "Login as client" impersonation claim (minted by
      // POST /clients/:id/impersonate, signed with this project's HS256 secret).
      act_org_id: p.act === true && typeof p.act_org_id === 'string' ? p.act_org_id : undefined,
    };
  }

  // 3. Network fallback (slow but always correct), against this project's gotrue.
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return { sub: data.user.id, email: data.user.email ?? undefined };
  } catch (e: any) {
    logger.error(`[Auth] supabase.auth.getUser exception: ${e.message}`);
    return null;
  }
}

/**
 * Single-device login enforcement (mobile only).
 *
 * Mobile clients identify themselves via the X-Kinematic-Platform header
 * ("android" or "ios"). On a mobile request, if the user row has an
 * active_session_id set, the request's X-Session-Id header must match.
 * Mismatch → 401 with `code: 'DEVICE_REPLACED'`, telling the mobile to
 * clear local credentials and force-logout.
 *
 * Returns true if the request should be REJECTED (handler will send 401).
 * Returns false when the request is allowed to continue (no enforcement,
 * or session matches).
 *
 * Three scenarios that fall through (no rejection):
 *   - Non-mobile platform (web dashboard, server-to-server): not enforced.
 *   - User has never logged in via the new build (active_session_id IS NULL).
 *   - User has logged out (clear_user_session set active_session_id to NULL).
 */
function rejectIfStaleSession(req: AuthRequest, res: Response, user: AuthRequest['user']): boolean {
  const platform = String(req.headers['x-kinematic-platform'] || '').toLowerCase();
  if (platform !== 'android' && platform !== 'ios') return false;

  const activeSessionId = (user as any)?.active_session_id as string | null | undefined;
  if (!activeSessionId) return false;

  const headerSessionId = String(req.headers['x-session-id'] || '').trim();
  if (headerSessionId && headerSessionId === activeSessionId) return false;

  // Mismatch — kick the device. Also nuke this user from the auth cache
  // so the next request (from any device using the same cached entry)
  // re-fetches a fresh profile instead of hitting the same stale row.
  invalidateAuthCache((u) => u?.id === user?.id);

  const deviceLabel = (user as any)?.active_session_device || 'another device';
  res.status(401).json({
    success: false,
    error: 'DEVICE_REPLACED',
    code: 'DEVICE_REPLACED',
    message: `Your account was just signed in on ${deviceLabel}. This device has been signed out.`,
    device: deviceLabel,
  });
  return true;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(res, 'Missing or invalid Authorization header');
  }

  const token = authHeader.split(' ')[1].replace(/['"]+/g, '').trim();

  // --- DEMO TOKEN BYPASS ---
  if (DEMO_MODE_ENABLED && token === 'demo-token-jwt-placeholder') {
    logger.warn(`[Auth] Demo token accepted (demo mode enabled) from ${req.ip}`);
    req.user = {
      id: DEMO_USER_ID,
      org_id: DEMO_ORG_ID,
      client_id: null,
      name: 'Demo Admin',
      email: DEMO_EMAIL,
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

  // Cache key is scoped by project so two projects' tokens (which are signed
  // by different keys and never collide anyway) can never share a profile.
  const cacheKey = `${currentProjectKey()}:${token}`;

  // Hot path — cache hit avoids both JWT verification AND profile lookup.
  const cached = cacheGet(cacheKey);
  if (cached) {
    if (rejectIfStaleSession(req, res, cached)) return;
    req.user = maybeImpersonate(cached, req);
    req.accessToken = token;
    return next();
  }

  const verified = await verifyToken(token);
  if (!verified) return unauthorized(res, 'Invalid or expired token');

  // Cold path — fetch profile + permissions + cities in parallel (was sequential).
  // The cities join also resolves the city NAME because downstream RBAC
  // filters CRM records by name (crm_leads.city/contacts.city are text columns).
  const [profileRes, permsRes, citiesRes] = await Promise.all([
    supabaseAdmin
      .from('users')
      .select('id, org_id, client_id, name, email, mobile, role, zone_id, supervisor_id, fcm_token, is_active, active_session_id, active_session_device, org_role_id')
      .eq('id', verified.sub)
      .single(),
    supabaseAdmin.from('user_module_permissions').select('module_id').eq('user_id', verified.sub),
    supabaseAdmin.from('user_city_assignments').select('city_id, cities!city_id(name)').eq('user_id', verified.sub),
  ]);

  if (profileRes.error || !profileRes.data) {
    logger.error(`[Auth] Profile lookup failed for ${verified.sub}: ${profileRes.error?.message || 'not found'}`);
    return unauthorized(res, 'User profile not found');
  }

  const profile = profileRes.data;
  if (!profile.is_active) return forbidden(res, 'Account is deactivated');

  if (profile.role) profile.role = profile.role.toLowerCase();

  // --- DEMO EMAIL ELEVATION ---
  // The dashboard already short-circuits demo@kinematic.com on the client and
  // never hits the network — but a few endpoints (live-tracking, admin form
  // submissions) bypass the client mock and call us directly. When they do,
  // we still need isDemo() to be true so the demo middleware serves fixtures
  // instead of querying the empty demo-org rows. Promote to the same payload
  // the placeholder-token bypass produces above.
  const callerEmail = (verified.email || profile.email || '').toLowerCase();
  const isDemoEmail = DEMO_MODE_ENABLED && callerEmail === DEMO_EMAIL;
  if (isDemoEmail) {
    profile.org_id = DEMO_ORG_ID;
    profile.role = 'super_admin';
    logger.info(`[Auth] Demo email elevation applied for ${callerEmail} (sub=${verified.sub})`);
  }

  // Super-admin "Login as client": the impersonation token carries act_org_id.
  // Scope this whole session to that org so data + entitlements resolve there.
  // Gated to super_admin; the token is minted only by the super-admin-only
  // /clients/:id/impersonate endpoint and signed with the project secret. The
  // result is cached under the (unique) impersonation token, so the real
  // token's cached identity is never affected.
  if (verified.act_org_id && profile.role === 'super_admin') {
    logger.info(`[Auth] super_admin ${profile.id} impersonating org ${verified.act_org_id}`);
    profile.org_id = verified.act_org_id;
  }

  const entitlements = await resolveEntitlements({
    role: profile.role,
    clientId: profile.client_id,
    orgId: profile.org_id,
  });

  // City NAMES from the user_city_assignments join — used by CRM list
  // queries because crm_leads.city / crm_contacts.city are TEXT (names).
  const userCityIds: string[] = [];
  const userCityNames: string[] = [];
  for (const row of (citiesRes.data || []) as Array<{ city_id: string; cities: { name?: string } | { name?: string }[] | null }>) {
    if (row.city_id) userCityIds.push(row.city_id);
    const rel = Array.isArray(row.cities) ? row.cities[0] : row.cities;
    if (rel?.name) userCityNames.push(rel.name);
  }

  // The hierarchy role caps the user's city access — load its assigned_cities
  // (text[] of names) so getEffectiveCityNames() can intersect them with the
  // user's own list. Skipped when the user has no hierarchy role attached.
  // Also fetches `data_scope` (own | team | all) which drives per-user
  // visibility filters on activities — see activityVisibilityScope() in
  // crm.routes.ts. Most tenants run users at system_role=sub_admin
  // regardless of their actual seniority, so the system-role check
  // alone isn't enough to scope frontline reps to their own data.
  let roleAssignedCities: string[] = [];
  let orgRoleDataScope: 'own' | 'team' | 'all' = 'all';
  let orgRoleName: string | undefined;
  // org_roles.permissions (read) / permissions_write are the source of truth the
  // Roles UI configures. We load them so requireModuleAccess() can gate reads vs
  // writes per module instead of relying on the looser client-entitlement check.
  let rolePermissions: string[] | undefined;
  let rolePermissionsWrite: string[] | undefined;
  if (profile.org_role_id) {
    const { data: roleRow } = await supabaseAdmin
      .from('org_roles').select('name, assigned_cities, data_scope, permissions, permissions_write')
      .eq('id', profile.org_role_id).single();
    if (Array.isArray(roleRow?.assigned_cities)) {
      roleAssignedCities = (roleRow!.assigned_cities as string[]).filter(Boolean);
    }
    if (roleRow?.data_scope === 'own' || roleRow?.data_scope === 'team') {
      orgRoleDataScope = roleRow.data_scope as 'own' | 'team';
    }
    if (typeof roleRow?.name === 'string') {
      orgRoleName = roleRow.name;
    }
    if (Array.isArray(roleRow?.permissions)) {
      rolePermissions = (roleRow!.permissions as string[]).filter(Boolean);
    }
    if (Array.isArray(roleRow?.permissions_write)) {
      rolePermissionsWrite = (roleRow!.permissions_write as string[]).filter(Boolean);
    }
  }

  const user = {
    ...profile,
    permissions: isDemoEmail ? DEMO_PERMISSIONS : (permsRes.data?.map(p => p.module_id) || []),
    assigned_cities: userCityIds,
    assigned_city_names: userCityNames,
    role_assigned_cities: roleAssignedCities,
    org_role_data_scope: orgRoleDataScope,
    org_role_name: orgRoleName,
    role_permissions: rolePermissions,
    role_permissions_write: rolePermissionsWrite,
    enabled_modules: entitlements.enabled_modules,
    enabled_packages: entitlements.enabled_packages,
  } as AuthRequest['user'];

  // Session check happens AFTER we have the fresh profile (with the
  // current active_session_id straight from the DB). Cached entries hit
  // the same check above against the cached value — which is invalidated
  // on every session rotation via invalidateAuthCache(), so cache hits
  // can't ride a stale session_id past this gate.
  if (rejectIfStaleSession(req, res, user)) return;

  cacheSet(cacheKey, user, verified.exp);
  req.user = maybeImpersonate(user, req);
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

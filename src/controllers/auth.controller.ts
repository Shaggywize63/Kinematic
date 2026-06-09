import { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { supabase, supabaseAdmin, getUserClient } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, unauthorized, serverError, isDemo } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../lib/logger';
import { DEMO_ORG_ID, DEMO_USER_ID } from '../utils/demoData';
import { resolveEntitlements } from '../lib/entitlements';
import { invalidateAuthCache } from '../middleware/auth';

const loginSchema = z.object({
  // Accept either email or mobile number (or mobile@kinematic.app constructed by app)
  email: z.string().min(6),
  password: z.string().min(6),
  fcm_token: z.string().optional(),
  device_id: z.string().optional(),
  // Mobile-only device metadata used for the single-device-login feature.
  // The triple is stitched into a human-readable label stored on
  // users.active_session_device so the kicked device sees a friendly
  // "Your account was signed in on Realme 12 Pro" message.
  device_model: z.string().optional(),
  device_brand: z.string().optional(),
  os_version: z.string().optional(),
  platform: z.enum(['android', 'ios', 'web']).optional(),
});

const refreshSchema = z.object({
  refresh_token: z.string(),
});

// Default FE location-ping cadence in seconds. Used when org_settings has
// no override row for the requesting user's org. 600s = 10 min, which
// matches the LocationTrackingService default on Android.
const DEFAULT_LOCATION_PING_INTERVAL_SECONDS = 600;

async function getLocationPingIntervalSeconds(orgId: string | null | undefined): Promise<number> {
  if (!orgId) return DEFAULT_LOCATION_PING_INTERVAL_SECONDS;
  const { data } = await supabaseAdmin
    .from('org_settings')
    .select('value')
    .eq('org_id', orgId)
    .eq('key', 'location_ping_interval_seconds')
    .maybeSingle();
  // org_settings.value is a JSONB column; the seed stores it as a bare
  // number (e.g. 600), but historically some keys have been stored as
  // { value: 600 } objects. Accept both shapes.
  const raw = (data as any)?.value;
  if (typeof raw === 'number' && raw > 0) return raw;
  if (raw && typeof raw === 'object' && typeof raw.value === 'number' && raw.value > 0) return raw.value;
  return DEFAULT_LOCATION_PING_INTERVAL_SECONDS;
}

// Resolves the org's B2B/B2C mode so mobile + dashboard can hide irrelevant
// input fields. crm_settings is now keyed by (org_id, client_id) — prefer
// the user's own per-client row, fall back to the org-default row, then to
// 'both' when neither exists. Without this fallback chain, a user pinned
// to a client whose row hasn't been saved yet would always see 'both'.
type BusinessType = 'b2b' | 'b2c' | 'both';
async function getCrmBusinessType(orgId: string | null | undefined, clientId: string | null | undefined): Promise<BusinessType> {
  if (!orgId) return 'both';
  if (clientId) {
    const { data } = await supabaseAdmin
      .from('crm_settings')
      .select('business_type')
      .eq('org_id', orgId).eq('client_id', clientId)
      .maybeSingle();
    const v = (data as any)?.business_type;
    if (v === 'b2b' || v === 'b2c' || v === 'both') return v;
  }
  const { data } = await supabaseAdmin
    .from('crm_settings')
    .select('business_type')
    .eq('org_id', orgId).is('client_id', null)
    .maybeSingle();
  const v = (data as any)?.business_type;
  return v === 'b2b' || v === 'b2c' || v === 'both' ? v : 'both';
}

/**
 * Build a human-readable device label for the kicked-device toast.
 * Examples:
 *   "Realme 12 Pro · Android 14"
 *   "iPhone15,3 · iOS 17.4"
 *   "Nokia 6.1"  (when os/brand missing)
 */
function buildDeviceLabel(opts: { model?: string; brand?: string; os?: string; platform?: string }): string {
  const left = [opts.brand, opts.model].filter(Boolean).join(' ').trim();
  const right = opts.os ? (opts.platform === 'ios' ? `iOS ${opts.os}` : `Android ${opts.os}`) : '';
  if (left && right) return `${left} · ${right}`;
  return left || right || 'mobile device';
}

// POST /api/v1/auth/login
export const login = asyncHandler<Request>(async (req, res) => {
  const body = loginSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  let { email, password, fcm_token, device_id, device_model, device_brand, os_version, platform } = body.data;

  // Mobile platform is inferred from the explicit `platform` field OR the
  // X-Kinematic-Platform header the mobile auth interceptor stamps.
  const headerPlatform = String(req.headers['x-kinematic-platform'] || '').toLowerCase();
  const effectivePlatform = platform || (headerPlatform === 'android' || headerPlatform === 'ios' ? headerPlatform : undefined);
  const isMobileLogin = effectivePlatform === 'android' || effectivePlatform === 'ios';

  // --- DEMO LOGIN BYPASS ---
  // Both passwords route to the canned fixtures path. org_id=demo-org-999
  // makes every controller return its pre-built mock payload via isDemo(user).
  if (
    email.trim() === 'demo@kinematic.com' &&
    (password === 'kinematic-demo-2024' || password === 'Demo@1234')
  ) {
    logger.info('Restoring Demo Admin access via bypass');
    return ok(res, {
      access_token: 'demo-token-jwt-placeholder',
      refresh_token: 'demo-refresh-token-placeholder',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      // No session_id on demo — single-device enforcement skipped for the
      // shared demo account (multiple people demo at once).
      user: {
        id: DEMO_USER_ID,
        org_id: DEMO_ORG_ID,
        client_id: null,
        name: 'Demo Admin',
        email: 'demo@kinematic.com',
        role: 'super_admin',
        is_active: true,
        business_type: 'both',
        permissions: [
          'dashboard', 'analytics', 'users', 'attendance', 'zones', 'inventory',
          'form_builder', 'reports', 'broadcast', 'broadcasts', 'grievances',
          'wms', 'warehouse', 'clients', 'management', 'settings', 'skus', 'assets',
          'crm', 'distribution', 'planograms', 'route_plans', 'visit_logs',
          'campaigns', 'leaderboard', 'notifications', 'sos', 'candidates',
          'learning', 'manpower', 'work_activity', 'audit', 'integrations',
          'hr',
          // FFM Reports hub — new module so the dashboard nav surfaces
          // /dashboard/ffm-reports for the demo account.
          'ffm_reports',
        ]
      },
    });
  }


  // If login identifier is a mobile number or an @kinematic.app email, resolve to real email
  const isMobile = /^\d{10,15}$/.test(email.trim());
  const isAppEmail = email.endsWith('@kinematic.app');

  if (isMobile || isAppEmail) {
    const mobile = isMobile ? email.trim() : email.replace('@kinematic.app', '').trim();
    const { data: userLookup } = await supabaseAdmin
      .from('users')
      .select('email, mobile')
      .or(`mobile.eq.${mobile},mobile.eq.+91${mobile},mobile.eq.0${mobile}`)
      .single();

    if (!userLookup) {
      return res.status(401).json({ success: false, error: 'No account found for this mobile number. Contact your admin.' });
    }

    // If no real email set, fallback to internal mobile@kinematic.app format
    const resolvedEmail = userLookup.email || `${userLookup.mobile}@kinematic.app`;
    logger.info(`Resolved ${email} → ${resolvedEmail}`);
    email = resolvedEmail;
  }

  // Sign in directly with email + password via Supabase Auth
  console.log(`[DEBUG] Attempting login for ${email}...`);
  let { data: session, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    console.error(`[DEBUG] Auth error for ${email}: ${signInError.message}`);
  }

  if (signInError || !session?.session) {
    // If standard login fails, check for app_password in users table
    const { data: userProfile } = await supabaseAdmin
      .from('users')
      .select('id, role')
      .eq('email', email)
      .single();

    if (userProfile && false) { // Skip app_password check for now
      logger.info(`Valid app_password login for email: ${email}`);
      
      // Use magiclink OTP to sign the user in without their main password
      const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email,
      });

      if (!linkError && linkData?.properties?.email_otp) {
        const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
          email,
          token: linkData.properties.email_otp,
          type: 'magiclink',
        });

        if (!otpError && otpData?.session) {
          session = otpData as any;
        } else {
          logger.error(`Failed to verify OTP for app_password login: ${otpError?.message}`);
        }
      } else {
        logger.error(`Failed to generate link for app_password login: ${linkError?.message}`);
      }
    }
  }

  if (!session?.session) {
    logger.warn(`Failed login attempt for email: ${email} — ${signInError?.message}`);
    return res.status(401).json({ success: false, error: signInError?.message || 'Invalid credentials', code: signInError?.status });
  }

  // Fetch user profile from users table using the auth user id
  console.log(`[DEBUG] Fetching profile for user ID: ${session.user.id}`);
  const { data: userProfile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, org_id, client_id, name, email, role, is_active')
    .eq('id', session.user.id)
    .single();

  if (profileError || !userProfile) {
    console.error(`[DEBUG] Profile fetch error for ${email}: ${profileError?.message || 'Not found'}`);
    return unauthorized(res, 'User profile not found');
  }
  if (!userProfile.is_active) {
    console.warn(`[DEBUG] Account deactivated for ${email}`);
    return unauthorized(res, 'Account is deactivated. Contact your admin.');
  }

  // Fetch permissions separately (Bypass join relationship requirements)
  const { data: permsData } = await supabaseAdmin
    .from('user_module_permissions')
    .select('module_id')
    .eq('user_id', userProfile.id);

  const permissions = permsData?.map(p => p.module_id) || [];
  console.log(`[DEBUG] Login successful for ${email}. Permissions: ${permissions.length}`);

  // City NAMES the user is assigned to (resolved from user_city_assignments
  // → cities.name). The CRM city-scope picker in the dashboard reads this
  // off the stored login profile to show ONLY the user's assigned cities;
  // without it the picker falls back to listing every tenant city. Mirrors
  // the same resolution the auth middleware does for /auth/me.
  const { data: cityRows } = await supabaseAdmin
    .from('user_city_assignments')
    .select('cities!city_id(name)')
    .eq('user_id', userProfile.id);
  const assignedCityNames = ((cityRows || []) as Array<{ cities: { name?: string } | { name?: string }[] | null }>)
    .map((row) => (Array.isArray(row.cities) ? row.cities[0] : row.cities)?.name)
    .filter((n): n is string => !!n);

  // Resolve module entitlements (per-client SKU + universal modules).
  const entitlements = await resolveEntitlements({
    role: userProfile.role,
    clientId: userProfile.client_id,
    orgId: userProfile.org_id,
  });

  // Update FCM token and device ID if provided
  if (fcm_token || device_id) {
    await supabaseAdmin
      .from('users')
      .update({ ...(fcm_token && { fcm_token }), ...(device_id && { device_id }) })
      .eq('id', userProfile.id);
  }

  // ── Single-device session rotation (mobile only) ──────────────────
  // Generates a fresh session UUID, overwrites users.active_session_id,
  // and invalidates the in-memory auth cache so any previously-cached
  // entry for the prior device gets re-validated on its next request
  // (which will then hit the DEVICE_REPLACED branch in requireAuth).
  //
  // Web/dashboard logins skip this so admins can keep multi-browser
  // sessions; only fresh-installed mobile clients send platform=android
  // or platform=ios in the login body (or via X-Kinematic-Platform).
  let issuedSessionId: string | null = null;
  if (isMobileLogin) {
    issuedSessionId = randomUUID();
    const deviceLabel = buildDeviceLabel({
      model:    device_model,
      brand:    device_brand,
      os:       os_version,
      platform: effectivePlatform,
    });
    try {
      await supabaseAdmin.rpc('rotate_user_session', {
        p_user_id:        userProfile.id,
        p_new_session_id: issuedSessionId,
        p_device_label:   deviceLabel,
      });
      // Burn the cache so the OTHER (now-stale) device's cached profile
      // entry can't ride the previous session_id through middleware.
      invalidateAuthCache((u) => u?.id === userProfile.id);
      logger.info(`[Auth] Rotated session for ${userProfile.id} → ${issuedSessionId} (${deviceLabel})`);
    } catch (e: any) {
      // Don't fail login if session rotation crashes — log and continue.
      // The user is still authenticated; they just won't have single-device
      // enforcement this session. Safer than locking everyone out on a DB
      // hiccup.
      logger.error(`[Auth] Session rotation failed for ${userProfile.id}: ${e?.message || e}`);
      issuedSessionId = null;
    }
  }

  const locationPingIntervalSeconds = await getLocationPingIntervalSeconds(userProfile.org_id);
  const businessType = await getCrmBusinessType(userProfile.org_id, userProfile.client_id);

  return ok(res, {
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
    expires_at: session.session.expires_at,
    session_id: issuedSessionId,
    user: {
      ...userProfile,
      permissions,
      assigned_city_names: assignedCityNames,
      enabled_modules: entitlements.enabled_modules,
      enabled_packages: entitlements.enabled_packages,
      location_ping_interval_seconds: locationPingIntervalSeconds,
      business_type: businessType,
      active_session_id: issuedSessionId,
    },
  });
});

// POST /api/v1/auth/refresh
// POST /api/v1/auth/refresh
export const refresh = asyncHandler<Request>(async (req, res) => {
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
// POST /api/v1/auth/logout
export const logout = asyncHandler<AuthRequest>(async (req, res) => {
  if (req.accessToken) {
    const client = getUserClient(req.accessToken);
    await client.auth.signOut();
  }
  // Clear FCM token + active session on logout. Clearing the session
  // makes the next login from any device a "first login" — no kicked
  // device, no DEVICE_REPLACED toast — which is the right UX when the
  // user explicitly signed out themselves.
  if (req.user) {
    await supabaseAdmin.from('users').update({ fcm_token: null }).eq('id', req.user.id);
    try {
      await supabaseAdmin.rpc('clear_user_session', { p_user_id: req.user.id });
      invalidateAuthCache((u) => u?.id === req.user!.id);
    } catch (e: any) {
      logger.warn(`[Auth] clear_user_session failed for ${req.user.id}: ${e?.message || e}`);
    }
  }
  return ok(res, null, 'Logged out successfully');
});

// GET /api/v1/auth/me
// GET /api/v1/auth/me
export const me = asyncHandler<AuthRequest>(async (req, res) => {
  if (!req.user) return unauthorized(res);

  const { data, error } = await supabaseAdmin
    .from('users')
    .select(`
      id, org_id, client_id, name, mobile, email, role, employee_id,
      zone_id, supervisor_id, city, state, avatar_url, org_role_id,
      is_active, joined_date, created_at,
      zones!zone_id(id, name, city, meeting_lat, meeting_lng, geofence_radius),
      organisations!org_id(id, name, logo_url),
      org_role:org_roles!org_role_id(id, name, permissions, permissions_write, data_scope)
    `)
    .eq('id', req.user.id)
    .single();

  if (error) return serverError(res);

  // Legacy per-user grants — used only as a fallback when the user has no
  // org_role attached.
  const { data: permsData } = await supabaseAdmin
    .from('user_module_permissions')
    .select('module_id')
    .eq('user_id', req.user.id);

  const userModulePerms = permsData?.map(p => p.module_id) || [];

  // The org_role is the source of truth the Roles UI configures. When the user
  // has one, expose its read grants as `permissions` (so the dashboard nav hides
  // modules the role omits) plus `permissions_write` for write-action gating.
  // Users without a role fall back to the legacy per-user permission list — this
  // keeps existing admin accounts (no granular role) behaving as before.
  const orgRole = (data as any)?.org_role as
    | { permissions?: string[]; permissions_write?: string[] }
    | null
    | undefined;
  const hasRole = !!(data as any)?.org_role_id && Array.isArray(orgRole?.permissions);
  const permissions = hasRole ? (orgRole!.permissions as string[]) : userModulePerms;
  const permissions_write = hasRole ? (orgRole!.permissions_write ?? []) : userModulePerms;

  const entitlements = await resolveEntitlements({
    role: (data as any)?.role,
    clientId: (data as any)?.client_id,
    orgId: (data as any)?.org_id,
  });

  const locationPingIntervalSeconds = await getLocationPingIntervalSeconds((data as any)?.org_id);
  const businessType = await getCrmBusinessType((data as any)?.org_id, (data as any)?.client_id);

  const result = {
    ...data,
    permissions,
    permissions_write,
    enabled_modules: entitlements.enabled_modules,
    enabled_packages: entitlements.enabled_packages,
    location_ping_interval_seconds: locationPingIntervalSeconds,
    business_type: businessType,
    // Surface the user's city scope so the dashboard can render a city
    // picker. `assigned_city_names` is the user-level cap (resolved from
    // user_city_assignments → cities.name in auth middleware). Empty
    // array = no per-user restriction; the picker source then falls back
    // to the tenant's full city list. Mirrors the fields the auth
    // middleware already loaded onto req.user.
    assigned_cities: req.user.assigned_cities ?? [],
    assigned_city_names: (req.user as any).assigned_city_names ?? [],
    role_assigned_cities: (req.user as any).role_assigned_cities ?? [],
  };
  return ok(res, result);
});

// PATCH /api/v1/auth/me — lets the authenticated user update their own
// profile fields without going through the admin-gated /users/:id route.
// Intentionally narrow allow-list: only avatar_url + name today. Other
// fields (role, mobile, employee_id, etc.) stay admin-only because they
// affect access control or routing.
export const updateMe = asyncHandler<AuthRequest>(async (req, res) => {
  if (!req.user) return unauthorized(res);
  const allowed = ['avatar_url', 'name'] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    const v = (req.body as Record<string, unknown>)[key];
    // null is meaningful (clears the avatar); '' is treated as no-op so
    // an empty form field doesn't blow away an existing value.
    if (v !== undefined && v !== '') updates[key] = v;
  }
  if (Object.keys(updates).length === 0) {
    return ok(res, { updated: false });
  }
  const { data, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select('id, name, avatar_url, email, role, org_id')
    .single();
  if (error) return serverError(res);
  return ok(res, data);
});

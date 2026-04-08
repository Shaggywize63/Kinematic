import { Request, Response } from 'express';
import { z } from 'zod';
import { supabase, supabaseAdmin, getUserClient } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, unauthorized, serverError } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../lib/logger';
import { DEMO_ORG_ID } from '../utils/demoData';

const loginSchema = z.object({
  // Accept either email or mobile number (or mobile@kinematic.app constructed by app)
  email: z.string().min(6),
  password: z.string().min(6),
  fcm_token: z.string().optional(),
  device_id: z.string().optional(),
});

const refreshSchema = z.object({
  refresh_token: z.string(),
});

// POST /api/v1/auth/login
export const login = asyncHandler<Request>(async (req, res) => {
  const body = loginSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  let { email, password, fcm_token, device_id } = body.data;

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

  // --- DEMO MODE AUTH HIJACK ---
  if (email.toLowerCase() === 'demo@kinematic.com') {
    logger.info(`Demo login successful for ${email}`);
    return ok(res, {
      access_token: 'demo-token-jwt-placeholder',
      refresh_token: 'demo-refresh-placeholder',
      expires_at: 9999999999,
      user: {
        id: 'demo-user-id',
        org_id: DEMO_ORG_ID,
        client_id: null,
        name: 'Demo Admin',
        email: 'demo@kinematic.com',
        role: 'admin',
        is_active: true,
        permissions: ['dashboard', 'analytics', 'users', 'attendance', 'zones', 'inventory']
      },
    });
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
      ...userProfile,
      permissions
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
  // Clear FCM token on logout
  if (req.user) {
    await supabaseAdmin.from('users').update({ fcm_token: null }).eq('id', req.user.id);
  }
  return ok(res, null, 'Logged out successfully');
});

// GET /api/v1/auth/me
// GET /api/v1/auth/me
export const me = asyncHandler<AuthRequest>(async (req, res) => {
  if (!req.user) return unauthorized(res);

  if (req.user.org_id === DEMO_ORG_ID) {
    return ok(res, {
      id: 'demo-user-id',
      org_id: DEMO_ORG_ID,
      client_id: null,
      name: 'Demo Admin',
      email: 'demo@kinematic.com',
      role: 'admin',
      is_active: true,
      employee_id: 'DEMO-001',
      permissions: ['dashboard', 'analytics', 'users', 'attendance'],
      organisations: { id: DEMO_ORG_ID, name: 'Kinematic Demo Org', logo_url: null }
    });
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .select(`
      id, org_id, client_id, name, mobile, email, role, employee_id,
      zone_id, supervisor_id, city, state, avatar_url,
      is_active, joined_date, created_at,
      zones!zone_id(id, name, city, meeting_lat, meeting_lng, geofence_radius),
      organisations!org_id(id, name, logo_url)
    `)
    .eq('id', req.user.id)
    .single();

  if (error) return serverError(res);

  // Fetch permissions separately (Bypass join relationship requirements)
  const { data: permsData } = await supabaseAdmin
    .from('user_module_permissions')
    .select('module_id')
    .eq('user_id', req.user.id);

  const permissions = permsData?.map(p => p.module_id) || [];

  const result = {
    ...data,
    permissions
  };
  return ok(res, result);
});

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { asyncHandler, sendSuccess, sendPaginated, getPagination, AppError, todayDate, ok, isUUID } from '../utils';
import { AuthRequest } from '../types';
import { logger } from '../lib/logger';
import { DEMO_ORG_ID, isDemo, getMockZones, getMockClients, getMockSecurityAlerts, getMockUsers, getMockGrievances } from '../utils/demoData';

// VISIT LOGS
export const getVisitLogs = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!
  const date = (req.query.date as string) || todayDate()
  let query = supabaseAdmin
    .from('visit_logs')
    .select('*, visitor:visitor_id(id, name, role), executive:executive_id(id, name, zone_id, zones!zone_id(name))')
    .eq('date', date);

  const targetCid = isUUID(req.query.client_id as string) ? (req.query.client_id as string) : user.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', user.org_id);
  }
  if (user.role === 'executive') query = query.eq('executive_id', user.id);
  if (user.role === 'supervisor') query = query.eq('visitor_id', user.id);
  const { data, error } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data)
})

export const createVisitLog = asyncHandler<AuthRequest>(async (req, res) => {
  const { executive_id, rating, remarks, photo_url, latitude, longitude } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('visit_logs')
    .insert({ 
      org_id: user.org_id, 
      client_id: user.client_id,
      executive_id: executive_id || user.id, 
      visitor_id: user.id, 
      zone_id: user.zone_id, 
      date: todayDate(), 
      visited_at: new Date().toISOString(), 
      rating, 
      remarks: remarks || null, 
      photo_url: photo_url || null, 
      latitude: latitude || null, 
      longitude: longitude || null 
    })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Visit logged', 201)
})

// GRIEVANCES
export const submitGrievance = asyncHandler<AuthRequest>(async (req, res) => {
  const { category, against_role, incident_date, description, is_anonymous } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('grievances')
    .insert({ 
      org_id: user.org_id, 
      client_id: user.client_id,
      submitted_by: user.id, 
      category, 
      against_role: against_role || null, 
      incident_date: incident_date || null, 
      description, 
      is_anonymous: is_anonymous || false, 
      status: 'submitted' 
    })
    .select('id, reference_no, status, created_at').single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Grievance submitted. HR will review within 48 hours.', 201)
})

export const getMyGrievances = asyncHandler<AuthRequest>(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('grievances')
    .select('id, reference_no, category, status, created_at, resolution')
    .eq('submitted_by', req.user!.id).eq('is_anonymous', false)
    .order('created_at', { ascending: false })
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data)
})

export const getAllGrievances = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!
  if (isDemo(user)) return ok(res, getMockGrievances());
  const { status } = req.query
  const { page, limit, offset } = getPagination(
    parseInt(req.query.page as string) || 1,
    parseInt(req.query.limit as string) || 20
  )
  let query = supabaseAdmin.from('grievances')
    .select('*, submitted_by_user:submitted_by(id, name, zone_id)', { count: 'exact' });

  const targetCid = isUUID(req.query.client_id as string) ? (req.query.client_id as string) : user.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', user.org_id);
  }
  if (status) query = query.eq('status', status as string);
  const { data, error, count } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendPaginated(res, data || [], count || 0, page, limit)
})

export const updateGrievance = asyncHandler<AuthRequest>(async (req, res) => {
  const { status, resolution } = req.body
  let query = supabaseAdmin.from('grievances')
    .update({ status, resolution: resolution || null, reviewed_by: req.user!.id, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id);

  const targetCid = req.user!.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', req.user!.org_id);
  }
  const { data, error } = await query.select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Grievance updated')
})

// LEARNING CENTER
export const getMaterials = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('learning_materials')
    .select('*, learning_progress(is_completed, progress_pct, completed_at, last_accessed)')
    .eq('org_id', user.org_id).eq('is_active', true).contains('target_roles', [user.role])
    .order('published_at', { ascending: false })
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  const enriched = (data || []).map((m: any) => ({ ...m, my_progress: m.learning_progress?.[0] || null, learning_progress: undefined }))
  sendSuccess(res, enriched)
})

export const updateProgress = asyncHandler<AuthRequest>(async (req, res) => {
  const { progress_pct, is_completed } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('learning_progress')
    .upsert({ material_id: req.params.id, user_id: user.id, org_id: user.org_id, progress_pct: progress_pct || 0, is_completed: is_completed || false, completed_at: is_completed ? new Date().toISOString() : null, last_accessed: new Date().toISOString() }, { onConflict: 'material_id,user_id' })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Progress updated')
})

export const createMaterial = asyncHandler<AuthRequest>(async (req, res) => {
  const { title, description, category, type, file_url, thumbnail_url, duration_min, page_count, target_roles, is_mandatory } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('learning_materials')
    .insert({ org_id: user.org_id, title, description: description || null, category: category || null, type, file_url, thumbnail_url: thumbnail_url || null, duration_min: duration_min || null, page_count: page_count || null, target_roles: target_roles || ['executive'], is_mandatory: is_mandatory || false, created_by: user.id, published_at: new Date().toISOString() })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Material created', 201)
})

// NOTIFICATIONS
export const getNotifications = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!
  const { page, limit, offset } = getPagination(
    parseInt(req.query.page as string) || 1,
    parseInt(req.query.limit as string) || 20
  )
  const { data, error, count } = await supabaseAdmin.from('notifications')
    .select('*', { count: 'exact' }).eq('user_id', user.id)
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1)
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendPaginated(res, data || [], count || 0, page, limit)
})

export const markRead = asyncHandler<AuthRequest>(async (req, res) => {
  const { ids } = req.body
  let query = supabaseAdmin.from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() }).eq('user_id', req.user!.id)
  if (ids && ids !== 'all') query = query.in('id', ids)
  const { error } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, null, 'Marked as read')
})

// USERS
export const getUsers = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  const user = req.user!
  if (isDemo(user)) {
    const mock = getMockUsers();
    const { page, limit, offset } = getPagination(
      parseInt(req.query.page as string) || 1,
      parseInt(req.query.limit as string) || 100
    );
    const search = (req.query.search as string || '').toLowerCase();
    let filtered = mock;
    if (search) {
      filtered = mock.filter(u => 
        u.name.toLowerCase().includes(search) || 
        u.employee_id.toLowerCase().includes(search)
      );
    }
    const data = filtered.slice(offset, offset + limit);
    return sendSuccess(res, data, 'Success', 200);
  }
  
  const { role: filterRole, zone_id, is_active, client_id } = req.query;
  // Dashboard's api.ts auto-attaches the active client picker as the
  // X-Client-Id header on every request. Honour it as a fallback so the
  // CRM Settings → Team Members page (and any other consumer that doesn't
  // pass ?client_id=…) gets scoped to the picked tenant for platform
  // admins. Header is advisory: client-pinned users are still constrained
  // to their own JWT client_id below.
  const headerClientId = (req.headers['x-client-id'] as string | undefined) || undefined;
  const { page, limit, offset } = getPagination(
    parseInt(req.query.page as string) || 1,
    parseInt(req.query.limit as string) || 100
  );

  // Join the hierarchy role's name so the Team Members / Admins lists can
  // show a real designation (Business Manager, Consumer Champion, etc.)
  // instead of leaking internal preset roles. Stamped on each row as
  // `org_role_name` below.
  let query = supabaseAdmin.from('users').select('*, org_role:org_roles!org_role_id(name)', { count: 'exact' });

  const isPrivileged = ['super_admin', 'admin', 'hr', 'city_manager', 'sub_admin', 'main_admin', 'client'].includes(user.role?.toLowerCase());
  const isSuper = user.role?.toLowerCase() === 'super_admin';

  if (!isSuper) {
    if (user.org_id) {
      query = query.eq('org_id', user.org_id);
    }
  }

  if (isUUID(user.client_id)) {
    // Client-pinned users (including privileged admins of a client) only
    // see their own client's users. Platform-level admins (client_id=null)
    // were previously leaking in via an OR clause — they showed up as
    // assignable in every client's CRM, which doesn't match how CRM
    // ownership actually works.
    query = query.eq('client_id', user.client_id);
  } else if (isUUID(client_id as string)) {
    // Explicit ?client_id= query param wins over the header.
    query = query.eq('client_id', client_id as string);
  } else if (isUUID(headerClientId)) {
    // Global client picker — sent as X-Client-Id by dashboard api.ts.
    // Without this fallback, a super_admin browsing "Tata Tiscon" would
    // see every user in the org because no client filter was applied.
    query = query.eq('client_id', headerClientId);
  }
  // else: platform admin with no picker selection → see all users.

  if (zone_id) query = query.eq('zone_id', zone_id as string);
  if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
  if (user.role === 'supervisor') query = query.eq('supervisor_id', user.id);

  if (user.role === 'city_manager' && user.assigned_cities?.length) {
    query = query.in('city', user.assigned_cities);
  }

  // Hierarchy-scoped visibility: a logged-in user should not see their own
  // managers. Walks the org_roles tree from the user's org_role_id up via
  // parent_id, collects every ancestor role id, then excludes users whose
  // org_role_id sits in that set. Platform-tier users (super_admin / admin)
  // bypass — they need to see everyone for support / oversight.
  if (user.role !== 'super_admin' && user.role !== 'admin' && (user as any).org_role_id) {
    const myRoleId = (user as any).org_role_id as string;
    // One fetch of the org's roles; walk in memory. Depth is typically <10
    // so this is faster + simpler than chained DB lookups.
    const { data: roleRows } = await supabaseAdmin
      .from('org_roles')
      .select('id, parent_id')
      .eq('org_id', user.org_id);
    const parentMap = new Map<string, string | null>();
    for (const r of (roleRows || []) as Array<{ id: string; parent_id: string | null }>) {
      parentMap.set(r.id, r.parent_id);
    }
    const ancestors = new Set<string>();
    let cursor: string | null = parentMap.get(myRoleId) ?? null;
    // Cap iterations defensively against malformed cycles.
    for (let i = 0; i < 20 && cursor && !ancestors.has(cursor); i++) {
      ancestors.add(cursor);
      cursor = parentMap.get(cursor) ?? null;
    }
    if (ancestors.size > 0) {
      const ids = Array.from(ancestors).join(',');
      query = query.not('org_role_id', 'in', `(${ids})`);
    }
  }

  query = query.order('name').range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  const userIds = (data || []).map((u: any) => u.id);
  // UTC year-month for kini_usage rows. Mirrors kiniQuota.service.ts so
  // the sum here matches the gate's view.
  const monthNow = (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  const [attRes, permRes, cityRes, kiniRes] = await Promise.all([
    userIds.length > 0
      ? supabaseAdmin.from('attendance').select('user_id, total_hours, status, checkin_at').eq('date', todayDate()).in('user_id', userIds)
      : { data: [] },
    userIds.length > 0
      ? supabaseAdmin.from('user_module_permissions').select('user_id, module_id').in('user_id', userIds)
      : { data: [] },
    // Join `user_city_assignments` so the Team Members table can show
    // each user's assigned cities (count + names) without an N+1. The
    // nested `cities!city_id(name)` resolves the city name in one round
    // trip — falls back to bare id if the FK can't resolve.
    userIds.length > 0
      ? supabaseAdmin.from('user_city_assignments').select('user_id, city_id, cities!city_id(name)').in('user_id', userIds)
      : { data: [] },
    // KINI AI usage for the current month — summed across platforms per
    // user so admins can see "X / 20" in the Team Members table.
    userIds.length > 0
      ? supabaseAdmin.from('kini_usage').select('user_id, query_count').in('user_id', userIds).eq('month', monthNow)
      : { data: [] }
  ]);

  const attMap = new Map((attRes.data || []).map((a: any) => [a.user_id, a]));
  const permMap = new Map<string, string[]>();
  (permRes.data || []).forEach((p: any) => {
    const list = permMap.get(p.user_id) || [];
    list.push(p.module_id);
    permMap.set(p.user_id, list);
  });
  // city_id list AND name list — frontend uses ids for edit, names for
  // the table column.
  const cityIdMap = new Map<string, string[]>();
  const cityNameMap = new Map<string, string[]>();
  (cityRes.data || []).forEach((c: any) => {
    const ids = cityIdMap.get(c.user_id) || [];
    ids.push(c.city_id);
    cityIdMap.set(c.user_id, ids);
    const cityRel = Array.isArray(c.cities) ? c.cities[0] : c.cities;
    if (cityRel?.name) {
      const names = cityNameMap.get(c.user_id) || [];
      names.push(cityRel.name);
      cityNameMap.set(c.user_id, names);
    }
  });

  // KINI usage (current month) summed across platforms per user.
  const kiniUsedMap = new Map<string, number>();
  for (const r of (kiniRes.data || []) as Array<{ user_id: string; query_count: number | null }>) {
    kiniUsedMap.set(r.user_id, (kiniUsedMap.get(r.user_id) ?? 0) + (r.query_count ?? 0));
  }
  // Per-user cap — defaults to env (KINI_MONTHLY_QUERY_CAP) or 20 if unset.
  // Org/client overrides via org_settings.kini_user_monthly_query_limit are
  // honoured at request-time by kiniQuota.service.ts; we only need a display
  // value here so we don't fan out one settings query per row.
  const KINI_USER_CAP = (() => {
    const env = Number(process.env.KINI_MONTHLY_QUERY_CAP);
    return Number.isFinite(env) && env > 0 ? Math.floor(env) : 20;
  })();

  const now = new Date().getTime();
  const enrichedData = (data || []).map((u: any) => {
    if (u.zones && Array.isArray(u.zones)) u.zones = u.zones[0];
    const att: any = attMap.get(u.id);
    if (att) {
      u.hours_worked = att.total_hours || (att.status === 'checked_in' && att.checkin_at ? Math.max(0, now - new Date(att.checkin_at).getTime()) / 3600000 : 0);
      u.is_checked_in = att.status === 'checked_in';
    } else {
      u.hours_worked = 0; u.is_checked_in = false;
    }
    u.permissions = permMap.get(u.id) || [];
    u.assigned_cities = cityIdMap.get(u.id) || [];
    u.assigned_city_names = cityNameMap.get(u.id) || [];
    u.kini_used_this_month = kiniUsedMap.get(u.id) ?? 0;
    u.kini_monthly_cap = KINI_USER_CAP;
    return u;
  });

  let filteredData = enrichedData;
  if (filterRole) {
    const target = (filterRole as string).toLowerCase().replace(/-/g, '_');
    filteredData = enrichedData.filter((u: any) => {
      const uRole = (u.role || '').toLowerCase().replace(/-/g, '_');
      return uRole === target || (target === 'field_executive' && uRole === 'executive');
    });
  }

  return sendPaginated(res, filteredData, count || 0, page, limit);
});




export const getUserById = asyncHandler<AuthRequest>(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('users')
    .select('*, zones!zone_id(name)')
    .eq('id', req.params.id).eq('org_id', req.user!.org_id).single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  if (!data) throw new AppError(404, 'User not found', 'NOT_FOUND')
  sendSuccess(res, data)
})

export const createUser = asyncHandler<AuthRequest>(async (req, res) => {
  const { name, mobile, password, app_password, role, zone_id, supervisor_id, employee_id, joined_date, city, email, org_role_id } = req.body
  const admin = req.user!

  // Validate required fields
  if (!name || !mobile || !password) {
    throw new AppError(400, 'name, mobile and password are required', 'VALIDATION_ERROR')
  }
  if (!/^\d{10}$/.test(mobile)) {
    throw new AppError(400, 'Mobile number must be exactly 10 digits', 'VALIDATION_ERROR')
  }
  // Password policy (≥10 chars, no common/sequenced/repeated patterns).
  const pol = require('../middleware/security').validatePassword(password)
  if (!pol.ok) throw new AppError(400, pol.reason, 'WEAK_PASSWORD')
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (email && !emailRegex.test(email)) {
    throw new AppError(400, 'Please provide a valid email address', 'VALIDATION_ERROR')
  }

  // Check for duplication
  const { data: existingUser, error: checkErr } = await supabaseAdmin
    .from('users')
    .select('id, name, mobile, email')
    .or(`mobile.eq.${mobile}${email ? `,email.eq.${email.trim()}` : ''}`)
    .maybeSingle();

  if (existingUser) {
    if (existingUser.mobile === mobile) throw new AppError(400, `Mobile ${mobile} is already registered with ${existingUser.name}`, 'DUPLICATE_ERROR');
    if (email && existingUser.email?.toLowerCase() === email.toLowerCase().trim()) throw new AppError(400, `Email ${email} is already registered with ${existingUser.name}`, 'DUPLICATE_ERROR');
  }

  const authEmail = email?.trim() || `${mobile}@kinematic.app`

  // 1. Create Supabase Auth user
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true,
    user_metadata: { name, mobile, role: role || 'executive' },
  })

  if (authErr) {
    const msg = authErr.message.toLowerCase().includes('already')
      ? `Mobile ${mobile} is already registered`
      : authErr.message
    throw new AppError(400, msg, 'AUTH_ERROR')
  }

  const authId = authData.user.id

    // Stamp the new user with the correct tenant. Priority:
    //   1. Explicit client_id in the request body (e.g. bulk import API).
    //   2. X-Client-Id header — the global picker set by dashboard api.ts.
    //      Without this, a platform admin browsing "Tata Tiscon" would
    //      create users with client_id=null and they'd never show up in
    //      that client's scoped lists.
    //   3. Admin's own client_id (client-pinned admins).
    //   4. null (platform-level user, rare).
    const headerClientId = req.headers['x-client-id'] as string | undefined;
    const pickedClientId =
      isUUID(req.body.client_id as string) ? (req.body.client_id as string)
      : isUUID(headerClientId)              ? headerClientId
      : (admin.client_id || null);

    const userData: any = {
      id:            authId,
      org_id:        admin.org_id,
      client_id:     pickedClientId,
      name:          name.trim(),
      mobile:        mobile.trim(),
      email:         email?.trim() || null,
      role:          role || 'executive',
      // Hierarchy role drives module access via org_roles.permissions; the
      // legacy `role` column above only governs requireRole() route tiers.
      // Both need to be set so the new user inherits the right scope.
      org_role_id:   isUUID(org_role_id as string) ? org_role_id : null,
      zone_id:       zone_id       || null,
      supervisor_id: supervisor_id || null,
      employee_id:   employee_id   || null,
      joined_date:   joined_date   || null,
      city:          city          || null,
      is_active:     true,
    }

    // NOTE: We do NOT set app_password in the users table because the column does not exist.
    // The Supabase Auth password (handled above) IS the app password.

    const { data, error } = await supabaseAdmin.from('users')
      .insert(userData)
      .select('*, zones!zone_id(name)')
      .single()

  const { permissions, assigned_cities } = req.body

  // 4. Save Permissions and City Assignments
  const tasks = [];

  if (Array.isArray(permissions) && permissions.length > 0) {
    tasks.push(
      supabaseAdmin.from('user_module_permissions').insert(
        permissions.map((p: string) => ({
          user_id: authId,
          module_id: p,
          org_id: admin.org_id
        }))
      )
    );
  }

  if (Array.isArray(assigned_cities) && assigned_cities.length > 0) {
    tasks.push(
      supabaseAdmin.from('user_city_assignments').insert(
        assigned_cities.map((c: string) => ({
          user_id: authId,
          city_id: c,
          org_id: admin.org_id
        }))
      )
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  // 5. Privilege escalation check for Sub-Admin
  if (admin.role === 'sub_admin' && permissions) {
    const unauthorized = permissions.filter((p: string) => !admin.permissions?.includes(p))
    if (unauthorized.length > 0) {
      await supabaseAdmin.auth.admin.deleteUser(authId)
      throw new AppError(403, `Cannot assign modules you do not have: ${unauthorized.join(', ')}`, 'FORBIDDEN')
    }
  }

  // 5. Insert permissions if provided
  if (permissions && Array.isArray(permissions)) {
    const pData = permissions.map((p: string) => ({ user_id: authId, module_id: p }))
    await supabaseAdmin.from('user_module_permissions').insert(pData)
  }

  // 6. Insert city assignments if provided
  if (assigned_cities && Array.isArray(assigned_cities)) {
    const cData = assigned_cities.map((c: string) => ({ user_id: authId, city_id: c }))
    await supabaseAdmin.from('user_city_assignments').insert(cData)
  }

  sendSuccess(res, { ...data, permissions: permissions || [], assigned_cities: assigned_cities || [] }, 'User created', 201)
})

export const updateUser = asyncHandler<AuthRequest>(async (req, res) => {
  // `org_role_id` is allowed here so admins can reassign the hierarchy role
  // (and the modules it inherits) without having to delete + recreate. The
  // column exists on `users`; missing it from this list silently dropped
  // every hierarchy change posted from the dashboard.
  const allowed = ['name', 'mobile', 'zone_id', 'supervisor_id', 'is_active', 'employee_id', 'city', 'email', 'avatar_url', 'role', 'client_id', 'org_role_id']
  const updates: any = {}
  for (const key of allowed) { 
    if (req.body[key] !== undefined && req.body[key] !== '') {
      updates[key] = req.body[key] 
    }
  }

  // 1. Mobile Format Validation
  if (updates.mobile && !/^\d{10}$/.test(updates.mobile)) {
    throw new AppError(400, 'Mobile number must be exactly 10 digits', 'VALIDATION_ERROR')
  }
  // 2. Email Validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (updates.email && !emailRegex.test(updates.email)) {
    throw new AppError(400, 'Please provide a valid email address', 'VALIDATION_ERROR')
  }

  // 3. Duplication Check
  if (updates.mobile || updates.email) {
    let orQuery = '';
    if (updates.mobile) orQuery += `mobile.eq.${updates.mobile}`;
    if (updates.email) orQuery += (orQuery ? ',' : '') + `email.eq.${updates.email.trim()}`;

    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id, name, mobile, email')
      .neq('id', req.params.id)
      .or(orQuery)
      .maybeSingle();

    if (existingUser) {
      if (updates.mobile && existingUser.mobile === updates.mobile) throw new AppError(400, `Mobile ${updates.mobile} is already registered with ${existingUser.name}`, 'DUPLICATE_ERROR');
      if (updates.email && existingUser.email?.toLowerCase() === updates.email.toLowerCase().trim()) throw new AppError(400, `Email ${updates.email} is already registered with ${existingUser.name}`, 'DUPLICATE_ERROR');
    }
  }

  // Sync app_password with Supabase Auth if provided
  if (req.body.app_password) {
    const pw = req.body.app_password.trim()
    const pol = require('../middleware/security').validatePassword(pw)
    if (!pol.ok) throw new AppError(400, `App password rejected: ${pol.reason}`, 'WEAK_PASSWORD')

    try {
      const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, { password: pw })
      if (authErr) throw new AppError(400, `Auth password update failed: ${authErr.message}`, 'AUTH_ERROR')
      // NOTE: We do NOT update app_password in the users table because the column does not exist.
      // The Supabase Auth password IS the app password.
    } catch (e: any) {
      if (e instanceof AppError) throw e
      throw new AppError(500, `Auth identity update crashed: ${e.message}`, 'AUTH_CRASH')
    }
  }

  // Only run DB update if there's something to update
  if (Object.keys(updates).length === 0 && !req.body.app_password) {
    return sendSuccess(res, null, 'Nothing to update')
  }

  try {
    let data: any[] | null = null;
    
    if (Object.keys(updates).length > 0) {
      const query = supabaseAdmin.from('users').update(updates).eq('id', req.params.id)
      if (req.user?.role !== 'super_admin' && req.user?.role !== 'admin') {
        query.eq('org_id', req.user!.org_id)
        if (isUUID(req.user?.client_id)) query.eq('client_id', req.user!.client_id)
      }
      const { data: dbData, error } = await query.select()
      if (error) throw new AppError(500, `DB update failed: ${error.message}`, 'DB_ERROR')
      if (!dbData || dbData.length === 0) throw new AppError(404, 'User not found or no permission', 'NOT_FOUND')
      data = dbData;
    } else {
      // If we are here, it means app_password was updated but no profile fields changed
      const { data: userData } = await supabaseAdmin.from('users').select('*').eq('id', req.params.id).single()
      data = [userData];
    }

    const targetUserId = req.params.id
    const { permissions, assigned_cities } = req.body

    // Sync Permissions
    if (permissions && Array.isArray(permissions)) {
      // Privilege escalation check
      if (req.user?.role === 'sub_admin') {
        const unauthorized = permissions.filter((p: string) => !req.user!.permissions?.includes(p))
        if (unauthorized.length > 0) throw new AppError(403, `Cannot assign modules you do not have: ${unauthorized.join(', ')}`, 'FORBIDDEN')
      }
      
      await supabaseAdmin.from('user_module_permissions').delete().eq('user_id', targetUserId)
      if (permissions.length > 0) {
        const pData = permissions.map((p: string) => ({ user_id: targetUserId, module_id: p }))
        await supabaseAdmin.from('user_module_permissions').insert(pData)
      }
    }

    // Sync Cities
    if (assigned_cities && Array.isArray(assigned_cities)) {
      await supabaseAdmin.from('user_city_assignments').delete().eq('user_id', targetUserId)
      if (assigned_cities.length > 0) {
        const cData = assigned_cities.map((c: string) => ({ user_id: targetUserId, city_id: c }))
        await supabaseAdmin.from('user_city_assignments').insert(cData)
      }
    }
    
    sendSuccess(res, { ...data[0], permissions, assigned_cities }, 'User updated')
  } catch (e: any) {
    if (e instanceof AppError) throw e
    throw new AppError(500, `DB update crashed: ${e.message}`, 'DB_CRASH')
  }
})

export const resetUserPassword = asyncHandler<AuthRequest>(async (req, res) => {
  const { password } = req.body
  if (!password || password.length < 6) {
    throw new AppError(400, 'Password must be at least 6 characters', 'VALIDATION_ERROR')
  }
  const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, { password })
  if (authErr) throw new AppError(500, authErr.message, 'AUTH_ERROR')

  sendSuccess(res, { message: 'Password reset successfully' })
})

// ZONES
export const getZones = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockZones());
  
  let query = supabaseAdmin.from('zones')
    .select('*').eq('is_active', true);

  const targetCid = isUUID(req.query.client_id as string) ? (req.query.client_id as string) : user.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', user.org_id);
  }

  if (user.role === 'city_manager' && user.assigned_cities?.length) {
    query = query.in('city', user.assigned_cities);
  }

  const { data, error } = await query.order('name');
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data)
})

export const createZone = asyncHandler<AuthRequest>(async (req, res) => {
  const { name, city, city_id, state, meeting_lat, meeting_lng, meeting_address, geofence_radius } = req.body
  const user = req.user!
  const targetClientId = user.client_id || req.body.client_id || null

  // Check for duplication before insert to provide better error or bypass constraint
  const { data: existing } = await supabaseAdmin.from('zones')
    .select('id')
    .eq('org_id', user.org_id)
    .eq('name', name)
    .filter('client_id', targetClientId ? 'eq' : 'is', targetClientId || null)
    .maybeSingle()

  if (existing) {
    throw new AppError(400, `Zone with name "${name}" already exists.`, 'DUPLICATE_ERROR')
  }

  const { data, error } = await supabaseAdmin.from('zones')
    .insert({ 
      org_id: user.org_id, 
      client_id: targetClientId,
      name, city, city_id, state, 
      meeting_lat: meeting_lat || 0.0, 
      meeting_lng: meeting_lng || 0.0, 
      meeting_address: meeting_address || '', 
      geofence_radius: geofence_radius || 100 
    })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Zone created', 201)
})

export const updateZone = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { name, city, city_id, state, meeting_lat, meeting_lng, meeting_address, geofence_radius, is_active } = req.body;
  
  const updates = { 
    name, city, city_id, state, 
    meeting_lat: meeting_lat != null ? meeting_lat : 0.0, 
    meeting_lng: meeting_lng != null ? meeting_lng : 0.0, 
    meeting_address: meeting_address || '', 
    geofence_radius: geofence_radius || 100,
    is_active,
    updated_at: new Date().toISOString() 
  };
  
  let query = supabaseAdmin.from('zones').update(updates).eq('id', id);
  const targetCid = user.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', user.org_id);
  }
  
  const { data, error } = await query.select().single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Zone not found or no permission', 'NOT_FOUND');
  sendSuccess(res, data, 'Zone updated');
});

export const deleteZone = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { id } = req.params;
  
  let query = supabaseAdmin.from('zones').delete().eq('id', id);
  const targetCid = user.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', user.org_id);
  }
  
  const { error } = await query;
  if (error) {
    if (error.code === '23503') throw new AppError(400, 'Cannot delete zone: users are assigned to it.', 'REFERENTIAL_INTEGRITY');
    throw new AppError(500, error.message, 'DB_ERROR');
  }
  sendSuccess(res, { deleted: true }, 'Zone deleted');
});

// ANALYTICS
export const getDashboardSummary = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!
  const date = (req.query.date as string) || todayDate()
  const targetCid = isUUID(req.query.client_id as string) ? (req.query.client_id as string) : user.client_id;
  const applyFilter = (q: any) => {
    if (targetCid && isUUID(targetCid)) return q.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
    return q.eq('org_id', user.org_id);
  };

  let attQ = applyFilter(supabaseAdmin.from('attendance').select('user_id, status', { count: 'exact' })).eq('date', date)
  let subQ = applyFilter(supabaseAdmin.from('form_submissions').select('id, is_converted', { count: 'exact' })).gte('submitted_at', date + 'T00:00:00+05:30').lte('submitted_at', date + 'T23:59:59+05:30')
  let sosQ = applyFilter(supabaseAdmin.from('sos_alerts').select('id', { count: 'exact', head: true })).eq('status', 'active')

  const [attRes, subRes, sosRes] = await Promise.all([attQ, subQ, sosQ])

  const totalEngagements = subRes.count || 0
  const totalTff = (subRes.data || []).filter((s: any) => s.is_converted).length
  sendSuccess(res, {
    date,
    executives_checked_in: attRes.count || 0,
    executives_active: (attRes.data || []).filter((a: any) => a.status !== 'checked_out').length,
    total_engagements: totalEngagements,
    total_tff: totalTff,
    tff_rate: totalEngagements > 0 ? Math.round((totalTff / totalEngagements) * 100) : 0,
    active_sos_alerts: sosRes.count || 0,
  })
})

export const getActivityFeed = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!
  const targetCid = isUUID(req.query.client_id as string) ? (req.query.client_id as string) : user.client_id;
  const applyFilter = (q: any) => {
    if (targetCid && isUUID(targetCid)) return q.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
    return q.eq('org_id', user.org_id);
  };

  let aQ = applyFilter(supabaseAdmin.from('attendance').select('id, user_id, status, checkin_at, checkout_at, checkin_selfie_url, checkout_selfie_url, users!attendance_user_id_fkey(name, zones(name))'));
  let fQ = applyFilter(supabaseAdmin.from('form_submissions').select('id, user_id, submitted_at, is_converted, outlet_name, users!user_id(name)'));
  let sQ = applyFilter(supabaseAdmin.from('sos_alerts').select('id, user_id, created_at, status, users!user_id(name)'));

  const [attRes, subRes, sosRes] = await Promise.all([
    aQ.order('checkin_at', { ascending: false }).limit(10),
    fQ.order('submitted_at', { ascending: false }).limit(10),
    sQ.order('created_at', { ascending: false }).limit(5),
  ]);
  const feed = [
    ...(attRes.data || []).map((a: any) => ({ 
      type: 'attendance', 
      event: a.status === 'checked_in' || a.status === 'on-break' ? 'Check-in' : 'Check-out', 
      user: a.users?.name, 
      zone: a.users?.zones?.name, 
      time: a.status === 'checked_out' ? a.checkout_at : a.checkin_at, 
      id: a.id,
      photo_url: a.status === 'checked_out' ? a.checkout_selfie_url : a.checkin_selfie_url
    })),
    ...(subRes.data || []).map((s: any) => ({ type: 'form', event: 'Form submitted' + (s.is_converted ? ' ✓ TFF' : ''), user: s.users?.name, outlet: s.outlet_name, time: s.submitted_at, id: s.id })),
    ...(sosRes.data || []).map((s: any) => ({ type: 'sos', event: 'SOS Alert', user: s.users?.name, status: s.status, time: s.created_at, id: s.id })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 20)
  sendSuccess(res, feed)
})

export const createSOS = asyncHandler<AuthRequest>(async (req, res) => {
  const { latitude, longitude, remarks } = req.body
  const user = req.user!
  
  const { data, error } = await supabaseAdmin.from('sos_alerts')
    .insert({
      org_id: user.org_id,
      client_id: user.client_id,
      user_id: user.id,
      latitude,
      longitude,
      remarks: remarks || 'Emergency SOS triggered from app',
      status: 'active'
    })
    .select().single()

  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  
  // Note: In a real app, we'd trigger push notifications/SMS to supervisors here
  
  sendSuccess(res, data, 'SOS Alert sent to supervisors', 201)
})

export const resolveSOS = asyncHandler<AuthRequest>(async (req, res) => {
  const { resolution } = req.body
  let query = supabaseAdmin.from('sos_alerts')
    .update({ 
      status: 'resolved', 
      resolution: resolution || 'Resolved by admin',
      resolved_at: new Date().toISOString(),
      resolved_by: req.user!.id
    })
    .eq('id', req.params.id);

  const targetCid = req.user!.client_id;
  if (targetCid && isUUID(targetCid)) {
    query = query.or(`client_id.eq.${targetCid},org_id.eq.${targetCid}`);
  } else {
    query = query.eq('org_id', req.user!.org_id);
  }
  const { data, error } = await query.select().single()

  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'SOS Alert resolved')
})

// CLIENTS
// Tenants opted out of continuous live-location tracking — pings from
// these clients are silently no-op'd so reps don't see errors but the
// device's battery isn't hit by background GPS. Tata Tiscon flagged
// battery-drain complaints; their reps use one-shot lead-create geo
// capture instead. New tenants can be added here without a schema
// change; longer-term move this to clients.settings.disable_live_tracking.
const LIVE_TRACKING_DISABLED_CLIENT_IDS = new Set<string>([
  'a1f67468-526e-4734-be3a-2cb132cc2804', // Tata Tiscon
]);

export const updateUserStatus = asyncHandler<AuthRequest>(async (req, res) => {
  const { latitude, longitude, battery_percentage, battery, activity_type, device_model, device_brand, os_version } = req.body;
  const user = req.user!;

  // Defence-in-depth kill switch — even if a stale build keeps pinging,
  // we don't persist the row. 204 (no content) so the client stops
  // retrying. App-side gating in iOS + Android stops the pings at the
  // source.
  if (user.client_id && LIVE_TRACKING_DISABLED_CLIENT_IDS.has(user.client_id)) {
    res.status(204).end();
    return;
  }

  // Bug Fix: 0.0 is a valid coordinate but falsy in JS.
  if (latitude === undefined || longitude === undefined) {
    throw new AppError(400, 'Latitude and longitude are required', 'VALIDATION_ERROR');
  }

  const now = new Date().toISOString();
  // Bug Fix: 0% battery is valid.
  const batteryLevel = battery !== undefined ? battery : (battery_percentage !== undefined ? battery_percentage : null);
  
  // 1. Run User Update and Attendance fetch concurrently
  const today = now.split('T')[0];
  
  const [userUpdate, attResult] = await Promise.all([
    supabaseAdmin
      .from('users')
      .update({
        last_latitude: latitude,
        last_longitude: longitude,
        battery_percentage: batteryLevel,
        device_model: device_model || undefined,
        device_brand: device_brand || undefined,
        os_version: os_version || undefined,
        last_location_updated_at: now
      })
      .eq('id', user.id),

    supabaseAdmin
      .from('attendance')
      .select('id')
      .eq('user_id', user.id)
      .eq('date', today)
      .maybeSingle()
  ]);

  if (userUpdate.error) throw new AppError(500, userUpdate.error.message, 'DB_ERROR');
  const att = attResult.data;

  // 2. Insert into work_activity for history tracking
  await supabaseAdmin.from('work_activity').insert({
    org_id: user.org_id,
    client_id: user.client_id,
    user_id: user.id,
    attendance_id: att?.id || null,
    activity_type: activity_type || 'HEARTBEAT',
    lat: latitude,
    lng: longitude,
    battery_percentage: batteryLevel,
    device_model: device_model || null,
    device_brand: device_brand || null,
    os_version: os_version || null,
    captured_at: now
  });

  sendSuccess(res, null, 'Status updated');
});

// CLIENTS
export const getClients = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!

  let query = supabaseAdmin.from('clients')
    .select('id, name')
    .eq('is_active', true)
    .order('name')

  // Platform admins and management roles can see all client names for dashboard attribution
  const isManagement = ['admin', 'super_admin', 'main_admin', 'sub_admin', 'platform_admin', 'hr', 'city_manager', 'supervisor'].includes(user.role?.toLowerCase())
  if (!isManagement) {
    query = query.eq('org_id', user.org_id)
  }

  const { data, error } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data)
})

// MOTIVATION QUOTES
export const getDailyQuote = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!
  // Fetch the most recent quote for the organization
  let data = null
  try {
    const { data: quoteData, error } = await supabaseAdmin.from('motivation_quotes')
      .select('quote, author')
      .eq('org_id', user.org_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    
    if (!error) data = quoteData
  } catch (e) {
    console.error('[Fallback] Motivation quotes table check failed')
  }

  // Fallback if no quote exists or table is missing
  const fallback = { quote: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" }
  sendSuccess(res, data || fallback)
})

export const upsertQuote = asyncHandler<AuthRequest>(async (req, res) => {
  const { quote, author } = req.body
  const user = req.user!
  
  if (!quote) throw new AppError(400, 'Quote content is required', 'VALIDATION_ERROR')

  const { data, error } = await supabaseAdmin.from('motivation_quotes')
    .insert({ org_id: user.org_id, quote, author: author || 'Anonymous', created_by: user.id })
    .select().single()

  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Quote updated successfully', 201)
})

// SECURITY ALERTS

// Validator. Apps post here every time their pre-flight detector
// trips; the schema is intentionally tight so a compromised client
// can't seed arbitrary `type` values into the dashboard's filter chips
// or push fake metadata through to the notification body.
const securityAlertSchema = z.object({
  type: z.enum(['MOCK_LOCATION', 'VPN_DETECTED']),
  action: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  metadata: z.record(z.any()).optional(),
});

export const logSecurityAlert = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = securityAlertSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'Validation failed', 'VALIDATION_ERROR');
  }
  const { type, action, lat, lng, metadata } = parsed.data;

  const { data, error } = await supabaseAdmin.from('security_alerts')
    .insert({
      org_id: user.org_id,
      client_id: user.client_id,
      user_id: user.id,
      type,
      action,
      lat: lat ?? null,
      lng: lng ?? null,
      metadata: metadata ?? {},
    })
    .select()
    .single();

  if (error) {
    throw new AppError(500, `Failed to log alert: ${error.message}`, 'DB_ERROR');
  }

  // Manager notification fan-out. Mirrors the SOS controller's pattern:
  // (1) start with the rep's direct supervisor, (2) add every
  // city_manager / admin / sub_admin / main_admin in the same org as
  // a safety net so an absent line manager doesn't leave a violation
  // unseen. Notifications go into the `notifications` table; the
  // dispatch cron picks them up and pushes via FCM/APNs.
  // Best-effort: a failure here MUST NOT break the alert insert —
  // the audit row is the source of truth, the notification is just
  // the courtesy ping.
  try {
    const usersToNotify: string[] = [];
    if ((user as any).supervisor_id) usersToNotify.push((user as any).supervisor_id);

    const { data: managers } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('org_id', user.org_id)
      .in('role', ['city_manager', 'admin', 'sub_admin', 'main_admin']);

    (managers || []).forEach((m: { id: string }) => {
      if (m.id !== user.id && !usersToNotify.includes(m.id)) usersToNotify.push(m.id);
    });

    if (usersToNotify.length) {
      const friendly = type === 'VPN_DETECTED' ? 'VPN connection' : 'mock GPS location';
      const repName = (user as any).name || 'A field executive';
      const notifInserts = usersToNotify.map((uid) => ({
        org_id: user.org_id,
        user_id: uid,
        type: 'security_alert' as const,
        title: `Security alert — ${repName}`,
        body: `${repName} attempted ${action} with ${friendly} detected. The action was blocked on-device.`,
        data: {
          alert_id: data.id,
          exec_id: user.id,
          exec_name: repName,
          violation: type,
          action,
          lat: lat ?? null,
          lng: lng ?? null,
        },
      }));
      await supabaseAdmin.from('notifications').insert(notifInserts);
    }

    logger.warn(`SECURITY ALERT — User: ${(user as any).name} (${user.id}), Type: ${type}, Action: ${action}`);
  } catch (notifyErr) {
    logger.warn(`[security_alert] notify fan-out failed: ${(notifyErr as Error).message}`);
  }

  sendSuccess(res, data, 'Alert logged', 201);
});


export const getSecurityAlerts = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!
  
  const { page, limit, offset } = getPagination(
    parseInt(req.query.page as string) || 1,
    parseInt(req.query.limit as string) || 20
  )

  let query = supabaseAdmin.from('security_alerts')
    .select('*, user:user_id(id, name, employee_id, role, zone_id, zones(name))', { count: 'exact' })
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false })

  if (isUUID(user.client_id)) query = query.eq('client_id', user.client_id)

  const { data, error, count } = await query.range(offset, offset + limit - 1)
  sendPaginated(res, data || [], count || 0, page, limit)
})


export const nukeTestData = asyncHandler<AuthRequest>(async (req, res) => {
  const { user_name = 'Test FE' } = req.body;
  logger.info(`🛡️ [DEBUG] Nuke initiated for user: ${user_name}`);

  // 1. Find User
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .ilike('name', `%${user_name}%`)
    .maybeSingle();

  if (userErr || !user) {
    throw new AppError(404, `User matching "${user_name}" not found`, 'USER_NOT_FOUND');
  }

  const userId = user.id;
  const stats: Record<string, number> = {};

  // --- FORMS ---
  const { data: subs } = await supabaseAdmin.from('form_submissions').select('id').eq('user_id', userId);
  const subIds = (subs || []).map(s => s.id);
  if (subIds.length > 0) {
    const { count: respCount } = await supabaseAdmin.from('form_responses').delete({ count: 'exact' }).in('submission_id', subIds);
    const { count: subCount } = await supabaseAdmin.from('form_submissions').delete({ count: 'exact' }).eq('user_id', userId);
    stats.form_responses = respCount || 0;
    stats.form_submissions = subCount || 0;
  }

  // --- ATTENDANCE ---
  const { count: attCount } = await supabaseAdmin.from('attendance').delete({ count: 'exact' }).eq('user_id', userId);
  stats.attendance = attCount || 0;

  // --- ROUTE PLANS ---
  const { data: routes } = await supabaseAdmin.from('route_plans').select('id').eq('user_id', userId);
  const routeIds = (routes || []).map(r => r.id);
  if (routeIds.length > 0) {
    const { count: actCount } = await supabaseAdmin.from('route_activities').delete({ count: 'exact' }).in('plan_id', routeIds);
    const { count: outCount } = await supabaseAdmin.from('route_outlets').delete({ count: 'exact' }).in('plan_id', routeIds);
    const { count: planCount } = await supabaseAdmin.from('route_plans').delete({ count: 'exact' }).eq('user_id', userId);
    stats.route_activities = actCount || 0;
    stats.route_outlets = outCount || 0;
    stats.route_plans = planCount || 0;
  }

  // --- VISIT LOGS ---
  const { count: visitCount } = await supabaseAdmin.from('visit_logs').delete({ count: 'exact' }).or(`user_id.eq.${userId},executive_id.eq.${userId}`);
  stats.visit_logs = visitCount || 0;

  // --- FEEDBACK & ALERTS ---
  const { count: sosCount } = await supabaseAdmin.from('sos_alerts').delete({ count: 'exact' }).eq('user_id', userId);
  const { count: gCount } = await supabaseAdmin.from('grievances').delete({ count: 'exact' }).eq('user_id', userId);
  const { count: bCount } = await supabaseAdmin.from('broadcast_answers').delete({ count: 'exact' }).eq('user_id', userId);
  stats.sos_alerts = sosCount || 0;
  stats.grievances = gCount || 0;
  stats.broadcast_answers = bCount || 0;

  // --- TRACKING & LOGS ---
  await supabaseAdmin.from('user_activity_logs').delete().eq('user_id', userId);
  await supabaseAdmin.from('user_status_history').delete().eq('user_id', userId);
  await supabaseAdmin.from('notifications').delete().eq('user_id', userId);

  sendSuccess(res, { user_id: userId, user_name: user.name, stats }, 'Data Nuke Complete');
});

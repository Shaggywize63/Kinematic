import { Request, Response } from 'express'
import { supabaseAdmin } from '../lib/supabase'
import { asyncHandler, sendSuccess, sendPaginated, getPagination, AppError, todayDate } from '../utils'

// VISIT LOGS
export const getVisitLogs = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!
  const date = (req.query.date as string) || todayDate()
  let query = supabaseAdmin
    .from('visit_logs')
    .select('*, visitor:visitor_id(id, name, role), executive:executive_id(id, name, zone_id, zones(name))')
    .eq('org_id', user.org_id).eq('date', date)
    .order('visited_at', { ascending: false })
  if (['executive', 'field_executive', 'field-executive'].includes(user.role)) query = query.eq('executive_id', user.id)
  if (['supervisor', 'city_manager', 'program_manager'].includes(user.role)) query = query.eq('visitor_id', user.id)
  const { data, error } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data)
})

export const createVisitLog = asyncHandler(async (req: Request, res: Response) => {
  const { executive_id, rating, remarks, photo_url, latitude, longitude } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('visit_logs')
    .insert({ org_id: user.org_id, executive_id: executive_id || user.id, visitor_id: user.id, zone_id: user.zone_id, date: todayDate(), visited_at: new Date().toISOString(), rating, remarks: remarks || null, photo_url: photo_url || null, latitude: latitude || null, longitude: longitude || null })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Visit logged', 201)
})

// GRIEVANCES
export const submitGrievance = asyncHandler(async (req: Request, res: Response) => {
  const { category, against_role, incident_date, description, is_anonymous } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('grievances')
    .insert({ org_id: user.org_id, submitted_by: user.id, category, against_role: against_role || null, incident_date: incident_date || null, description, is_anonymous: is_anonymous || false, status: 'submitted' })
    .select('id, reference_no, status, created_at').single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Grievance submitted. HR will review within 48 hours.', 201)
})

export const getMyGrievances = asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin.from('grievances')
    .select('id, reference_no, category, status, created_at, resolution')
    .eq('submitted_by', req.user!.id).eq('is_anonymous', false)
    .order('created_at', { ascending: false })
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data)
})

export const getAllGrievances = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!
  const { status } = req.query
  const { page, limit, offset } = getPagination(
    parseInt(req.query.page as string) || 1,
    parseInt(req.query.limit as string) || 20
  )
  let query = supabaseAdmin.from('grievances')
    .select('*, submitted_by_user:submitted_by(id, name, zone_id)', { count: 'exact' })
    .eq('org_id', user.org_id).order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (status) query = query.eq('status', status as string)
  const { data, error, count } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendPaginated(res, data || [], count || 0, page, limit)
})

export const updateGrievance = asyncHandler(async (req: Request, res: Response) => {
  const { status, resolution } = req.body
  const { data, error } = await supabaseAdmin.from('grievances')
    .update({ status, resolution: resolution || null, reviewed_by: req.user!.id, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', req.user!.org_id).select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Grievance updated')
})

// LEARNING CENTER
export const getMaterials = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('learning_materials')
    .select('*, learning_progress(is_completed, progress_pct, completed_at, last_accessed)')
    .eq('org_id', user.org_id).eq('is_active', true).contains('target_roles', [user.role])
    .order('published_at', { ascending: false })
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  const enriched = (data || []).map((m: any) => ({ ...m, my_progress: m.learning_progress?.[0] || null, learning_progress: undefined }))
  sendSuccess(res, enriched)
})

export const updateProgress = asyncHandler(async (req: Request, res: Response) => {
  const { progress_pct, is_completed } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('learning_progress')
    .upsert({ material_id: req.params.id, user_id: user.id, org_id: user.org_id, progress_pct: progress_pct || 0, is_completed: is_completed || false, completed_at: is_completed ? new Date().toISOString() : null, last_accessed: new Date().toISOString() }, { onConflict: 'material_id,user_id' })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Progress updated')
})

export const createMaterial = asyncHandler(async (req: Request, res: Response) => {
  const { title, description, category, type, file_url, thumbnail_url, duration_min, page_count, target_roles, is_mandatory } = req.body
  const user = req.user!
  const { data, error } = await supabaseAdmin.from('learning_materials')
    .insert({ org_id: user.org_id, title, description: description || null, category: category || null, type, file_url, thumbnail_url: thumbnail_url || null, duration_min: duration_min || null, page_count: page_count || null, target_roles: target_roles || ['executive'], is_mandatory: is_mandatory || false, created_by: user.id, published_at: new Date().toISOString() })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Material created', 201)
})

// NOTIFICATIONS
export const getNotifications = asyncHandler(async (req: Request, res: Response) => {
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

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const { ids } = req.body
  let query = supabaseAdmin.from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() }).eq('user_id', req.user!.id)
  if (ids && ids !== 'all') query = query.in('id', ids)
  const { error } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, null, 'Marked as read')
})

// USERS
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!
  const { role, zone_id, is_active } = req.query
  const { page, limit, offset } = getPagination(
    parseInt(req.query.page as string) || 1,
    parseInt(req.query.limit as string) || 20
  )
  let query = supabaseAdmin.from('users')
    .select('id, name, mobile, email, role, employee_id, zone_id, city, supervisor_id, is_active, joined_date, app_password, zones(name)', { count: 'exact' })
    .eq('org_id', user.org_id).order('name').range(offset, offset + limit - 1)
  if (role) query = query.eq('role', role as string)
  if (zone_id) query = query.eq('zone_id', zone_id as string)
  if (is_active !== undefined) query = query.eq('is_active', is_active === 'true')
  if (['supervisor', 'city_manager', 'program_manager'].includes(user.role)) query = query.eq('supervisor_id', user.id)
  const { data, error, count } = await query
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendPaginated(res, data || [], count || 0, page, limit)
})

export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin.from('users')
    .select('*, zones(name)')
    .eq('id', req.params.id).eq('org_id', req.user!.org_id).single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  if (!data) throw new AppError(404, 'User not found', 'NOT_FOUND')
  sendSuccess(res, data)
})

export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const { name, mobile, password, app_password, role, zone_id, supervisor_id, employee_id, joined_date, city, email } = req.body
  const admin = req.user!

  // Validate required fields
  if (!name || !mobile || !password) {
    throw new AppError(400, 'name, mobile and password are required', 'VALIDATION_ERROR')
  }
  if (!/^\d{10}$/.test(mobile)) {
    throw new AppError(400, 'mobile must be exactly 10 digits', 'VALIDATION_ERROR')
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

  // 2. Insert into public.users
  const { data, error } = await supabaseAdmin.from('users')
    .insert({
      id:            authId,
      org_id:        admin.org_id,
      name:          name.trim(),
      mobile:        mobile.trim(),
      email:         email?.trim() || null,
      role:          role || 'executive',
      zone_id:       zone_id       || null,
      supervisor_id: supervisor_id || null,
      employee_id:   employee_id   || null,
      joined_date:   joined_date   || null,
      city:          city          || null,
      app_password:  app_password  || password || null,
      is_active:     true,
    })
    .select('*, zones(name)')
    .single()

  if (error) {
    // Rollback: delete the auth user we just created
    await supabaseAdmin.auth.admin.deleteUser(authId)
    // Friendly message for duplicate mobile in public.users
    const msg = error.message.toLowerCase().includes('unique')
      ? `Mobile ${mobile} is already in use`
      : error.message
    throw new AppError(500, msg, 'DB_ERROR')
  }

  sendSuccess(res, data, 'User created', 201)
})

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const allowed = ['name', 'zone_id', 'supervisor_id', 'is_active', 'employee_id', 'city', 'email', 'avatar_url', 'role', 'app_password']
  const updates: any = {}
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key] }

  // Sync app_password with Supabase Auth if provided
  if (req.body.app_password) {
    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, { password: req.body.app_password })
    if (authErr) throw new AppError(400, authErr.message, 'AUTH_ERROR')
  }

  const { data, error } = await supabaseAdmin.from('users')
    .update(updates).eq('id', req.params.id).eq('org_id', req.user!.org_id).select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'User updated')
})

export const resetUserPassword = asyncHandler(async (req: Request, res: Response) => {
  const { password } = req.body
  if (!password || password.length < 6) {
    throw new AppError(400, 'Password must be at least 6 characters', 'VALIDATION_ERROR')
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, { password })
  if (error) throw new AppError(500, error.message, 'AUTH_ERROR')
  sendSuccess(res, { message: 'Password reset successfully' })
})

// ZONES
export const getZones = asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin.from('zones')
    .select('*').eq('org_id', req.user!.org_id).eq('is_active', true).order('name')
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data)
})

export const createZone = asyncHandler(async (req: Request, res: Response) => {
  const { name, city, meeting_lat, meeting_lng, meeting_address, geofence_radius } = req.body
  const { data, error } = await supabaseAdmin.from('zones')
    .insert({ org_id: req.user!.org_id, name, city, meeting_lat, meeting_lng, meeting_address, geofence_radius: geofence_radius || 100 })
    .select().single()
  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Zone created', 201)
})

// ANALYTICS
export const getDashboardSummary = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!
  const date = (req.query.date as string) || todayDate()
  const [attRes, subRes, sosRes] = await Promise.all([
    supabaseAdmin.from('attendance').select('user_id, status', { count: 'exact' }).eq('org_id', user.org_id).eq('date', date),
    supabaseAdmin.from('form_submissions').select('id, is_converted', { count: 'exact' }).eq('org_id', user.org_id).gte('submitted_at', date + 'T00:00:00').lte('submitted_at', date + 'T23:59:59'),
    supabaseAdmin.from('sos_alerts').select('id', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('status', 'active'),
  ])
  const totalEngagements = subRes.count || 0
  const totalConversions = (subRes.data || []).filter((s: any) => s.is_converted).length
  sendSuccess(res, {
    date,
    executives_checked_in: attRes.count || 0,
    executives_active: (attRes.data || []).filter((a: any) => a.status !== 'checked_out').length,
    total_engagements: totalEngagements,
    total_conversions: totalConversions,
    conversion_rate: totalEngagements > 0 ? Math.round((totalConversions / totalEngagements) * 100) : 0,
    active_sos_alerts: sosRes.count || 0,
  })
})

export const getActivityFeed = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!
  const [attRes, subRes, sosRes] = await Promise.all([
    supabaseAdmin.from('attendance').select('id, user_id, status, checkin_at, users(name, zones(name))').eq('org_id', user.org_id).order('checkin_at', { ascending: false }).limit(10),
    supabaseAdmin.from('form_submissions').select('id, user_id, submitted_at, is_converted, outlet_name, users(name)').eq('org_id', user.org_id).order('submitted_at', { ascending: false }).limit(10),
    supabaseAdmin.from('sos_alerts').select('id, user_id, created_at, status, users(name)').eq('org_id', user.org_id).order('created_at', { ascending: false }).limit(5),
  ])
  const feed = [
    ...(attRes.data || []).map((a: any) => ({ type: 'attendance', event: a.status === 'checked_in' ? 'Check-in' : 'Check-out', user: a.users?.name, zone: a.users?.zones?.name, time: a.checkin_at, id: a.id })),
    ...(subRes.data || []).map((s: any) => ({ type: 'form', event: 'Form submitted' + (s.is_converted ? ' ✓' : ''), user: s.users?.name, outlet: s.outlet_name, time: s.submitted_at, id: s.id })),
    ...(sosRes.data || []).map((s: any) => ({ type: 'sos', event: 'SOS Alert', user: s.users?.name, status: s.status, time: s.created_at, id: s.id })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 20)
  sendSuccess(res, feed)
})

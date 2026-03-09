// ── Add these two routes in src/app.ts (or wherever attendance routes are mounted) ──
// Place them alongside the existing attendance routes:

// POST /api/v1/attendance/override      — create manual record
// PATCH /api/v1/attendance/:id/override — update existing record

// ─────────────────────────────────────────────────────────────────────────────
// In your attendance.controller.ts (or misc.controller.ts), add:
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response } from 'express'
import { supabaseAdmin } from '../lib/supabase'
import { asyncHandler, sendSuccess, AppError, todayDate } from '../utils'

// CREATE — admin manually sets attendance for an executive
export const overrideAttendance = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user!
  const { user_id, date, status, checkin_at, checkout_at, override_reason } = req.body

  if (!user_id || !date || !status) {
    throw new AppError(400, 'user_id, date and status are required', 'VALIDATION_ERROR')
  }
  if (!override_reason?.trim()) {
    throw new AppError(400, 'override_reason is required for manual attendance', 'VALIDATION_ERROR')
  }

  // Calculate total_hours if both times provided
  let total_hours: number | null = null
  if (checkin_at && checkout_at) {
    const diff = (new Date(checkout_at).getTime() - new Date(checkin_at).getTime()) / 3600000
    total_hours = Math.max(0, parseFloat(diff.toFixed(2)))
  }

  // Upsert — update if record exists for that user+date, insert if not
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .upsert({
      org_id:          admin.org_id,
      user_id,
      date,
      status,
      checkin_at:      checkin_at  || null,
      checkout_at:     checkout_at || null,
      total_hours,
      override_reason: override_reason.trim(),
      override_by:     admin.id,
      checkin_verified: false,
    }, { onConflict: 'user_id,date' })
    .select('*, users(name, employee_id, zones(name))')
    .single()

  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Attendance record saved', 201)
})

// UPDATE — edit an existing attendance record
export const updateAttendanceOverride = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user!
  const { status, checkin_at, checkout_at, override_reason } = req.body

  if (!override_reason?.trim()) {
    throw new AppError(400, 'override_reason is required', 'VALIDATION_ERROR')
  }

  // Fetch the existing record to get the date
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('attendance')
    .select('date, checkin_at, checkout_at')
    .eq('id', req.params.id)
    .eq('org_id', admin.org_id)
    .single()

  if (fetchErr || !existing) throw new AppError(404, 'Attendance record not found', 'NOT_FOUND')

  const newCheckin  = checkin_at  || existing.checkin_at
  const newCheckout = checkout_at || existing.checkout_at

  let total_hours: number | null = null
  if (newCheckin && newCheckout) {
    const diff = (new Date(newCheckout).getTime() - new Date(newCheckin).getTime()) / 3600000
    total_hours = Math.max(0, parseFloat(diff.toFixed(2)))
  }

  const updates: any = {
    override_reason: override_reason.trim(),
    override_by:     admin.id,
  }
  if (status)      updates.status      = status
  if (checkin_at)  updates.checkin_at  = checkin_at
  if (checkout_at) updates.checkout_at = checkout_at
  if (total_hours !== null) updates.total_hours = total_hours

  const { data, error } = await supabaseAdmin
    .from('attendance')
    .update(updates)
    .eq('id', req.params.id)
    .eq('org_id', admin.org_id)
    .select('*, users(name, employee_id, zones(name))')
    .single()

  if (error) throw new AppError(500, error.message, 'DB_ERROR')
  sendSuccess(res, data, 'Attendance updated')
})
export { overrideAttendance, updateAttendanceOverride }

// ─────────────────────────────────────────────────────────────────────────────
// Then in src/app.ts add these two lines near the other attendance routes:
// ─────────────────────────────────────────────────────────────────────────────

// import * as attendanceCtrl from './controllers/attendance.controller'  // already imported

// app.post(`${V1}/attendance/override`,      requireAuth, requireRole('admin','city_manager','super_admin'), attendanceCtrl.overrideAttendance)
// app.patch(`${V1}/attendance/:id/override`, requireAuth, requireRole('admin','city_manager','super_admin'), attendanceCtrl.updateAttendanceOverride)

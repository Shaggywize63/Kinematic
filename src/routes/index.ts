import { Router } from 'express'
import { z } from 'zod'

import { requireAuth, requireRole } from '../middleware/auth'
import { validate } from '../middleware/validate'

import * as authCtrl        from '../controllers/auth.controller'
import * as attendanceCtrl  from '../controllers/attendance.controller'
import * as formsCtrl       from '../controllers/forms.controller'
import * as stockCtrl       from '../controllers/stock.controller'
import * as broadcastCtrl   from '../controllers/broadcast.controller'
import * as sosCtrl         from '../controllers/sos.controller'
import * as leaderCtrl      from '../controllers/leaderboard.controller'
import * as misc            from '../controllers/misc.controller'

const router = Router()

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
router.post('/auth/login',      validate(z.object({ mobile: z.string().min(10), password: z.string().min(6), fcm_token: z.string().optional(), device_id: z.string().optional() })), authCtrl.login)
router.post('/auth/refresh',    authCtrl.refreshToken)
router.post('/auth/logout',     requireAuth, authCtrl.logout)
router.get ('/auth/me',         requireAuth, authCtrl.getMe)
router.patch('/auth/fcm-token', requireAuth, validate(z.object({ fcm_token: z.string() })), authCtrl.updateFcmToken)

// ─────────────────────────────────────────────────────────────
// ATTENDANCE
// ─────────────────────────────────────────────────────────────
router.post('/attendance/checkin',    requireAuth, validate(z.object({ latitude: z.number(), longitude: z.number(), selfie_url: z.string().optional(), activity_id: z.string().uuid().optional(), address: z.string().optional() })), attendanceCtrl.checkin)
router.post('/attendance/checkout',   requireAuth, validate(z.object({ latitude: z.number(), longitude: z.number(), selfie_url: z.string().optional() })), attendanceCtrl.checkout)
router.post('/attendance/break/start',requireAuth, attendanceCtrl.startBreak)
router.post('/attendance/break/end',  requireAuth, attendanceCtrl.endBreak)
router.get ('/attendance/today',      requireAuth, attendanceCtrl.getToday)
router.get ('/attendance/history',    requireAuth, attendanceCtrl.getHistory)
router.get ('/attendance/team',       requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), attendanceCtrl.getTeam)

// ─────────────────────────────────────────────────────────────
// FORMS
// ─────────────────────────────────────────────────────────────
router.get ('/forms/templates',           requireAuth, formsCtrl.getTemplates)
router.get ('/forms/templates/:id',       requireAuth, formsCtrl.getTemplate)
router.post('/forms/templates',           requireAuth, requireRole('admin','city_manager','super_admin'), formsCtrl.createTemplate)
router.post('/forms/templates/:id/fields',requireAuth, requireRole('admin','city_manager','super_admin'), formsCtrl.addField)
router.post('/forms/submit',              requireAuth, formsCtrl.submitForm)
router.get ('/forms/submissions',         requireAuth, formsCtrl.getMySubmissions)
router.get ('/forms/submissions/:id',     requireAuth, formsCtrl.getSubmission)
router.get ('/admin/submissions',         requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), formsCtrl.getAllSubmissions)

// ─────────────────────────────────────────────────────────────
// STOCK
// ─────────────────────────────────────────────────────────────
router.get ('/stock/my',                requireAuth, stockCtrl.getMyAllocation)
router.patch('/stock/items/:id',        requireAuth, validate(z.object({ status: z.enum(['accepted','rejected','partially_accepted']), rejection_reason: z.string().optional(), quantity_accepted: z.number().optional() })), stockCtrl.updateItem)
router.post('/stock/allocations',       requireAuth, requireRole('admin','city_manager','super_admin'), stockCtrl.createAllocation)
router.get ('/stock/allocations',       requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), stockCtrl.getAllAllocations)

// ─────────────────────────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────────────────────────
router.get ('/broadcast',               requireAuth, broadcastCtrl.getQuestions)
router.post('/broadcast',               requireAuth, requireRole('admin','city_manager','super_admin'), broadcastCtrl.createQuestion)
router.post('/broadcast/answer',        requireAuth, validate(z.object({ question_id: z.string().uuid(), selected: z.number().int().min(0) })), broadcastCtrl.submitAnswer)
router.get ('/broadcast/:id/responses', requireAuth, requireRole('admin','city_manager','super_admin'), broadcastCtrl.getResponses)
router.patch('/broadcast/:id/close',    requireAuth, requireRole('admin','city_manager','super_admin'), broadcastCtrl.closeQuestion)

// ─────────────────────────────────────────────────────────────
// SOS
// ─────────────────────────────────────────────────────────────
router.post('/sos/trigger',           requireAuth, validate(z.object({ latitude: z.number(), longitude: z.number(), address: z.string().optional(), message: z.string().optional() })), sosCtrl.triggerSOS)
router.get ('/sos',                   requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), sosCtrl.getAlerts)
router.patch('/sos/:id/acknowledge',  requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), sosCtrl.acknowledgeAlert)
router.patch('/sos/:id/resolve',      requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), sosCtrl.resolveAlert)

// ─────────────────────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────────────────────
router.get ('/leaderboard',           requireAuth, leaderCtrl.getLeaderboard)
router.get ('/leaderboard/my-stats',  requireAuth, leaderCtrl.getMyStats)
router.post('/leaderboard/compute',   requireAuth, requireRole('admin','city_manager','super_admin'), leaderCtrl.computeScores)

// ─────────────────────────────────────────────────────────────
// VISIT LOGS
// ─────────────────────────────────────────────────────────────
router.get ('/visits',   requireAuth, misc.getVisitLogs)
router.post('/visits',   requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), validate(z.object({ executive_id: z.string().uuid().optional(), rating: z.enum(['excellent','good','average','poor']), remarks: z.string().optional(), photo_url: z.string().optional(), latitude: z.number().optional(), longitude: z.number().optional() })), misc.createVisitLog)

// ─────────────────────────────────────────────────────────────
// GRIEVANCES
// ─────────────────────────────────────────────────────────────
router.post('/grievances',        requireAuth, validate(z.object({ category: z.string(), description: z.string().min(10), against_role: z.string().optional(), incident_date: z.string().optional(), is_anonymous: z.boolean().optional() })), misc.submitGrievance)
router.get ('/grievances/mine',   requireAuth, misc.getMyGrievances)
router.get ('/grievances',        requireAuth, requireRole('admin','city_manager','super_admin'), misc.getAllGrievances)
router.patch('/grievances/:id',   requireAuth, requireRole('admin','city_manager','super_admin'), misc.updateGrievance)

// ─────────────────────────────────────────────────────────────
// LEARNING CENTER
// ─────────────────────────────────────────────────────────────
router.get ('/learning',                requireAuth, misc.getMaterials)
router.post('/learning',                requireAuth, requireRole('admin','city_manager','super_admin'), misc.createMaterial)
router.patch('/learning/:id/progress',  requireAuth, validate(z.object({ progress_pct: z.number().min(0).max(100), is_completed: z.boolean().optional() })), misc.updateProgress)

// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
router.get  ('/notifications',       requireAuth, misc.getNotifications)
router.patch('/notifications/read',  requireAuth, misc.markRead)

// ─────────────────────────────────────────────────────────────
// USERS (admin management)
// ─────────────────────────────────────────────────────────────
router.get  ('/users',       requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), misc.getUsers)
router.post ('/users',       requireAuth, requireRole('admin','city_manager','super_admin'), misc.createUser)
router.patch('/users/:id',   requireAuth, requireRole('admin','city_manager','super_admin'), misc.updateUser)

// ─────────────────────────────────────────────────────────────
// ZONES
// ─────────────────────────────────────────────────────────────
router.get ('/zones',   requireAuth, misc.getZones)
router.post('/zones',   requireAuth, requireRole('admin','super_admin'), misc.createZone)

// ─────────────────────────────────────────────────────────────
// ANALYTICS (dashboard)
// ─────────────────────────────────────────────────────────────
router.get('/analytics/summary',       requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), misc.getDashboardSummary)
router.get('/analytics/activity-feed', requireAuth, requireRole('supervisor','city_manager','admin','super_admin'), misc.getActivityFeed)

export default router

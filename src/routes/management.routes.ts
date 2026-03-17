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

import { citiesCtrl, storesCtrl, skusCtrl, assetsCtrl, activitiesCtrl } from '../controllers/management.controller'

import {
  listWarehouses, getWarehouse, createWarehouse, updateWarehouse, deleteWarehouse,
  listMovements, createMovement, updateMovement, deleteMovement, getWmsSummary,
} from '../controllers/wms.controller'

import {
  getSummary, getActivityFeed, getHourly,
  getContactHeatmap, getWeeklyContacts,
  getLiveLocations, getAttendanceToday,
  getOutletCoverage, getCityPerformance,
} from '../controllers/analytics.controller'

const router = Router()

// ───────────────────────── AUTH ─────────────────────────
router.post('/auth/login',
  validate(z.object({
    mobile: z.string().min(10),
    password: z.string().min(6),
    fcm_token: z.string().optional(),
    device_id: z.string().optional()
  })),
  authCtrl.login
)

router.post('/auth/refresh', authCtrl.refreshToken)
router.post('/auth/logout', requireAuth, authCtrl.logout)
router.get('/auth/me', requireAuth, authCtrl.getMe)

router.patch('/auth/fcm-token',
  requireAuth,
  validate(z.object({ fcm_token: z.string() })),
  authCtrl.updateFcmToken
)

// ─────────────────────── ATTENDANCE ───────────────────────
router.post('/attendance/checkin',
  requireAuth,
  validate(z.object({
    latitude: z.number(),
    longitude: z.number(),
    selfie_url: z.string().optional(),
    activity_id: z.string().uuid().optional(),
    address: z.string().optional()
  })),
  attendanceCtrl.checkin
)

router.post('/attendance/checkout',
  requireAuth,
  validate(z.object({
    latitude: z.number(),
    longitude: z.number(),
    selfie_url: z.string().optional()
  })),
  attendanceCtrl.checkout
)

router.post('/attendance/break/start', requireAuth, attendanceCtrl.startBreak)
router.post('/attendance/break/end', requireAuth, attendanceCtrl.endBreak)
router.get('/attendance/today', requireAuth, attendanceCtrl.getToday)
router.get('/attendance/history', requireAuth, attendanceCtrl.getHistory)

router.get('/attendance/team',
  requireAuth,
  requireRole('supervisor','city_manager','admin','super_admin'),
  attendanceCtrl.getTeamToday
)

// ─────────────────────── FORMS ───────────────────────
router.get('/forms/templates', requireAuth, formsCtrl.getTemplates)
router.get('/forms/templates/:id', requireAuth, formsCtrl.getTemplate)

router.post('/forms/templates',
  requireAuth,
  requireRole('admin','city_manager','super_admin'),
  formsCtrl.createTemplate
)

// ─────────────────────── NOTIFICATIONS ───────────────────────
router.get('/notifications', requireAuth, misc.getNotifications)
router.patch('/notifications/read', requireAuth, misc.markRead)

// ─────────────────────── USERS ───────────────────────
router.get('/users',
  requireAuth,
  requireRole('supervisor','city_manager','admin','super_admin'),
  misc.getUsers
)

router.post('/users',
  requireAuth,
  requireRole('admin','city_manager','super_admin'),
  misc.createUser
)

router.patch('/users/:id',
  requireAuth,
  requireRole('admin','city_manager','super_admin'),
  misc.updateUser
)

// ─────────────────────── ANALYTICS ───────────────────────
const adm = requireRole('supervisor','city_manager','admin','super_admin')

router.get('/analytics/summary', requireAuth, adm, getSummary)
router.get('/analytics/activity-feed', requireAuth, adm, getActivityFeed)

// ─────────────────────── CITIES ───────────────────────
router.get('/cities', requireAuth, citiesCtrl.list)
router.get('/cities/:id', requireAuth, citiesCtrl.getOne)

router.post('/cities',
  requireAuth,
  requireRole('admin','super_admin'),
  citiesCtrl.create
)

router.patch('/cities/:id',
  requireAuth,
  requireRole('admin','super_admin'),
  citiesCtrl.update
)

router.delete('/cities/:id',
  requireAuth,
  requireRole('admin','super_admin'),
  citiesCtrl.remove
)

// ─────────────────────── STORES ───────────────────────
router.get('/stores', requireAuth, storesCtrl.list)
router.get('/stores/:id', requireAuth, storesCtrl.getOne)

router.post('/stores',
  requireAuth,
  requireRole('admin','supervisor'),
  storesCtrl.create
)

// ─────────────────────── SKUS ───────────────────────
router.get('/skus', requireAuth, skusCtrl.list)
router.get('/skus/:id', requireAuth, skusCtrl.getOne)

router.post('/skus',
  requireAuth,
  requireRole('admin','super_admin'),
  skusCtrl.create
)

router.patch('/skus/:id',
  requireAuth,
  requireRole('admin','super_admin'),
  skusCtrl.update
)

router.delete('/skus/:id',
  requireAuth,
  requireRole('admin','super_admin'),
  skusCtrl.remove
)

// ─────────────────────── ASSETS ───────────────────────
router.get('/assets', requireAuth, assetsCtrl.list)
router.get('/assets/:id', requireAuth, assetsCtrl.getOne)

// ─────────────────────── ACTIVITIES ───────────────────────
router.get('/activities', requireAuth, activitiesCtrl.list)
router.get('/activities/:id', requireAuth, activitiesCtrl.getOne)

// ─────────────────────── WAREHOUSES ───────────────────────
router.get('/warehouses/summary',
  requireAuth,
  requireRole('admin','super_admin'),
  getWmsSummary
)

router.get('/warehouses', requireAuth, listWarehouses)

export default router

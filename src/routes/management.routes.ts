import { Router } from 'express'
import { z } from 'zod'

import { requireAuth, requireRole } from '../middleware/auth'
import { validate } from '../middleware/validate'

// ✅ FIXED IMPORTS (NO * as)
import {
  login,
  refreshToken,
  logout,
  getMe
} from '../controllers/auth.controller'

import { getToday } from '../controllers/attendance.controller'
import { getUsers } from '../controllers/misc.controller'

import {
  citiesCtrl,
  storesCtrl,
  skusCtrl,
  assetsCtrl,
  activitiesCtrl
} from '../controllers/management.controller'

import {
  listWarehouses,
  getWmsSummary
} from '../controllers/wms.controller'

import {
  getSummary,
  getActivityFeed
} from '../controllers/analytics.controller'

const router = Router()

// ───────────────── AUTH ─────────────────
router.post(
  '/auth/login',
  validate(
    z.object({
      mobile: z.string().min(10),
      password: z.string().min(6),
      fcm_token: z.string().optional(),
      device_id: z.string().optional()
    })
  ),
  login // ✅ FIXED
)

router.post('/auth/refresh', refreshToken)
router.post('/auth/logout', requireAuth, logout)
router.get('/auth/me', requireAuth, getMe)

// ───────────────── ATTENDANCE ─────────────────
router.get('/attendance/today', requireAuth, getToday)

// ───────────────── USERS ─────────────────
router.get(
  '/users',
  requireAuth,
  requireRole('supervisor', 'city_manager', 'admin', 'super_admin'),
  getUsers
)

// ───────────────── ANALYTICS ─────────────────
const adm = requireRole('supervisor', 'city_manager', 'admin', 'super_admin')

router.get('/analytics/summary', requireAuth, adm, getSummary)
router.get('/analytics/activity-feed', requireAuth, adm, getActivityFeed)

// ───────────────── CITIES ─────────────────
router.get('/cities', requireAuth, citiesCtrl.list)
router.get('/cities/:id', requireAuth, citiesCtrl.getOne)

router.post(
  '/cities',
  requireAuth,
  requireRole('admin', 'super_admin'),
  citiesCtrl.create
)

router.patch(
  '/cities/:id',
  requireAuth,
  requireRole('admin', 'super_admin'),
  citiesCtrl.update
)

router.delete(
  '/cities/:id',
  requireAuth,
  requireRole('admin', 'super_admin'),
  citiesCtrl.remove
)

// ───────────────── STORES ─────────────────
router.get('/stores', requireAuth, storesCtrl.list)
router.get('/stores/:id', requireAuth, storesCtrl.getOne)

// ───────────────── SKUS ─────────────────
router.get('/skus', requireAuth, skusCtrl.list)
router.get('/skus/:id', requireAuth, skusCtrl.getOne)

// ───────────────── ASSETS ─────────────────
router.get('/assets', requireAuth, assetsCtrl.list)
router.get('/assets/:id', requireAuth, assetsCtrl.getOne)

// ───────────────── ACTIVITIES ─────────────────
router.get('/activities', requireAuth, activitiesCtrl.list)
router.get('/activities/:id', requireAuth, activitiesCtrl.getOne)

// ───────────────── WAREHOUSES ─────────────────
router.get(
  '/warehouses/summary',
  requireAuth,
  requireRole('admin', 'super_admin'),
  getWmsSummary
)

router.get('/warehouses', requireAuth, listWarehouses)

export default router

import { Router } from 'express'
import { z } from 'zod'

import { requireAuth, requireRole } from '../middleware/auth'
import { validate } from '../middleware/validate'

import * as authCtrl from '../controllers/auth.controller'

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

// AUTH
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
})

router.post('/auth/login', validate(loginSchema), authCtrl.login)
router.post('/auth/refresh', authCtrl.refreshToken)
router.post('/auth/logout', requireAuth, authCtrl.logout)
router.get('/auth/me', requireAuth, authCtrl.getMe)

// ATTENDANCE
router.get('/attendance/today', requireAuth, getToday)

// USERS
router.get(
  '/users',
  requireAuth,
  requireRole('supervisor', 'city_manager', 'admin', 'super_admin'),
  getUsers
)

// ANALYTICS
const adm = requireRole('supervisor', 'city_manager', 'admin', 'super_admin')

router.get('/analytics/summary', requireAuth, adm, getSummary)
router.get('/analytics/activity-feed', requireAuth, adm, getActivityFeed)

// CITIES
router.get('/cities', requireAuth, citiesCtrl.list)
router.get('/cities/:id', requireAuth, citiesCtrl.getOne)

router.post('/cities', requireAuth, requireRole('admin','super_admin'), citiesCtrl.create)
router.patch('/cities/:id', requireAuth, requireRole('admin','super_admin'), citiesCtrl.update)
router.delete('/cities/:id', requireAuth, requireRole('admin','super_admin'), citiesCtrl.remove)

// STORES
router.get('/stores', requireAuth, storesCtrl.list)
router.get('/stores/:id', requireAuth, storesCtrl.getOne)

router.post('/stores', requireAuth, requireRole('admin','supervisor'), storesCtrl.create)
router.patch('/stores/:id', requireAuth, requireRole('admin','supervisor'), storesCtrl.update)
router.delete('/stores/:id', requireAuth, requireRole('admin','super_admin'), storesCtrl.remove)

// SKUS
router.get('/skus', requireAuth, skusCtrl.list)
router.get('/skus/:id', requireAuth, skusCtrl.getOne)

router.post('/skus', requireAuth, requireRole('admin','super_admin'), skusCtrl.create)
router.patch('/skus/:id', requireAuth, requireRole('admin','super_admin'), skusCtrl.update)
router.delete('/skus/:id', requireAuth, requireRole('admin','super_admin'), skusCtrl.remove)

// ASSETS
router.get('/assets', requireAuth, assetsCtrl.list)
router.get('/assets/:id', requireAuth, assetsCtrl.getOne)

router.post('/assets', requireAuth, requireRole('admin','super_admin'), assetsCtrl.create)

// ACTIVITIES
router.get('/activities', requireAuth, activitiesCtrl.list)
router.get('/activities/:id', requireAuth, activitiesCtrl.getOne)

// WAREHOUSES
router.get('/warehouses/summary', requireAuth, requireRole('admin','super_admin'), getWmsSummary)
router.get('/warehouses', requireAuth, listWarehouses)

export default router

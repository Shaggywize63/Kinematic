import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';

// ✅ safer import (prevents undefined destructuring issues)
import * as managementCtrl from '../controllers/management.controller';

const { citiesCtrl } = managementCtrl;

const router = Router();

// 🔍 DEBUG (remove later)
console.log('citiesCtrl:', citiesCtrl);

// All /cities routes require auth
router.use(requireAuth);

// Safety check (prevents crash)
if (!citiesCtrl) {
  throw new Error('citiesCtrl is undefined — check management.controller export');
}

// GET /api/v1/cities
router.get('/', citiesCtrl.list);

// GET /api/v1/cities/:id
router.get('/:id', citiesCtrl.getOne);

// POST /api/v1/cities
router.post('/', requireRole('admin', 'supervisor'), citiesCtrl.create);

// PATCH /api/v1/cities/:id
router.patch('/:id', requireRole('admin', 'supervisor'), citiesCtrl.update);

// DELETE /api/v1/cities/:id
router.delete('/:id', requireRole('admin'), citiesCtrl.remove);

export default router;

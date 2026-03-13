import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { citiesCtrl } from '../controllers/management.controller';

const router = Router();

// All /cities routes require auth
router.use(requireAuth);

// GET /api/v1/cities        → list cities
router.get('/', citiesCtrl.list);

// GET /api/v1/cities/:id    → get single city
router.get('/:id', citiesCtrl.getOne);

// POST /api/v1/cities       → create city (admin/supervisor)
router.post('/', requireRole('admin', 'super_admin'), citiesCtrl.create);

// PATCH /api/v1/cities/:id  → update city (admin/supervisor)
router.patch('/:id', requireRole('admin', 'super_admin'), citiesCtrl.update);

// DELETE /api/v1/cities/:id → delete city (admin)
router.delete('/:id', requireRole('admin'), citiesCtrl.remove);

export default router;

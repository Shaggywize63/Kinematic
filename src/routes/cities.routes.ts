import { Router } from 'express';
import { requireAuth, requireRole, requireModule } from '../middleware/auth';
import { citiesCtrl } from '../controllers/management.controller';

const router = Router();

// All /cities routes require auth
router.use(requireAuth);

// GET /api/v1/cities        → list cities
router.get('/', citiesCtrl.list);

// GET /api/v1/cities/:id    → get single city
router.get('/:id', citiesCtrl.getOne);

// POST /api/v1/cities       → create city
router.post('/', requireModule('cities'), citiesCtrl.create);

// PATCH /api/v1/cities/:id  → update city
router.patch('/:id', requireModule('cities'), citiesCtrl.update);

// DELETE /api/v1/cities/:id → delete city
router.delete('/:id', requireModule('cities'), citiesCtrl.remove);

export default router;

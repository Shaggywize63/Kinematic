import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { citiesCtrl } from '../controllers/cities.controller';

const router = Router();

// All routes require auth
router.use(requireAuth);

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

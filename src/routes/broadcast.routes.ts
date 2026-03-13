import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getQuestions,
  getAdminQuestions,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  updateStatus,
  submitAnswer,
  getResults,
} from '../controllers/broadcast.controller';

const router = Router();

router.use(requireAuth);

// Admin routes
router.get('/admin', requireRole('admin', 'super_admin', 'city_manager'), getAdminQuestions);
router.post('/', requireRole('admin', 'super_admin', 'city_manager'), createQuestion);
router.patch('/:id', requireRole('admin', 'super_admin', 'city_manager'), updateQuestion);
router.delete('/:id', requireRole('admin', 'super_admin', 'city_manager'), deleteQuestion);
router.patch('/:id/status', requireRole('admin', 'super_admin', 'city_manager'), updateStatus);
router.get('/:id/results', requireRole('admin', 'super_admin', 'city_manager'), getResults);

// FE / Supervisor routes
router.get('/', getQuestions);
router.post('/:id/answer', submitAnswer);

export default router;

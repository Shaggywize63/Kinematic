import { Router } from 'express';
import * as ctrl from '../controllers/forms.controller';
import { requireAuth, requireAdminOrAbove, requireSupervisorOrAbove } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Templates
router.get('/templates',                     ctrl.getTemplates);
router.get('/templates/:id',                 ctrl.getTemplate);
router.post('/templates',                    requireAdminOrAbove, ctrl.createTemplate);
router.post('/templates/:id/fields',         requireAdminOrAbove, ctrl.addField);

// Submissions
router.post('/submit',                       ctrl.submitForm);
router.get('/submissions',                   ctrl.getMySubmissions);
router.get('/submissions/:id',               ctrl.getSubmission);
router.get('/admin/submissions',             requireSupervisorOrAbove, ctrl.getAllSubmissions);

export default router;

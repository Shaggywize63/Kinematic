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

// Visiting-card OCR for the `card_scan` field type — auth-only so any
// form-filling rep can use it (no CRM module required).
router.post('/scan-card',                    ctrl.scanBusinessCard);

// Submissions
router.post('/submit',                       ctrl.submitForm);
router.get('/submissions',                   ctrl.getMySubmissions);
router.get('/submissions/:id',               ctrl.getSubmission);
router.get('/admin/submissions',             requireSupervisorOrAbove, ctrl.getAllSubmissions);

export default router;

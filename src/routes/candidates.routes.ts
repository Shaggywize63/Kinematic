
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  getCandidates,
  createCandidate,
  getCandidateById,
  updateCandidate,
  getCandidateDocuments,
  addCandidateDocument,
} from '../controllers/candidates.controller';

const router = Router();

router.get('/',          requireAuth, getCandidates);
router.post('/',         requireAuth, createCandidate);
router.get('/:id',       requireAuth, getCandidateById);
router.patch('/:id',     requireAuth, updateCandidate);
router.get('/:id/documents',  requireAuth, getCandidateDocuments);
router.post('/:id/documents', requireAuth, addCandidateDocument);

export default router;

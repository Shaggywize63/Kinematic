import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  getCandidates,
  createCandidate,
  getCandidateById,
  updateCandidate,
  getCandidateDocuments,
  addCandidateDocument,
  updateCandidateDocument,
  deleteCandidateDocument,
} from '../controllers/candidates.controller';

const router = Router();

router.get('/',          requireAuth, getCandidates);
router.post('/',         requireAuth, createCandidate);
router.get('/:id',       requireAuth, getCandidateById);
router.patch('/:id',     requireAuth, updateCandidate);
router.get('/:id/documents',             requireAuth, getCandidateDocuments);
router.post('/:id/documents',            requireAuth, addCandidateDocument);
router.patch('/:id/documents/:docId',    requireAuth, updateCandidateDocument);
router.delete('/:id/documents/:docId',   requireAuth, deleteCandidateDocument);

export default router;

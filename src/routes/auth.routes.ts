import { Router } from 'express';
import { login, me, logout } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Public routes
router.post('/login', login);
router.post('/logout', logout);

// Protected routes
router.get('/me', requireAuth, me);

export default router;

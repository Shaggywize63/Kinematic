import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/project-for-email', ctrl.projectForEmail);
router.post('/login',   ctrl.login);
// Self-service password reset — both public, no auth header. The
// /auth catch-all in app.ts already exempts the whole /auth namespace
// from requireAuth so no extra bypass is needed. Forgot endpoint is
// rate-limited at the route level (perRouteLimit in app.ts) to slow
// down enumeration attempts; reset endpoint is bounded by the recovery
// token's own one-shot lifetime.
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password',  ctrl.resetPassword);
router.post('/refresh', ctrl.refresh);
router.post('/logout',  requireAuth, ctrl.logout);
router.get('/me',       requireAuth, ctrl.me);
router.patch('/me',     requireAuth, ctrl.updateMe);

export default router;

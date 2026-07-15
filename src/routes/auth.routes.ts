import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { requireAuth, MASTER_ADMIN_EMAIL } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';

const router = Router();

// The effective caller is the master admin when EITHER their real identity is
// the master email, OR they are currently impersonating (impersonated_by set
// to the master) — so the master can jump straight from one impersonation to
// another without exiting first.
function isMasterCaller(req: AuthRequest): boolean {
  const u = req.user as { email?: string; impersonated_by?: { email?: string } } | undefined;
  const real = u?.impersonated_by?.email ?? u?.email;
  return typeof real === 'string' && real.toLowerCase() === MASTER_ADMIN_EMAIL;
}

// Who am I *right now* — reflects the impersonated identity when active, plus
// `impersonated_by` so the dashboard can render the "Viewing as …" banner.
router.get('/impersonate/whoami', requireAuth, (req, res) => {
  const u = (req as AuthRequest).user as unknown as Record<string, unknown> | undefined;
  res.json({
    success: true,
    data: {
      id: u?.id ?? null,
      name: u?.name ?? null,
      email: u?.email ?? null,
      role: u?.role ?? null,
      org_id: u?.org_id ?? null,
      client_id: u?.client_id ?? null,
      org_role_name: u?.org_role_name ?? null,
      impersonated_by: u?.impersonated_by ?? null,
    },
  });
});

// User picker for the master admin's impersonation modal. Matches active
// users by name/email in the CURRENT Supabase project. Master-admin only.
router.get('/impersonate/search', requireAuth, async (req, res) => {
  if (!isMasterCaller(req as AuthRequest)) {
    res.status(403).json({ success: false, error: 'Impersonation is restricted to the platform master admin.' });
    return;
  }
  // Strip anything that could break the PostgREST .or() filter before we
  // interpolate the term into an ilike pattern.
  const q = String(req.query.q ?? '').trim().replace(/[^a-zA-Z0-9 @._-]/g, '');
  if (q.length < 1) { res.json({ success: true, data: [] }); return; }
  const limit = Math.min(Number(req.query.limit) || 25, 50);

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, org_id, client_id, org_role_id')
    .eq('is_active', true)
    .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(limit);
  if (error) { res.status(500).json({ success: false, error: error.message }); return; }

  const rows = (data ?? []) as Array<{ id: string; name: string | null; email: string | null; role: string | null; org_id: string | null; client_id: string | null; org_role_id: string | null }>;
  const roleIds = Array.from(new Set(rows.map((u) => u.org_role_id).filter(Boolean))) as string[];
  const roleName = new Map<string, string>();
  if (roleIds.length) {
    const { data: roles } = await supabaseAdmin.from('org_roles').select('id, name').in('id', roleIds);
    for (const r of (roles ?? []) as Array<{ id: string; name: string }>) roleName.set(r.id, r.name);
  }
  res.json({
    success: true,
    data: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      org_id: u.org_id,
      client_id: u.client_id,
      org_role_name: u.org_role_id ? (roleName.get(u.org_role_id) ?? null) : null,
    })),
  });
});

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
// Authenticated password change — powers the forced "set a new password on
// first login" flow. Requires a valid session (the user is already logged in
// with their temp/initial password).
router.post('/change-password', requireAuth, ctrl.changePassword);
router.post('/refresh', ctrl.refresh);
router.post('/logout',  requireAuth, ctrl.logout);
router.get('/me',       requireAuth, ctrl.me);
router.patch('/me',     requireAuth, ctrl.updateMe);

export default router;

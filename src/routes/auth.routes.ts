import { Router } from 'express';
import { SignJWT } from 'jose';
import * as ctrl from '../controllers/auth.controller';
import { requireAuth, MASTER_ADMIN_EMAIL } from '../middleware/auth';
import { adminClientFor, listProjectKeys, projectHs256Key, isKnownProject } from '../lib/projects';
import { AuthRequest } from '../types';

const router = Router();

// The effective caller is the master admin when EITHER their real identity is
// the master email, OR they are currently impersonating (a minted token whose
// `imp_by` claim was the master) — so the master can jump between users. The
// minted-token path surfaces the master email back on req.user.email? No — the
// minted token's identity IS the target, so we also accept an `impersonated_by`
// marker if present. In practice the picker is used from the master's own
// session, so the plain email check is the primary gate.
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

// User picker for the master admin's impersonation modal. Matches active users
// by name/email across EVERY Supabase project (so the Kinematic-project master
// admin can find e.g. an SRS/Tata user who lives in the `default` project).
// Each result carries its `project` so /start can mint a token for it.
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

  type Row = { id: string; name: string | null; email: string | null; role: string | null; org_id: string | null; client_id: string | null; org_role_id: string | null };
  const out: Array<Record<string, unknown>> = [];
  // Fan out across projects; a broken/unconfigured project is skipped, never
  // fatal, so one bad project can't blank the whole search.
  for (const project of listProjectKeys()) {
    try {
      const client = adminClientFor(project);
      const { data, error } = await client
        .from('users')
        .select('id, name, email, role, org_id, client_id, org_role_id')
        .eq('is_active', true)
        .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(limit);
      if (error) continue;
      const rows = (data ?? []) as Row[];
      const roleIds = Array.from(new Set(rows.map((u) => u.org_role_id).filter(Boolean))) as string[];
      const roleName = new Map<string, string>();
      if (roleIds.length) {
        const { data: roles } = await client.from('org_roles').select('id, name').in('id', roleIds);
        for (const r of (roles ?? []) as Array<{ id: string; name: string }>) roleName.set(r.id, r.name);
      }
      for (const u of rows) {
        out.push({
          id: u.id, name: u.name, email: u.email, role: u.role,
          org_id: u.org_id, client_id: u.client_id,
          org_role_name: u.org_role_id ? (roleName.get(u.org_role_id) ?? null) : null,
          project,
        });
      }
    } catch { /* skip this project */ }
  }
  res.json({ success: true, data: out.slice(0, 50) });
});

// Mint a session token FOR the target user, signed with the target's own
// project key — so the dashboard routes to that project and loads the target's
// real, role-scoped context (a Tata/SRS rep's session, not the master's).
// This is the only master-gated step; the resulting token simply *is* the
// target user (its `sub`), the same way "Login as client" works.
router.post('/impersonate/start', requireAuth, async (req, res) => {
  const realUser = (req as AuthRequest).user as { id?: string; email?: string } | undefined;
  if (!isMasterCaller(req as AuthRequest)) {
    res.status(403).json({ success: false, error: 'Impersonation is restricted to the platform master admin.' });
    return;
  }
  const body = (req.body ?? {}) as { user_id?: unknown; project?: unknown };
  const userId = String(body.user_id ?? '');
  const project = String(body.project ?? '');
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(userId)) { res.status(400).json({ success: false, error: 'Invalid user_id' }); return; }
  if (!isKnownProject(project)) { res.status(400).json({ success: false, error: 'Unknown project' }); return; }

  const client = adminClientFor(project);
  const { data: target, error } = await client
    .from('users')
    .select('id, name, email, role, org_id, client_id, is_active')
    .eq('id', userId)
    .single();
  if (error || !target) { res.status(404).json({ success: false, error: 'User not found' }); return; }
  if (!target.is_active) { res.status(400).json({ success: false, error: 'User is deactivated' }); return; }

  const key = projectHs256Key(project);
  if (!key) { res.status(400).json({ success: false, error: 'Impersonation is not available for this project (no shared JWT secret configured).' }); return; }

  const ttlSeconds = 60 * 60; // 1 hour
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    role: 'authenticated',
    email: target.email,
    // Audit breadcrumb — who minted this impersonation session.
    imp_by: realUser?.email,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(target.id)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);

  // eslint-disable-next-line no-console
  console.info(`[Impersonate] master ${realUser?.email} started session as user ${target.id} (${target.email}) in project ${project}`);

  res.json({
    success: true,
    data: {
      token,
      project,
      user: {
        id: target.id, name: target.name, email: target.email, role: target.role,
        org_id: target.org_id, client_id: target.client_id,
      },
    },
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

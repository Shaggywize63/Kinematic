import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { runWithProject, isKnownProject, fallbackProjectKey, resolveProjectForIntegrationAsync, resolveProjectForTokenAsync } from '../lib/projects';

// Reads the X-Kinematic-Project header and runs the remainder of the request
// inside that project's AsyncLocalStorage context, so supabase / supabaseAdmin
// / getUserClient and the JWT verifier all resolve to the correct Supabase
// project.
//
// When the header is absent or unknown we don't immediately give up to the
// default: an authenticated caller's bearer token already pins it to exactly
// one project (a token verifies against only its own project's signing keys),
// so we recover the project from the token itself. This rescues every mobile
// client whose session was established before the login-time project lookup
// ran (token restored from the keychain on cold start, no header sent) — which
// otherwise falls back to the default (Tata) project and sees nothing from any
// non-default tenant. resolveProjectForTokenAsync probes ONLY non-default
// projects and is fail-closed, so a default-project (Tata) token matches
// nothing and still falls through to fallbackProjectKey() — Tata routing is
// byte-for-byte unchanged, exactly as the header-only path was.
//
// fallbackProjectKey() remains the final fallback (a missing header AND no
// token-derived project): in PRODUCTION always the Tata 'default' project, so
// server-to-server calls and unauthenticated surfaces keep working as before.
// Only outside production can it default to Kinematic (DEV_DEFAULT_PROJECT).
export async function withProject(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = String(req.headers['x-kinematic-project'] || '').trim().toLowerCase();
  let project = isKnownProject(header) ? header : '';

  if (!project) {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length).replace(/['"]+/g, '').trim();
      // The demo placeholder isn't a real JWT — skip it and let it fall back.
      if (token && token !== 'demo-token-jwt-placeholder') {
        try {
          const fromToken = await resolveProjectForTokenAsync(token);
          if (fromToken) project = fromToken;
        } catch { /* unresolved — fall through to the default below */ }
      }
    }
  }

  if (!project) project = fallbackProjectKey();
  (req as AuthRequest & { projectKey?: string }).projectKey = project;
  runWithProject(project, () => next());
}

// Routes an unauthenticated integration surface (the hosted form `/f/:id` and
// the inbound webhook `/…/webhook/:provider/:id`) to whichever project owns the
// integration `:id`, instead of the header/default. These callers send no auth
// and no project header, so without this every non-default-project integration
// 404s ("Form not found") or silently drops its leads. Resolution is a DB probe
// (async, TTL-cached); the remainder of the request runs inside that project's
// AsyncLocalStorage context so supabaseAdmin & friends hit the right database.
export async function withIntegrationProject(req: AuthRequest, _res: Response, next: NextFunction) {
  const id = String(req.params.id || '').trim();
  const project = await resolveProjectForIntegrationAsync(id);
  (req as AuthRequest & { projectKey?: string }).projectKey = project;
  runWithProject(project, () => next());
}

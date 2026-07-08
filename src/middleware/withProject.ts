import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { runWithProject, isKnownProject, fallbackProjectKey, resolveProjectForIntegrationAsync } from '../lib/projects';

// Reads the X-Kinematic-Project header and runs the remainder of the request
// inside that project's AsyncLocalStorage context, so supabase / supabaseAdmin
// / getUserClient and the JWT verifier all resolve to the correct Supabase
// project. An unknown or missing header falls back to fallbackProjectKey() —
// which in PRODUCTION is always the Tata 'default' project, so the web
// dashboard pre-routing era, every mobile app (which never sends this header),
// and server-to-server calls all keep working exactly as before. Only outside
// production can it default to Kinematic (DEV_DEFAULT_PROJECT) for dev/tooling.
export function withProject(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = String(req.headers['x-kinematic-project'] || '').trim().toLowerCase();
  const project = isKnownProject(header) ? header : fallbackProjectKey();
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

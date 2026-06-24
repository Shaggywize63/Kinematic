import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { runWithProject, isKnownProject, fallbackProjectKey } from '../lib/projects';

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

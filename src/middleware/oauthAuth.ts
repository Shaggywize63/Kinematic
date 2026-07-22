// Bearer-auth for OAuth access tokens (used by the MCP server in Phase 2).
//
// Unlike requireAuth (which expects a Supabase JWT), this accepts an OPAQUE
// OAuth access token minted by our authorization server, resolves it to the
// granting user + project, and hydrates req.user via buildUserContext — so ALL
// the existing guards downstream (requireModuleAccess, readOnlyGuard, org/client
// scoping) apply unchanged. The connected assistant therefore acts strictly AS
// the user, never above them: capability = granted scope ∩ the user's role.

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { unauthorized, forbidden } from '../utils/response';
import { runWithProject, isKnownProject } from '../lib/projects';
import { buildUserContext } from './auth';
import { validateAccessToken } from '../lib/oauth/store';
import type { OAuthScope } from '../lib/oauth/scopes';
import { logger } from '../lib/logger';

/**
 * Require a valid OAuth access token, plus (optionally) that the grant carries
 * ALL of `requiredScopes`. On success, req.user is the connected user's full
 * context and req.oauth carries the client + granted scopes. The rest of the
 * request runs inside the token's project (runWithProject) so supabaseAdmin
 * targets the right tenant.
 */
export function requireOAuth(...requiredScopes: OAuthScope[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) return unauthorized(res, 'Missing bearer token');
      const token = auth.slice(7).trim();

      const grant = await validateAccessToken(token);
      if (!grant) return unauthorized(res, 'Invalid or expired token');
      if (!isKnownProject(grant.project_key)) return unauthorized(res, 'Invalid token');

      if (requiredScopes.length && !requiredScopes.every((s) => grant.scopes.includes(s))) {
        return forbidden(res, `insufficient_scope: requires ${requiredScopes.join(', ')}`);
      }

      // Hydrate the user IN the token's project context (buildUserContext uses
      // the ALS-bound supabaseAdmin, so it must run inside runWithProject).
      const user = await runWithProject(grant.project_key, () => buildUserContext(grant.user_id));
      if (!user) return unauthorized(res, 'Account not found or inactive');

      req.user = user;
      req.oauth = { clientId: grant.client_id, scopes: grant.scopes };
      req.accessToken = token;

      // Run the remainder of the request in the token's project so every
      // downstream supabaseAdmin call targets the correct tenant.
      return runWithProject(grant.project_key, () => next());
    } catch (e: any) {
      logger.error(`[OAuth] requireOAuth error: ${e?.message || e}`);
      return unauthorized(res, 'Authorization failed');
    }
  };
}

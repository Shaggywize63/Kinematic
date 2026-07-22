// OAuth 2.0 Authorization Server endpoints.
//
// Flow (authorization code + PKCE, per RFC 6749 / 7636 and the MCP auth spec):
//   1. GET  /oauth/authorize  → render a combined login + consent page.
//   2. POST /oauth/authorize  → verify Kinematic credentials, mint a one-time
//                               code, 302 back to the client's redirect_uri.
//   3. POST /oauth/token      → exchange code (PKCE) or refresh_token for tokens.
//   4. POST /oauth/revoke     → revoke a token.
//   5. GET  /.well-known/oauth-authorization-server → discovery metadata.
//
// The consent page is server-rendered HTML with NO inline JS (the app's CSP
// blocks inline script); styling is inline <style> (allowed).

import { Request, Response } from 'express';
import { asyncHandler } from '../utils';
import { logger } from '../lib/logger';
import {
  resolveProjectForEmailAsync, anonClientFor, adminClientFor, runWithProject, isKnownProject,
} from '../lib/projects';
import {
  getClient, verifyClientSecret, redirectUriAllowed, createAuthCode, consumeAuthCode,
  issueTokens, rotateRefreshToken, revokeToken, createClient,
} from '../lib/oauth/store';
import {
  ALL_SCOPES, OAUTH_SCOPES, parseScopes, scopeLabels, type OAuthScope,
} from '../lib/oauth/scopes';

function publicBase(req: Request): string {
  const env = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
  return env || `${req.protocol}://${req.get('host')}`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Read client credentials from Basic auth header or the request body. */
function clientCredentials(req: Request): { clientId: string; clientSecret?: string } {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Basic ')) {
    try {
      const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      if (id) return { clientId: id, clientSecret: secret };
    } catch { /* fall through to body */ }
  }
  const b = req.body || {};
  return { clientId: String(b.client_id || ''), clientSecret: b.client_secret ? String(b.client_secret) : undefined };
}

// ---------------------------------------------------------------- metadata ---

// RFC 8414 — MCP clients (ChatGPT Apps, Claude connectors) fetch this to
// discover the authorize/token endpoints before starting the flow.
// Dynamic Client Registration is on by default (MCP connectors self-register);
// set OAUTH_ALLOW_DCR=off to require operators to register clients by hand.
const DCR_ENABLED = process.env.OAUTH_ALLOW_DCR !== 'off';

export const authorizationServerMetadata = (req: Request, res: Response) => {
  const base = publicBase(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    ...(DCR_ENABLED ? { registration_endpoint: `${base}/oauth/register` } : {}),
    scopes_supported: ALL_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  });
};

/** A redirect_uri is acceptable if it's https, or http on localhost (dev). */
function isValidRedirectUri(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch { return false; }
}

// POST /oauth/register — Dynamic Client Registration (RFC 7591). Lets an MCP
// client (ChatGPT App, Claude connector) register itself and receive a
// client_id (+ secret for confidential clients). The real protection is still
// user login + consent + strict redirect_uri matching, so open registration is
// safe; it can be disabled with OAUTH_ALLOW_DCR=off.
export const register = asyncHandler<Request>(async (req, res) => {
  if (!DCR_ENABLED) {
    return res.status(403).json({ error: 'access_denied', error_description: 'Dynamic client registration is disabled.' });
  }
  const b = (req.body || {}) as Record<string, unknown>;

  const name = String(b.client_name || 'MCP client').slice(0, 200);
  const redirectUris = Array.isArray(b.redirect_uris) ? (b.redirect_uris as unknown[]).map(String) : [];
  if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be one or more https (or localhost) URLs.' });
  }

  const authMethod = String(b.token_endpoint_auth_method || 'client_secret_post');
  const isConfidential = authMethod !== 'none';

  // Requested scopes ∩ known scopes; default to all known scopes when omitted.
  const requested = parseScopes(typeof b.scope === 'string' ? b.scope : '');
  const allowedScopes = requested.length ? requested : [...ALL_SCOPES];

  const created = await createClient({ name, redirectUris, allowedScopes, isConfidential });
  logger.info(`[OAuth] registered client ${created.client_id} (${name}) redirect=[${redirectUris.join(' ')}]`);

  res.status(201).json({
    client_id: created.client_id,
    ...(created.client_secret ? { client_secret: created.client_secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: isConfidential ? authMethod : 'none',
    scope: allowedScopes.join(' '),
  });
});

// --------------------------------------------------------------- authorize ---

interface AuthorizeParams {
  clientId: string; redirectUri: string; scope: string; state: string;
  codeChallenge: string; codeChallengeMethod: string; responseType: string;
}

function readAuthorizeParams(src: Record<string, unknown>): AuthorizeParams {
  const s = (k: string) => (src[k] == null ? '' : String(src[k]));
  return {
    clientId: s('client_id'),
    redirectUri: s('redirect_uri'),
    scope: s('scope'),
    state: s('state'),
    codeChallenge: s('code_challenge'),
    codeChallengeMethod: s('code_challenge_method') || 'S256',
    responseType: s('response_type') || 'code',
  };
}

function consentPage(args: {
  base: string; clientName: string; params: AuthorizeParams; scopes: OAuthScope[]; error?: string;
}): string {
  const { params, scopes } = args;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
  const scopeItems = scopeLabels(scopes).map((l) => `<li>${esc(l)}</li>`).join('');
  const errBox = args.error ? `<div class="err">${esc(args.error)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Kinematic</title>
<style>
  :root{--red:#e01e2c;--ink:#0f172a;--dim:#64748b;--line:#e2e8f0;--bg:#f8fafc}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:420px;margin:6vh auto;padding:0 16px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:13px;margin:0 0 18px}
  .app{font-weight:600}
  ul{margin:8px 0 18px;padding-left:18px}
  li{margin:4px 0}
  label{display:block;font-size:13px;color:var(--dim);margin:12px 0 4px}
  input[type=email],input[type=password]{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;font-size:15px}
  input:focus{outline:none;border-color:var(--red)}
  .row{display:flex;gap:10px;margin-top:20px}
  button{flex:1;padding:11px 14px;border-radius:9px;font-size:15px;font-weight:600;cursor:pointer;border:1px solid var(--line)}
  .allow{background:var(--red);border-color:var(--red);color:#fff}
  .deny{background:#fff;color:var(--ink)}
  .err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:9px;padding:9px 11px;font-size:13px;margin-bottom:14px}
  .fine{color:var(--dim);font-size:12px;margin-top:16px}
</style></head><body><div class="wrap"><div class="card">
  <h1>Connect your Kinematic account</h1>
  <p class="sub"><span class="app">${esc(args.clientName)}</span> is requesting access to:</p>
  ${errBox}
  <ul>${scopeItems}</ul>
  <form method="post" action="${esc(args.base)}/oauth/authorize" autocomplete="off">
    ${hidden('client_id', params.clientId)}
    ${hidden('redirect_uri', params.redirectUri)}
    ${hidden('scope', scopes.join(' '))}
    ${hidden('state', params.state)}
    ${hidden('code_challenge', params.codeChallenge)}
    ${hidden('code_challenge_method', params.codeChallengeMethod)}
    ${hidden('response_type', params.responseType)}
    <label for="email">Work email</label>
    <input id="email" name="email" type="email" required autocomplete="username">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password">
    <div class="row">
      <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
      <button class="allow" type="submit" name="decision" value="allow">Allow access</button>
    </div>
  </form>
  <p class="fine">The assistant will act with your permissions only. You can revoke this access at any time.</p>
</div></div></body></html>`;
}

function sendHtml(res: Response, status: number, html: string) {
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

function errorHtml(base: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
    `<div style="max-width:420px;margin:10vh auto;font:15px/1.5 system-ui;color:#0f172a;text-align:center">` +
    `<h2 style="color:#e01e2c">Can't connect</h2><p>${esc(message)}</p></div>`;
}

/** Append an OAuth error to the client's redirect_uri and 302 there. */
function redirectError(res: Response, redirectUri: string, error: string, state: string, description?: string) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  res.redirect(302, u.toString());
}

// GET /oauth/authorize — validate the request, then render login + consent.
export const authorize = asyncHandler<Request>(async (req, res) => {
  const base = publicBase(req);
  const params = readAuthorizeParams(req.query as Record<string, unknown>);

  const client = await getClient(params.clientId);
  // Invalid client or redirect_uri: must NOT redirect (would be an open redirect).
  if (!client) return sendHtml(res, 400, errorHtml(base, 'Unknown or inactive application.'));
  if (!params.redirectUri || !redirectUriAllowed(client, params.redirectUri)) {
    return sendHtml(res, 400, errorHtml(base, 'This application is not allowed to use that redirect address.'));
  }
  // From here, protocol errors are reported back to the client via redirect.
  if (params.responseType !== 'code') {
    return redirectError(res, params.redirectUri, 'unsupported_response_type', params.state);
  }
  if (!params.codeChallenge) {
    return redirectError(res, params.redirectUri, 'invalid_request', params.state, 'PKCE code_challenge is required');
  }
  const requested = parseScopes(params.scope);
  const allowed = new Set(client.allowed_scopes as OAuthScope[]);
  const scopes = requested.filter((s) => allowed.has(s));
  if (scopes.length === 0) {
    return redirectError(res, params.redirectUri, 'invalid_scope', params.state, 'No permitted scopes requested');
  }

  sendHtml(res, 200, consentPage({ base, clientName: client.name, params, scopes }));
});

// POST /oauth/authorize — verify credentials + consent, mint a code, redirect.
export const authorizeSubmit = asyncHandler<Request>(async (req, res) => {
  const base = publicBase(req);
  const params = readAuthorizeParams(req.body as Record<string, unknown>);
  const decision = String((req.body as any)?.decision || '');
  const email = String((req.body as any)?.email || '').trim();
  const password = String((req.body as any)?.password || '');

  const client = await getClient(params.clientId);
  if (!client) return sendHtml(res, 400, errorHtml(base, 'Unknown or inactive application.'));
  if (!params.redirectUri || !redirectUriAllowed(client, params.redirectUri)) {
    return sendHtml(res, 400, errorHtml(base, 'This application is not allowed to use that redirect address.'));
  }

  const allowed = new Set(client.allowed_scopes as OAuthScope[]);
  const scopes = parseScopes(params.scope).filter((s) => allowed.has(s));
  if (scopes.length === 0) {
    return redirectError(res, params.redirectUri, 'invalid_scope', params.state);
  }

  if (decision !== 'allow') {
    return redirectError(res, params.redirectUri, 'access_denied', params.state, 'User denied the request');
  }
  if (!email || !password) {
    return sendHtml(res, 200, consentPage({ base, clientName: client.name, params, scopes, error: 'Enter your email and password.' }));
  }

  // Resolve which Supabase project this user belongs to, then authenticate there.
  const project = await resolveProjectForEmailAsync(email);
  if (!isKnownProject(project)) {
    return sendHtml(res, 200, consentPage({ base, clientName: client.name, params, scopes, error: 'Invalid email or password.' }));
  }

  let userId: string | null = null;
  try {
    const { data, error } = await anonClientFor(project).auth.signInWithPassword({ email, password });
    if (error || !data?.user) {
      return sendHtml(res, 200, consentPage({ base, clientName: client.name, params, scopes, error: 'Invalid email or password.' }));
    }
    userId = data.user.id;
  } catch (e: any) {
    logger.error(`[OAuth] signIn failed for ${email}: ${e?.message || e}`);
    return sendHtml(res, 200, consentPage({ base, clientName: client.name, params, scopes, error: 'Sign-in failed. Please try again.' }));
  }

  // Confirm the profile exists + is active in that project, and grab its org.
  const { data: profile } = await adminClientFor(project)
    .from('users').select('org_id, is_active').eq('id', userId).maybeSingle();
  if (!profile || profile.is_active === false) {
    return sendHtml(res, 200, consentPage({ base, clientName: client.name, params, scopes, error: 'This account is not active.' }));
  }

  const code = await createAuthCode({
    clientId: client.client_id,
    userId,
    projectKey: project,
    orgId: (profile.org_id as string) ?? null,
    redirectUri: params.redirectUri,
    scopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
  });

  logger.info(`[OAuth] issued code for user ${userId} (project=${project}) to client ${client.client_id} scopes=[${scopes.join(',')}]`);
  const u = new URL(params.redirectUri);
  u.searchParams.set('code', code);
  if (params.state) u.searchParams.set('state', params.state);
  res.redirect(302, u.toString());
});

// ------------------------------------------------------------------- token ---

function tokenError(res: Response, status: number, error: string, description?: string) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json({ error, ...(description ? { error_description: description } : {}) });
}

// POST /oauth/token — authorization_code (PKCE) or refresh_token grants.
export const token = asyncHandler<Request>(async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const grantType = String(b.grant_type || '');
  const { clientId, clientSecret } = clientCredentials(req);

  const client = await getClient(clientId);
  if (!client) return tokenError(res, 401, 'invalid_client');
  if (!verifyClientSecret(client, clientSecret)) return tokenError(res, 401, 'invalid_client');

  if (grantType === 'authorization_code') {
    const code = String(b.code || '');
    const redirectUri = String(b.redirect_uri || '');
    const codeVerifier = String(b.code_verifier || '');
    if (!code || !redirectUri || !codeVerifier) return tokenError(res, 400, 'invalid_request', 'Missing code, redirect_uri or code_verifier');

    const grant = await consumeAuthCode({ code, clientId, redirectUri, codeVerifier });
    if (!grant) return tokenError(res, 400, 'invalid_grant');

    const tokens = await issueTokens({
      clientId, userId: grant.user_id, projectKey: grant.project_key, orgId: grant.org_id, scopes: grant.scopes,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(tokens);
  }

  if (grantType === 'refresh_token') {
    const refreshToken = String(b.refresh_token || '');
    if (!refreshToken) return tokenError(res, 400, 'invalid_request', 'Missing refresh_token');
    const tokens = await rotateRefreshToken(refreshToken, clientId);
    if (!tokens) return tokenError(res, 400, 'invalid_grant');
    res.setHeader('Cache-Control', 'no-store');
    return res.json(tokens);
  }

  return tokenError(res, 400, 'unsupported_grant_type');
});

// ------------------------------------------------------------------ revoke ---

// POST /oauth/revoke — RFC 7009. Always 200 (even for unknown tokens).
export const revoke = asyncHandler<Request>(async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const tok = String(b.token || '');
  if (tok) await revokeToken(tok);
  res.status(200).json({ revoked: true });
});

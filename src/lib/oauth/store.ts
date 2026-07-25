// Data + crypto layer for the OAuth 2.0 authorization server.
//
// OAuth is a GLOBAL service, so its tables live in the default project only and
// are always reached via adminClientFor(OAUTH_PROJECT) — NOT the ALS-bound
// `supabaseAdmin` proxy — so lookups are deterministic regardless of the
// request's project context. Each code/token row carries `project_key` +
// `user_id`, letting token validation hop into the correct tenant.
//
// Tokens are OPAQUE: only SHA-256 hashes are persisted, never the raw value.

import crypto from 'crypto';
import { adminClientFor } from '../projects';
import { logger } from '../logger';
import type { OAuthScope } from './scopes';

// OAuth store project. In production `default` is the Tata/primary project; it
// is always a known project. Kept explicit so ALS context never redirects it.
const OAUTH_PROJECT = 'default';

export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;          // 5 minutes
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;      // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function db() {
  return adminClientFor(OAUTH_PROJECT);
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time-ish string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Verify a PKCE code_verifier against the stored challenge (S256 or plain). */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (!verifier || !challenge) return false;
  if (method === 'plain') return safeEqual(verifier, challenge);
  // S256: base64url(SHA256(verifier)) === challenge
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

// ---------------------------------------------------------------- clients ----

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  is_confidential: boolean;
  is_active: boolean;
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const { data, error } = await db()
    .from('oauth_clients')
    .select('client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_confidential, is_active')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) { logger.error(`[OAuth] getClient failed: ${error.message}`); return null; }
  if (!data || !data.is_active) return null;
  return data as OAuthClient;
}

/** Confidential clients must present a secret whose hash matches. */
export function verifyClientSecret(client: OAuthClient, presented?: string | null): boolean {
  if (!client.is_confidential) return true;      // public / PKCE-only client
  if (!client.client_secret_hash) return false;
  if (!presented) return false;
  return safeEqual(sha256(presented), client.client_secret_hash);
}

export function redirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  return Array.isArray(client.redirect_uris) && client.redirect_uris.includes(redirectUri);
}

export interface NewClient {
  name: string;
  redirectUris: string[];
  allowedScopes: OAuthScope[];
  isConfidential: boolean;
}

export interface CreatedClient {
  client_id: string;
  client_secret?: string;   // returned ONCE, only for confidential clients
}

/**
 * Register a new OAuth client (Dynamic Client Registration, RFC 7591). The
 * client_id is public; the secret (confidential clients only) is returned once
 * and only its SHA-256 hash is stored.
 */
export async function createClient(input: NewClient): Promise<CreatedClient> {
  const clientId = `kin_${randomToken(16)}`;
  const secret = input.isConfidential ? randomToken(32) : undefined;
  const { error } = await db().from('oauth_clients').insert({
    client_id: clientId,
    client_secret_hash: secret ? sha256(secret) : null,
    name: input.name,
    redirect_uris: input.redirectUris,
    allowed_scopes: input.allowedScopes,
    is_confidential: input.isConfidential,
    is_active: true,
  });
  if (error) throw new Error(`createClient: ${error.message}`);
  return { client_id: clientId, ...(secret ? { client_secret: secret } : {}) };
}

// --------------------------------------------------------- authorization ----

export interface NewAuthCode {
  clientId: string;
  userId: string;
  projectKey: string;
  orgId: string | null;
  redirectUri: string;
  scopes: OAuthScope[];
  codeChallenge: string;
  codeChallengeMethod: string;
}

/** Create a single-use authorization code; returns the RAW code. */
export async function createAuthCode(input: NewAuthCode): Promise<string> {
  const code = randomToken(32);
  const { error } = await db().from('oauth_authorization_codes').insert({
    code_hash: sha256(code),
    client_id: input.clientId,
    user_id: input.userId,
    project_key: input.projectKey,
    org_id: input.orgId,
    redirect_uri: input.redirectUri,
    scopes: input.scopes,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod || 'S256',
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`createAuthCode: ${error.message}`);
  return code;
}

export interface ConsumedCode {
  user_id: string;
  project_key: string;
  org_id: string | null;
  scopes: OAuthScope[];
}

/**
 * Atomically consume an authorization code: validates client + redirect + PKCE,
 * marks it used, and returns the grant. Returns null on any mismatch so the
 * caller emits a generic invalid_grant. Single-use is enforced by only
 * accepting rows where consumed_at IS NULL and stamping it in the same update.
 */
export async function consumeAuthCode(args: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ConsumedCode | null> {
  const { data, error } = await db()
    .from('oauth_authorization_codes')
    .select('id, client_id, user_id, project_key, org_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, consumed_at')
    .eq('code_hash', sha256(args.code))
    .maybeSingle();
  if (error || !data) return null;
  if (data.consumed_at) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  if (data.client_id !== args.clientId) return null;
  if (data.redirect_uri !== args.redirectUri) return null;
  if (!verifyPkce(args.codeVerifier, data.code_challenge, data.code_challenge_method)) return null;

  // Mark consumed; guard against a concurrent double-exchange by requiring the
  // row to still be unconsumed at update time.
  const { data: upd, error: updErr } = await db()
    .from('oauth_authorization_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();
  if (updErr || !upd) return null;   // lost the race → treat as invalid

  return {
    user_id: data.user_id,
    project_key: data.project_key,
    org_id: data.org_id,
    scopes: (data.scopes || []) as OAuthScope[],
  };
}

// ----------------------------------------------------------------- tokens ----

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export async function issueTokens(args: {
  clientId: string;
  userId: string;
  projectKey: string;
  orgId: string | null;
  scopes: OAuthScope[];
}): Promise<IssuedTokens> {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const now = Date.now();
  const { error } = await db().from('oauth_access_tokens').insert({
    access_token_hash: sha256(accessToken),
    refresh_token_hash: sha256(refreshToken),
    client_id: args.clientId,
    user_id: args.userId,
    project_key: args.projectKey,
    org_id: args.orgId,
    scopes: args.scopes,
    access_expires_at: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`issueTokens: ${error.message}`);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: args.scopes.join(' '),
  };
}

export interface ValidatedToken {
  client_id: string;
  user_id: string;
  project_key: string;
  org_id: string | null;
  scopes: OAuthScope[];
}

/** Resolve a bearer access token to its grant, or null if invalid/expired/revoked. */
export async function validateAccessToken(token: string): Promise<ValidatedToken | null> {
  if (!token) return null;
  const { data, error } = await db()
    .from('oauth_access_tokens')
    .select('client_id, user_id, project_key, org_id, scopes, access_expires_at, revoked_at')
    .eq('access_token_hash', sha256(token))
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at) return null;
  if (new Date(data.access_expires_at).getTime() < Date.now()) return null;
  // Best-effort last-used stamp (don't block on it).
  void db().from('oauth_access_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('access_token_hash', sha256(token));
  return {
    client_id: data.client_id,
    user_id: data.user_id,
    project_key: data.project_key,
    org_id: data.org_id,
    scopes: (data.scopes || []) as OAuthScope[],
  };
}

/** Rotate a refresh token: revoke the old grant, issue a fresh access+refresh pair. */
export async function rotateRefreshToken(refreshToken: string, clientId: string): Promise<IssuedTokens | null> {
  const { data, error } = await db()
    .from('oauth_access_tokens')
    .select('id, client_id, user_id, project_key, org_id, scopes, refresh_expires_at, revoked_at')
    .eq('refresh_token_hash', sha256(refreshToken))
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at) return null;
  if (data.client_id !== clientId) return null;
  if (!data.refresh_expires_at || new Date(data.refresh_expires_at).getTime() < Date.now()) return null;

  // Revoke the old grant, then mint a new one (refresh-token rotation).
  await db().from('oauth_access_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', data.id);
  return issueTokens({
    clientId: data.client_id,
    userId: data.user_id,
    projectKey: data.project_key,
    orgId: data.org_id,
    scopes: (data.scopes || []) as OAuthScope[],
  });
}

/** Revoke a grant by either its access or refresh token. Idempotent. */
export async function revokeToken(token: string): Promise<void> {
  const h = sha256(token);
  const stamp = new Date().toISOString();
  await db().from('oauth_access_tokens').update({ revoked_at: stamp }).eq('access_token_hash', h).is('revoked_at', null);
  await db().from('oauth_access_tokens').update({ revoked_at: stamp }).eq('refresh_token_hash', h).is('revoked_at', null);
}

// ------------------------------------------------------------------ audit ----

export async function recordAudit(entry: {
  clientId: string; userId: string; projectKey: string; orgId: string | null;
  tool: string; scopes: string[]; targetType?: string; targetId?: string;
  request?: unknown; outcome?: 'ok' | 'denied' | 'error'; error?: string;
}): Promise<void> {
  try {
    await db().from('oauth_action_audit').insert({
      client_id: entry.clientId,
      user_id: entry.userId,
      project_key: entry.projectKey,
      org_id: entry.orgId,
      tool: entry.tool,
      scopes: entry.scopes,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      request: entry.request ?? {},
      outcome: entry.outcome ?? 'ok',
      error: entry.error ?? null,
    });
  } catch (e: any) {
    logger.warn(`[OAuth] audit insert failed: ${e?.message || e}`);
  }
}

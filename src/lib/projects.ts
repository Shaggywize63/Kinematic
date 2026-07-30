import 'dotenv/config';
import { AsyncLocalStorage } from 'async_hooks';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { jwtVerify, createRemoteJWKSet, JWTPayload, JWTVerifyResult } from 'jose';

// ─────────────────────────────────────────────────────────────────────────
// Multi-project registry.
//
// The backend serves more than one Supabase project (one per customer for
// hard data isolation). Each request is routed to exactly one project, chosen
// from the X-Kinematic-Project header (see middleware/withProject) and carried
// through the request via AsyncLocalStorage. The DEFAULT project reuses the
// existing SUPABASE_* env vars verbatim, so single-project deployments and all
// existing traffic (the Tata tenant + every mobile app, which never send the
// header) behave byte-for-byte identically.
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_PROJECT = 'default';

export interface ProjectConfig {
  key: string;
  url: string;
  anonKey: string;
  serviceKey: string;
  jwksUrl?: string;
  jwtSecret?: string;
  storageBucket?: string;
  edgeFunctionsUrl?: string;
  edgeSecret?: string;
}

function buildRegistry(): Record<string, ProjectConfig> {
  const reg: Record<string, ProjectConfig> = {};

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error('Missing Supabase environment variables (default project)');
  }
  reg[DEFAULT_PROJECT] = {
    key: DEFAULT_PROJECT,
    url,
    anonKey,
    serviceKey,
    jwksUrl: process.env.SUPABASE_JWKS_URL || undefined,
    jwtSecret: process.env.SUPABASE_JWT_SECRET || undefined,
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET || undefined,
    edgeFunctionsUrl: process.env.SUPABASE_EDGE_FUNCTIONS_URL || undefined,
    edgeSecret: process.env.SUPABASE_EDGE_SECRET || undefined,
  };

  // Additional projects are registered ONLY when fully configured, so a
  // deployment without these vars simply runs a single project (safe).
  const kUrl = process.env.KINEMATIC_SUPABASE_URL;
  const kAnon = process.env.KINEMATIC_SUPABASE_ANON_KEY;
  const kService = process.env.KINEMATIC_SUPABASE_SERVICE_ROLE_KEY;
  if (kUrl && kAnon && kService) {
    reg['kinematic'] = {
      key: 'kinematic',
      url: kUrl,
      anonKey: kAnon,
      serviceKey: kService,
      jwksUrl: process.env.KINEMATIC_SUPABASE_JWKS_URL || undefined,
      jwtSecret: process.env.KINEMATIC_SUPABASE_JWT_SECRET || undefined,
      storageBucket: process.env.KINEMATIC_SUPABASE_STORAGE_BUCKET || undefined,
      edgeFunctionsUrl: process.env.KINEMATIC_SUPABASE_EDGE_FUNCTIONS_URL || undefined,
      edgeSecret: process.env.KINEMATIC_SUPABASE_EDGE_SECRET || undefined,
    };
  }

  return reg;
}

const REGISTRY = buildRegistry();

// ── Dynamic registry (runtime-provisioned projects) ──────────────────────
// Projects created by the onboarding provisioner don't exist as env vars at
// boot — their connection details live in the control-plane `platform_projects`
// table and are loaded into this map at startup (and on each new provision) by
// src/lib/platformProjects.ts. Every resolver below consults the static
// REGISTRY first (env-configured, never overridden) and this map second, so a
// runtime project becomes reachable via adminClientFor()/getProjectConfig()
// exactly like a compile-time one. A dynamic entry can NEVER shadow a static
// key (the static one wins), keeping default/kinematic behaviour byte-identical.
const DYNAMIC: Record<string, ProjectConfig> = {};

/** Register/refresh a runtime-provisioned project. Ignored if the key collides
 *  with a static (env) project, which must always win. Clears any cached client
 *  so a rotated key takes effect. */
export function upsertDynamicProject(cfg: ProjectConfig): void {
  if (REGISTRY[cfg.key]) return;
  DYNAMIC[cfg.key] = cfg;
  adminClients.delete(cfg.key);
  anonClients.delete(cfg.key);
  verifiers.delete(cfg.key);
}

export function removeDynamicProject(key: string): void {
  delete DYNAMIC[key];
  adminClients.delete(key);
  anonClients.delete(key);
  verifiers.delete(key);
}

function lookupConfig(key?: string | null): ProjectConfig | undefined {
  if (!key) return undefined;
  return REGISTRY[key] || DYNAMIC[key];
}

export function isKnownProject(key: string | undefined | null): boolean {
  return !!key && (Object.prototype.hasOwnProperty.call(REGISTRY, key)
    || Object.prototype.hasOwnProperty.call(DYNAMIC, key));
}

/** All configured project keys (env + runtime-provisioned). */
export function knownProjectKeys(): string[] {
  return Array.from(new Set([...Object.keys(REGISTRY), ...Object.keys(DYNAMIC)]));
}

/**
 * Effective fallback project for code paths that have no explicit project: a
 * missing/unknown X-Kinematic-Project header, an unmatched login email, or
 * out-of-request code (scripts, cron jobs, module init).
 *
 * In PRODUCTION this is ALWAYS the historical DEFAULT_PROJECT ('default' = the
 * Tata tenant), so live mobile apps and Tata web — none of which send a project
 * header — are never re-routed. Only OUTSIDE production may DEV_DEFAULT_PROJECT
 * override it, so local development and admin tooling can default to Kinematic
 * with zero risk to Tata. BOTH conditions are required (non-prod AND a valid
 * override), so a stray env var on the production server changes nothing.
 */
export function fallbackProjectKey(): string {
  if (process.env.NODE_ENV === 'production') return DEFAULT_PROJECT;
  const override = (process.env.DEV_DEFAULT_PROJECT || '').trim().toLowerCase();
  return override && isKnownProject(override) ? override : DEFAULT_PROJECT;
}

export function listProjectKeys(): string[] {
  return knownProjectKeys();
}

export function getProjectConfig(key?: string | null): ProjectConfig {
  return lookupConfig(key) ?? REGISTRY[fallbackProjectKey()];
}

// ── Per-request current project (AsyncLocalStorage) ──────────────────────
const als = new AsyncLocalStorage<{ project: string }>();

export function runWithProject<T>(project: string, fn: () => T): T {
  const key = isKnownProject(project) ? project : fallbackProjectKey();
  return als.run({ project: key }, fn);
}

/** Current request's project key, or DEFAULT_PROJECT outside a request
 *  (scripts, cron jobs, module init) — i.e. the historical single project. */
export function currentProjectKey(): string {
  return als.getStore()?.project || fallbackProjectKey();
}

// ── Cached Supabase clients, one per project ─────────────────────────────
const CLIENT_OPTS = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
} as const;

const adminClients = new Map<string, SupabaseClient>();
const anonClients = new Map<string, SupabaseClient>();

export function adminClientFor(key?: string | null): SupabaseClient {
  const cfg = getProjectConfig(key);
  let client = adminClients.get(cfg.key);
  if (!client) {
    client = createClient(cfg.url, cfg.serviceKey, CLIENT_OPTS);
    adminClients.set(cfg.key, client);
  }
  return client;
}

export function anonClientFor(key?: string | null): SupabaseClient {
  const cfg = getProjectConfig(key);
  let client = anonClients.get(cfg.key);
  if (!client) {
    client = createClient(cfg.url, cfg.anonKey, CLIENT_OPTS);
    anonClients.set(cfg.key, client);
  }
  return client;
}

export function userClientFor(key: string | null | undefined, accessToken: string): SupabaseClient {
  const cfg = getProjectConfig(key);
  return createClient(cfg.url, cfg.anonKey, {
    ...CLIENT_OPTS,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// ── Per-project JWT verifiers (JWKS / HS256), built lazily ───────────────
type Verifier = {
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  hs256: Uint8Array | null;
};
const verifiers = new Map<string, Verifier>();

function verifierFor(key: string): Verifier {
  let v = verifiers.get(key);
  if (!v) {
    const cfg = getProjectConfig(key);
    v = {
      jwks: cfg.jwksUrl ? createRemoteJWKSet(new URL(cfg.jwksUrl), { cooldownDuration: 30_000 }) : null,
      hs256: cfg.jwtSecret ? new TextEncoder().encode(cfg.jwtSecret) : null,
    };
    verifiers.set(key, v);
  }
  return v;
}

/**
 * Verify a token against a specific project's signing keys. Tries asymmetric
 * (JWKS) first, then legacy HS256. Returns null on failure so the caller can
 * fall back to a gotrue network check. Each project has its OWN keys, so a
 * token minted by project A will not verify against project B.
 */
export async function verifyProjectToken(key: string, token: string): Promise<JWTVerifyResult | null> {
  const v = verifierFor(key);
  if (v.jwks) {
    try { return await jwtVerify(token, v.jwks); } catch { /* fall through */ }
  }
  if (v.hs256) {
    try { return await jwtVerify(token, v.hs256); } catch { /* fall through */ }
  }
  return null;
}

/**
 * HS256 signing key for the project's legacy shared JWT secret. Used to mint
 * super-admin "Login as client" impersonation tokens, which verifyProjectToken
 * then accepts natively via its HS256 path. Returns null when the project has
 * no shared secret configured (asymmetric-only) — callers must then treat
 * impersonation tokens as unavailable and fall back.
 */
export function projectHs256Key(key: string): Uint8Array | null {
  return verifierFor(key).hs256;
}

// ── email → project directory ────────────────────────────────────────────
// A login is routed to the project the user ACTUALLY lives in — we look the
// email up in each project's users table (resolveProjectForEmailAsync) rather
// than guessing from the email's domain. No domain is ever hardcoded to a
// project: a @kinematicapp.com account that belongs to a Tata org routes to
// Tata, and the same domain in a Kinematic org routes to Kinematic, purely
// from where the row exists. Optional env maps still let ops PIN a routing when
// they need to (exact-email wins over everything, then whole-domain):
//   PROJECT_EMAIL_DIRECTORY  = {"someone@x.com":"kinematic"}   (exact email)
//   PROJECT_DOMAIN_DIRECTORY = {"example.com":"kinematic"}     (whole domain)
function parseJsonMap(envVal?: string): Record<string, string> {
  if (!envVal) return {};
  try {
    const parsed = JSON.parse(envVal);
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(parsed)) {
      if (typeof val === 'string') out[k.toLowerCase()] = val;
    }
    return out;
  } catch {
    return {};
  }
}

const EMAIL_DIRECTORY = parseJsonMap(process.env.PROJECT_EMAIL_DIRECTORY);
const DOMAIN_DIRECTORY = parseJsonMap(process.env.PROJECT_DOMAIN_DIRECTORY);

// Order in which we probe projects for the email. Explicit (non-default)
// projects first, the default (Tata catch-all) last, so a rare cross-project
// duplicate resolves to the more specific tenant deterministically.
function projectSearchOrder(): string[] {
  const keys = knownProjectKeys();
  const ordered = [...keys.filter(k => k !== DEFAULT_PROJECT), DEFAULT_PROJECT];
  return ordered.filter((k, i, a) => a.indexOf(k) === i);
}

// Small TTL cache so we don't hit every project DB on each keystroke/login.
const emailProjectCache = new Map<string, { project: string; at: number }>();
const EMAIL_PROJECT_TTL_MS = 5 * 60_000;

/** Forget a cached routing (call after creating/moving/deleting a user). */
export function clearEmailProjectCache(email?: string | null): void {
  if (email) emailProjectCache.delete(email.trim().toLowerCase());
  else emailProjectCache.clear();
}

/**
 * Resolve which Supabase project a login email belongs to by finding the
 * project whose `users` table actually holds that email. Active rows win over
 * inactive; env pins override the lookup. Unknown emails fall back to the
 * default project (so a brand-new/unseen email still lands somewhere sane).
 */
export async function resolveProjectForEmailAsync(email?: string | null): Promise<string> {
  const e = (email || '').trim().toLowerCase();
  if (!e) return fallbackProjectKey();

  // 1. Exact-email env pin wins over everything.
  const exact = EMAIL_DIRECTORY[e];
  if (exact && isKnownProject(exact)) return exact;

  const cached = emailProjectCache.get(e);
  if (cached && Date.now() - cached.at < EMAIL_PROJECT_TTL_MS) return cached.project;

  // 2. Data-driven: which project's users table holds this email?
  let firstInactive: string | null = null;
  for (const key of projectSearchOrder()) {
    try {
      const { data } = await adminClientFor(key)
        .from('users').select('is_active').eq('email', e).limit(1).maybeSingle();
      if (data) {
        if ((data as { is_active?: boolean }).is_active !== false) {
          emailProjectCache.set(e, { project: key, at: Date.now() });
          return key;
        }
        if (!firstInactive) firstInactive = key;
      }
    } catch { /* project unreachable — skip it */ }
  }
  if (firstInactive) {
    emailProjectCache.set(e, { project: firstInactive, at: Date.now() });
    return firstInactive;
  }

  // 3. Optional whole-domain env pin.
  const at = e.lastIndexOf('@');
  if (at >= 0) {
    const byDomain = DOMAIN_DIRECTORY[e.slice(at + 1)];
    if (byDomain && isKnownProject(byDomain)) return byDomain;
  }

  // 4. Fallback — the default project.
  return fallbackProjectKey();
}

// Short TTL cache for token→project so a burst of header-less requests carrying
// the same bearer token doesn't re-verify it against every project each time.
// A token's owning project is immutable for the token's lifetime, so caching is
// always safe; entries are bounded FIFO and expire on a short TTL regardless.
const tokenProjectCache = new Map<string, { project: string | null; at: number }>();
const TOKEN_PROJECT_TTL_MS = 5 * 60_000;
const TOKEN_PROJECT_CACHE_MAX = 5000;

/** Forget a cached token routing (rarely needed — tokens are immutable). */
export function clearTokenProjectCache(token?: string | null): void {
  if (token) tokenProjectCache.delete(token.trim());
  else tokenProjectCache.clear();
}

/**
 * Read a JWT's `iss` (issuer) claim WITHOUT verifying the signature — a plain
 * base64url decode of the payload segment. A Supabase access token's issuer is
 * that project's auth URL (`https://<ref>.supabase.co/auth/v1`), so the issuer
 * host identifies the minting project regardless of whether we hold that
 * project's signing keys locally. Used only as a ROUTING hint; the real
 * cryptographic verification still happens later in requireAuth, so an attacker
 * cannot gain anything by forging `iss` (a forged token fails verification and
 * 401s). Returns null on any malformed / missing-issuer token.
 */
function tokenIssuer(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { iss?: unknown };
    return typeof payload.iss === 'string' ? payload.iss : null;
  } catch {
    return null;
  }
}

function sameHost(a: string, b: string): boolean {
  try { return new URL(a).host === new URL(b).host; } catch { return false; }
}

/**
 * Resolve which Supabase project minted a bearer token WITHOUT any DB probe.
 * Two config-independent signals, in order:
 *   1. Cryptographic: verify the token against each non-default project's local
 *      signing keys (definitive when those keys are configured).
 *   2. Issuer match: compare the token's `iss` host to each non-default
 *      project's URL host. This works even when a project has only its URL /
 *      service key configured and NO local JWKS / JWT secret (in which case (1)
 *      can't verify) — the crypto check still runs later in requireAuth, so
 *      routing by issuer stays strictly fail-closed.
 *
 * A token verifies / issues against exactly one project, so the first
 * non-default project it matches is its true owner. Returns null when no
 * non-default project matches — the token is a default-project (Tata) token or
 * unrecognisable — so callers keep their existing default/fallback behaviour
 * and Tata routing is NEVER altered. Only non-default projects are probed (the
 * default is the fallback anyway); a single-project deployment short-circuits
 * to null with zero work.
 *
 * This is the authenticated-surface analogue of resolveProjectForEmailAsync
 * (login) and resolveProjectForIntegrationAsync (webhooks): a header-less caller
 * whose identity still pins it to a specific project.
 */
export async function resolveProjectForTokenAsync(token?: string | null): Promise<string | null> {
  const t = (token || '').trim();
  if (!t) return null;

  const nonDefault = knownProjectKeys().filter((k) => k !== DEFAULT_PROJECT);
  if (nonDefault.length === 0) return null;

  const cached = tokenProjectCache.get(t);
  if (cached && Date.now() - cached.at < TOKEN_PROJECT_TTL_MS) return cached.project;

  let resolved: string | null = null;

  // 1. Cryptographic local verification (definitive when signing keys exist).
  for (const key of nonDefault) {
    try {
      const res = await verifyProjectToken(key, t);
      if (res?.payload?.sub) { resolved = key; break; }
    } catch { /* not this project — try the next */ }
  }

  // 2. Fallback: match the token issuer's host to a project URL. Rescues the
  //    common prod setup where a non-default project is configured with only
  //    its URL + service key (no local JWKS / JWT secret), so step 1 can't
  //    verify but the project is still reachable and its data must be served.
  if (!resolved) {
    const iss = tokenIssuer(t);
    if (iss) {
      for (const key of nonDefault) {
        const url = getProjectConfig(key)?.url;
        if (url && sameHost(iss, url)) { resolved = key; break; }
      }
    }
  }

  if (tokenProjectCache.size >= TOKEN_PROJECT_CACHE_MAX) {
    const firstKey = tokenProjectCache.keys().next().value;
    if (firstKey !== undefined) tokenProjectCache.delete(firstKey);
  }
  tokenProjectCache.set(t, { project: resolved, at: Date.now() });
  return resolved;
}

// Short TTL cache for integration→project lookups so a burst of webhook hits
// on the same integration doesn't probe every project DB each time.
const integrationProjectCache = new Map<string, { project: string; at: number }>();
const INTEGRATION_PROJECT_TTL_MS = 5 * 60_000;

/** Forget a cached integration routing (call after moving/deleting one). */
export function clearIntegrationProjectCache(integrationId?: string | null): void {
  if (integrationId) integrationProjectCache.delete(integrationId.trim());
  else integrationProjectCache.clear();
}

/**
 * Resolve which Supabase project holds a given lead-source integration id.
 *
 * The public lead-capture surfaces — the hosted form (`/f/:id`) and the inbound
 * webhook (`/api/v1/integrations/webhook/:provider/:id`) — are unauthenticated
 * and carry NO `X-Kinematic-Project` header, so without this they always fall
 * back to the default project and can't see integrations that belong to another
 * project's clients (the "Form not found" / silently-dropped-webhook bug). We
 * probe each known project's `crm_lead_source_integrations` table for the id;
 * unknown ids fall back to the default project, where the handler returns its
 * own not-found response.
 */
export async function resolveProjectForIntegrationAsync(integrationId?: string | null): Promise<string> {
  const id = (integrationId || '').trim();
  if (!id) return fallbackProjectKey();

  const cached = integrationProjectCache.get(id);
  if (cached && Date.now() - cached.at < INTEGRATION_PROJECT_TTL_MS) return cached.project;

  for (const key of projectSearchOrder()) {
    try {
      const { data } = await adminClientFor(key)
        .from('crm_lead_source_integrations').select('id').eq('id', id).limit(1).maybeSingle();
      if (data) {
        integrationProjectCache.set(id, { project: key, at: Date.now() });
        return key;
      }
    } catch { /* project unreachable — skip it */ }
  }
  return fallbackProjectKey();
}

/**
 * Synchronous, config-only resolver (env pins + fallback, NO DB lookup and NO
 * hardcoded domain). Retained for non-login code paths that can't await; the
 * login project-for-email endpoint uses the async, data-driven resolver above.
 */
export function resolveProjectForEmail(email: string | undefined | null): string {
  const e = (email || '').trim().toLowerCase();
  if (!e) return fallbackProjectKey();
  const exact = EMAIL_DIRECTORY[e];
  if (exact && isKnownProject(exact)) return exact;
  const at = e.lastIndexOf('@');
  if (at >= 0) {
    const byDomain = DOMAIN_DIRECTORY[e.slice(at + 1)];
    if (byDomain && isKnownProject(byDomain)) return byDomain;
  }
  return fallbackProjectKey();
}

export type { JWTPayload };

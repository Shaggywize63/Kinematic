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
// Config-driven so we never touch a tenant DB to route a login. JSON maps:
//   PROJECT_EMAIL_DIRECTORY  = {"s@kinematicapp.com":"kinematic"}   (exact email)
//   PROJECT_DOMAIN_DIRECTORY = {"example.com":"kinematic"}          (whole domain)
// Exact-email entries win over domain entries. Anything unmatched resolves to
// DEFAULT_PROJECT, preserving current behaviour. Prefer exact-email mapping
// for shared domains (e.g. @kinematicapp.com staff who belong to the default
// tenant must NOT be domain-routed).
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

// Built-in routing defaults so the platform's OWN accounts resolve correctly
// even before any PROJECT_*_DIRECTORY env is set. The Kinematic platform admins
// live in the 'kinematic' project, not the default (Tata) one. Env directories
// override these; only applied when the target project is actually configured.
// Tata users use other domains, so this never affects them.
const BUILTIN_DOMAIN_DIRECTORY: Record<string, string> = {
  'kinematicapp.com': 'kinematic',
};

export function resolveProjectForEmail(email: string | undefined | null): string {
  const e = (email || '').trim().toLowerCase();
  if (!e) return fallbackProjectKey();

  const exact = EMAIL_DIRECTORY[e];
  if (exact && isKnownProject(exact)) return exact;

  const at = e.lastIndexOf('@');
  if (at >= 0) {
    const domain = e.slice(at + 1);
    const byDomain = DOMAIN_DIRECTORY[domain] || BUILTIN_DOMAIN_DIRECTORY[domain];
    if (byDomain && isKnownProject(byDomain)) return byDomain;
  }

  return fallbackProjectKey();
}

export type { JWTPayload };

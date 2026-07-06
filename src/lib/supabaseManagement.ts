import 'dotenv/config';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────
// Thin wrapper over the Supabase Management API (https://api.supabase.com/v1).
//
// Used ONLY by the onboarding provisioner to create a dedicated project (=
// separate database) per client. Requires a Personal Access Token with project
// create scope:
//   SUPABASE_MANAGEMENT_TOKEN  — the PAT (Bearer)
//   SUPABASE_ORG_ID            — org that owns/bills the new projects
//   TENANT_PROJECT_REGION      — default region for new projects (optional)
//   TENANT_PROJECT_DB_PASS     — DB password set on new projects (optional;
//                                a random one is generated when unset)
//
// If SUPABASE_MANAGEMENT_TOKEN is absent, isProvisioningConfigured() is false
// and the provision endpoint returns a clear 400 — no project is ever created
// implicitly (each one bills ~$10/mo).
// ─────────────────────────────────────────────────────────────────────────

const MGMT_BASE = 'https://api.supabase.com/v1';

export function isProvisioningConfigured(): boolean {
  return !!(process.env.SUPABASE_MANAGEMENT_TOKEN && process.env.SUPABASE_ORG_ID);
}

function token(): string {
  const t = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!t) throw new Error('SUPABASE_MANAGEMENT_TOKEN is not set — project provisioning is disabled.');
  return t;
}

async function mgmt<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MGMT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase Management API ${init?.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface CreatedProject {
  id: string;   // project ref
  ref?: string;
  name: string;
  region: string;
  status: string;
}

/** Generate a strong DB password when the operator hasn't pinned one. */
function randomDbPassword(): string {
  const buf = require('crypto').randomBytes(24) as Buffer;
  // URL-safe, no ambiguous chars that break connection strings.
  return buf.toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 28) + 'A9';
}

export async function createProject(opts: {
  name: string;
  region?: string;
  dbPass?: string;
}): Promise<{ project: CreatedProject; dbPass: string }> {
  const organization_id = process.env.SUPABASE_ORG_ID;
  if (!organization_id) throw new Error('SUPABASE_ORG_ID is not set.');
  const region = opts.region || process.env.TENANT_PROJECT_REGION || 'ap-southeast-2';
  const dbPass = opts.dbPass || process.env.TENANT_PROJECT_DB_PASS || randomDbPassword();
  const project = await mgmt<CreatedProject>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      organization_id,
      name: opts.name,
      region,
      db_pass: dbPass,
    }),
  });
  logger.info(`[mgmt] created project ${project.id} (${opts.name}, ${region})`);
  return { project, dbPass };
}

export async function getProject(ref: string): Promise<{ id: string; status: string; name: string }> {
  return mgmt(`/projects/${ref}`);
}

/**
 * Poll until the project reaches ACTIVE_HEALTHY (or times out). New projects
 * typically take 1–2 minutes to become healthy.
 */
export async function waitUntilHealthy(ref: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;
  const intervalMs = opts?.intervalMs ?? 6_000;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let status = 'UNKNOWN';
    try { status = (await getProject(ref)).status; } catch { /* transient */ }
    if (status === 'ACTIVE_HEALTHY') return;
    if (Date.now() > deadline) throw new Error(`Project ${ref} not healthy after ${Math.round(timeoutMs / 1000)}s (last status ${status})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface ApiKey { name: string; api_key: string }

/** Fetch anon + service_role keys for a project. Retries briefly since keys can
 *  lag project readiness. */
export async function getApiKeys(ref: string): Promise<{ anon: string; service: string }> {
  let last: ApiKey[] = [];
  for (let i = 0; i < 10; i++) {
    last = await mgmt<ApiKey[]>(`/projects/${ref}/api-keys?reveal=true`);
    const anon = last.find((k) => k.name === 'anon')?.api_key;
    const service = last.find((k) => k.name === 'service_role')?.api_key;
    if (anon && service) return { anon, service };
    await new Promise((r) => setTimeout(r, 4_000));
  }
  throw new Error(`Could not read anon+service api keys for ${ref} (got: ${last.map((k) => k.name).join(',')})`);
}

/** Best-effort legacy HS256 JWT secret (may be absent on projects that use
 *  asymmetric signing keys — that's fine, JWKS covers verification). */
export async function getJwtSecret(ref: string): Promise<string | null> {
  try {
    const cfg = await mgmt<{ jwt_secret?: string }>(`/projects/${ref}/config/auth`);
    return cfg.jwt_secret || null;
  } catch {
    return null;
  }
}

/** Run arbitrary SQL against a project via the Management API query endpoint. */
export async function runSql(ref: string, query: string): Promise<unknown> {
  return mgmt(`/projects/${ref}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

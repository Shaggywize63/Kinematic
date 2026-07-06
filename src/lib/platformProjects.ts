import 'dotenv/config';
import { adminClientFor, upsertDynamicProject, removeDynamicProject, ProjectConfig } from './projects';
import { decryptSecret, encryptSecret } from './secretBox';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────
// Dynamic project loader.
//
// Per-client projects created by the onboarding provisioner are recorded in
// `platform_projects` in the CONTROL-PLANE project (Kinematic). Their service
// keys are stored encrypted (secretBox). At boot — and after every new
// provision — we hydrate them into the in-memory dynamic registry
// (src/lib/projects.ts) so the shared backend can reach each tenant DB.
//
// The control plane is the 'kinematic' project. If that project isn't
// configured (single-project deployment) or the table doesn't exist yet, this
// no-ops quietly, so nothing here can break an existing deployment.
// ─────────────────────────────────────────────────────────────────────────

export const CONTROL_PLANE_PROJECT = process.env.CONTROL_PLANE_PROJECT || 'kinematic';

export interface PlatformProjectRow {
  key: string;
  ref: string;
  url: string;
  anon_key: string;
  service_key_enc: string;
  jwt_secret_enc?: string | null;
  region?: string | null;
  status?: string | null;
  client_id?: string | null;
  org_id?: string | null;
}

function rowToConfig(row: PlatformProjectRow): ProjectConfig | null {
  const serviceKey = decryptSecret(row.service_key_enc);
  if (!row.url || !row.anon_key || !serviceKey) return null;
  const jwtSecret = row.jwt_secret_enc ? decryptSecret(row.jwt_secret_enc) : null;
  const ref = row.ref;
  return {
    key: row.key,
    url: row.url,
    anonKey: row.anon_key,
    serviceKey,
    // A fresh Supabase project verifies asymmetric tokens via its JWKS; the
    // legacy shared secret (if captured) lets us mint impersonation tokens.
    jwksUrl: ref ? `https://${ref}.supabase.co/auth/v1/.well-known/jwks.json` : undefined,
    jwtSecret: jwtSecret || undefined,
  };
}

/**
 * Load every active runtime project into the dynamic registry. Safe to call
 * repeatedly (idempotent upserts). Returns the count loaded.
 */
export async function loadDynamicProjects(): Promise<number> {
  let admin;
  try {
    admin = adminClientFor(CONTROL_PLANE_PROJECT);
  } catch {
    return 0; // control-plane project not configured
  }
  const { data, error } = await admin
    .from('platform_projects')
    .select('key, ref, url, anon_key, service_key_enc, jwt_secret_enc, region, status, client_id, org_id')
    .neq('status', 'failed');
  if (error) {
    // Table missing on a deployment that hasn't run the migration → ignore.
    logger.warn(`[platformProjects] skip dynamic load: ${error.message}`);
    return 0;
  }
  let n = 0;
  for (const row of (data || []) as PlatformProjectRow[]) {
    const cfg = rowToConfig(row);
    if (cfg) { upsertDynamicProject(cfg); n++; }
  }
  if (n) logger.info(`[platformProjects] loaded ${n} runtime project(s) into the registry`);
  return n;
}

/**
 * Persist a newly provisioned project to the control plane AND register it in
 * the live registry immediately (so the very next call can reach it). Keys are
 * encrypted at rest.
 */
export async function saveDynamicProject(input: {
  key: string;
  ref: string;
  url: string;
  anonKey: string;
  serviceKey: string;
  jwtSecret?: string | null;
  region?: string | null;
  status?: string;
  clientId?: string | null;
  orgId?: string | null;
}): Promise<void> {
  const admin = adminClientFor(CONTROL_PLANE_PROJECT);
  const { error } = await admin.from('platform_projects').upsert({
    key: input.key,
    ref: input.ref,
    url: input.url,
    anon_key: input.anonKey,
    service_key_enc: encryptSecret(input.serviceKey),
    jwt_secret_enc: input.jwtSecret ? encryptSecret(input.jwtSecret) : null,
    region: input.region ?? null,
    status: input.status ?? 'active',
    client_id: input.clientId ?? null,
    org_id: input.orgId ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (error) throw new Error(`platform_projects upsert failed: ${error.message}`);

  const cfg = rowToConfig({
    key: input.key, ref: input.ref, url: input.url, anon_key: input.anonKey,
    service_key_enc: encryptSecret(input.serviceKey),
    jwt_secret_enc: input.jwtSecret ? encryptSecret(input.jwtSecret) : null,
  });
  if (cfg) upsertDynamicProject(cfg);
}

/** Mark a project failed and drop it from the live registry. */
export async function markDynamicProjectFailed(key: string, reason: string): Promise<void> {
  try {
    const admin = adminClientFor(CONTROL_PLANE_PROJECT);
    await admin.from('platform_projects')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('key', key);
  } catch { /* best effort */ }
  removeDynamicProject(key);
  logger.warn(`[platformProjects] marked ${key} failed: ${reason}`);
}

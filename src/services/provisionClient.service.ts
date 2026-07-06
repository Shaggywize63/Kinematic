import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { adminClientFor } from '../lib/projects';
import { CONTROL_PLANE_PROJECT, saveDynamicProject, markDynamicProjectFailed } from '../lib/platformProjects';
import {
  isProvisioningConfigured, createProject, waitUntilHealthy, getApiKeys, getJwtSecret, runSql, getProject,
} from '../lib/supabaseManagement';
import { encryptSecret } from '../lib/secretBox';
import { logger } from '../lib/logger';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────
// Automated per-client onboarding.
//
// One idempotent flow that, for a new client:
//   1. creates a dedicated Supabase PROJECT (= separate database);
//   2. loads the golden tenant schema into it;
//   3. registers it in the dynamic project registry (so the shared backend can
//      reach it at runtime);
//   4. creates the client's ORG + client record + admin user (test@<slug>.com)
//      inside that new project;
//   5. creates the control-plane client record in the Kinematic project;
//   6. links the two (writes data_project_key + data_client_id back onto the
//      control record) so module-ceiling sync and "Login as client" work.
//
// Every billable step is gated: nothing is created unless the Management API is
// configured AND the golden schema file is present.
// ─────────────────────────────────────────────────────────────────────────

export interface ProvisionInput {
  name: string;
  contactPerson?: string;
  phone?: string;
  adminEmail?: string;          // defaults to test@<slug>.com
  adminPassword?: string;       // generated if absent (returned to the caller)
  modules?: string[];
  region?: string;
  actorUserId: string;          // super-admin performing the onboarding
  actorOrgId: string;           // control-plane org that will OWN this client
  idempotencyKey?: string;
}

export interface ProvisionResult {
  ok: boolean;
  reused?: boolean;
  projectKey: string;
  projectRef: string;
  projectUrl: string;
  newOrgId: string;
  tenantClientId: string;
  controlClientId: string;
  adminEmail: string;
  adminPassword?: string;       // only returned on first creation
  runId: string;
  steps: string[];
}

export function slugForClient(name: string): string {
  return (name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'client';
}

function projectKeyFor(slug: string): string {
  // Registry key must be stable + collision-resistant across clients of the
  // same name. 6 random hex chars keeps it short but unique.
  return `client-${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

function randomPassword(): string {
  return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 18) + 'Aa1!';
}

export function loadTenantBootstrapSql(): string {
  const p = process.env.TENANT_BOOTSTRAP_SQL_PATH
    || path.join(process.cwd(), 'migrations', 'tenant_bootstrap.sql');
  if (!fs.existsSync(p)) {
    throw new Error(
      `Tenant bootstrap schema not found at ${p}. Generate it once with pg_dump — see migrations/tenant_bootstrap.README.md.`,
    );
  }
  const sql = fs.readFileSync(p, 'utf8').trim();
  if (sql.length < 100) {
    throw new Error(`Tenant bootstrap schema at ${p} looks empty/placeholder (${sql.length} bytes).`);
  }
  return sql;
}

/** Fast preflight so the caller gets a clear 400 instead of a half-run. */
export function provisioningPreflight(): { ok: boolean; reason?: string } {
  if (!isProvisioningConfigured()) {
    return { ok: false, reason: 'Project provisioning is not configured (set SUPABASE_MANAGEMENT_TOKEN + SUPABASE_ORG_ID).' };
  }
  try { loadTenantBootstrapSql(); } catch (e: any) { return { ok: false, reason: e?.message || 'bootstrap schema missing' }; }
  return { ok: true };
}

type RunRow = {
  id: string;
  status: string;
  steps: string[];
  project_key?: string | null;
  project_ref?: string | null;
  new_org_id?: string | null;
  tenant_client_id?: string | null;
  control_client_id?: string | null;
};

export async function provisionClient(input: ProvisionInput): Promise<ProvisionResult> {
  const pre = provisioningPreflight();
  if (!pre.ok) throw new Error(pre.reason);

  const control = adminClientFor(CONTROL_PLANE_PROJECT);
  const idem = input.idempotencyKey || `${slugForClient(input.name)}-${input.actorOrgId}`;

  // ── Idempotency: a completed run is replayed verbatim; nothing re-created. ──
  const { data: prior } = await control
    .from('provisioning_runs')
    .select('id, status, steps, project_key, project_ref, new_org_id, tenant_client_id, control_client_id')
    .eq('idempotency_key', idem)
    .maybeSingle();
  if (prior && (prior as RunRow).status === 'completed') {
    const r = prior as RunRow;
    const cfgUrl = r.project_ref ? `https://${r.project_ref}.supabase.co` : '';
    return {
      ok: true, reused: true,
      projectKey: r.project_key || '', projectRef: r.project_ref || '', projectUrl: cfgUrl,
      newOrgId: r.new_org_id || '', tenantClientId: r.tenant_client_id || '',
      controlClientId: r.control_client_id || '',
      adminEmail: input.adminEmail || `test@${slugForClient(input.name)}.com`,
      runId: r.id, steps: r.steps || [],
    };
  }

  const slug = slugForClient(input.name);
  const adminEmail = (input.adminEmail || `test@${slug}.com`).toLowerCase();
  const adminPassword = input.adminPassword || randomPassword();
  const projectKey = projectKeyFor(slug);
  const steps: string[] = [];

  // Create (or resume) the run ledger row.
  let runId = (prior as RunRow | null)?.id || '';
  if (!runId) {
    const { data: run, error } = await control.from('provisioning_runs').insert({
      idempotency_key: idem, client_name: input.name, admin_email: adminEmail,
      status: 'started', steps: [],
    }).select('id').single();
    if (error) throw new Error(`provisioning_runs insert failed: ${error.message}`);
    runId = (run as { id: string }).id;
  }

  const mark = async (status: string, patch: Record<string, unknown> = {}) => {
    steps.push(status);
    await control.from('provisioning_runs')
      .update({ status, steps, updated_at: new Date().toISOString(), ...patch })
      .eq('id', runId);
  };

  try {
    // 1. Create the dedicated project (separate DB).
    const { project, dbPass } = await createProject({ name: `Kinematic – ${input.name}`, region: input.region });
    const ref = project.id;
    const url = `https://${ref}.supabase.co`;
    await mark('project_created', { project_ref: ref, project_key: projectKey });
    logger.info(`[provision] ${input.name}: project ${ref} created`);

    // 2. Wait until healthy, then pull keys.
    await waitUntilHealthy(ref);
    const { anon, service } = await getApiKeys(ref);
    const jwtSecret = await getJwtSecret(ref);

    // 3. Load the golden schema into the empty DB.
    await runSql(ref, loadTenantBootstrapSql());
    await mark('schema_loaded');

    // 4. Register the project so adminClientFor(projectKey) can reach it.
    await saveDynamicProject({
      key: projectKey, ref, url, anonKey: anon, serviceKey: service, jwtSecret,
      region: project.region, status: 'active', clientId: null, orgId: null,
    });
    const tenant = adminClientFor(projectKey);

    // 5. Create the tenant org inside the new project.
    const { data: org, error: orgErr } = await tenant.from('organisations')
      .insert({ name: input.name, slug: `${slug}-${crypto.randomBytes(3).toString('hex')}` })
      .select('id').single();
    if (orgErr || !org) throw new Error(`tenant org create failed: ${orgErr?.message || 'unknown'}`);
    const newOrgId = (org as { id: string }).id;
    await mark('org_created', { new_org_id: newOrgId });

    // 6. Create the tenant's client record inside its own project.
    const { data: tClient, error: tcErr } = await tenant.from('clients')
      .insert({ org_id: newOrgId, name: input.name, contact_person: input.contactPerson, email: adminEmail, phone: input.phone, is_active: true })
      .select('id').single();
    if (tcErr || !tClient) throw new Error(`tenant client create failed: ${tcErr?.message || 'unknown'}`);
    const tenantClientId = (tClient as { id: string }).id;
    await mark('tenant_client_created', { tenant_client_id: tenantClientId });

    // 7. Create the admin user (test@<slug>.com) in the new project.
    const { data: au, error: auErr } = await tenant.auth.admin.createUser({
      email: adminEmail, password: adminPassword, email_confirm: true,
      user_metadata: { name: input.contactPerson || input.name, role: 'admin' },
    });
    if (auErr && !auErr.message.toLowerCase().includes('already')) {
      throw new Error(`admin auth user create failed: ${auErr.message}`);
    }
    const authId = au?.user?.id;
    if (authId) {
      await tenant.from('users').upsert({
        id: authId, org_id: newOrgId, client_id: tenantClientId,
        name: input.contactPerson || input.name, email: adminEmail, mobile: input.phone || '',
        role: 'admin', is_active: true,
      });
    }
    await mark('admin_created');

    // 8. Control-plane: a grouping org + the client record in Kinematic.
    const { data: ctlOrg } = await control.from('organisations')
      .insert({ name: input.name, slug: `${slug}-ctl-${crypto.randomBytes(3).toString('hex')}` })
      .select('id').single();
    const controlOrgId = (ctlOrg as { id: string } | null)?.id || input.actorOrgId;

    const { data: cClient, error: ccErr } = await control.from('clients').insert({
      org_id: controlOrgId,
      owner_org_id: input.actorOrgId,
      name: input.name,
      contact_person: input.contactPerson,
      email: adminEmail,
      phone: input.phone,
      is_active: true,
      // 9. Cross-project link: where this client's real data lives + its login.
      data_project_key: projectKey,
      data_client_id: tenantClientId,
      login_org_id: newOrgId,
      login_password_enc: encryptSecret(adminPassword),
    }).select('id').single();
    if (ccErr || !cClient) throw new Error(`control client create failed: ${ccErr?.message || 'unknown'}`);
    const controlClientId = (cClient as { id: string }).id;
    await mark('control_client_created', { control_client_id: controlClientId });

    // 10. Module grants on both ends (control ceiling + tenant client).
    const modules = Array.isArray(input.modules) ? input.modules.filter(Boolean) : [];
    if (modules.length) {
      const { data: validCtl } = await control.from('modules').select('id');
      const okCtl = new Set((validCtl || []).map((m: { id: string }) => m.id));
      const ctlPayload = modules.filter((m) => okCtl.has(m)).map((m) => ({
        client_id: controlClientId, module_id: m, enabled: true, source: 'manual', granted_by: input.actorUserId,
      }));
      if (ctlPayload.length) await control.from('client_modules').upsert(ctlPayload, { onConflict: 'client_id,module_id' });

      const { data: validTen } = await tenant.from('modules').select('id');
      const okTen = new Set((validTen || []).map((m: { id: string }) => m.id));
      const tenPayload = modules.filter((m) => okTen.has(m)).map((m) => ({
        client_id: tenantClientId, module_id: m, enabled: true, source: 'platform_ceiling', granted_by: input.actorUserId,
      }));
      if (tenPayload.length) await tenant.from('client_modules').upsert(tenPayload, { onConflict: 'client_id,module_id' });
      if (authId && tenPayload.length) {
        await tenant.from('user_module_permissions').delete().eq('user_id', authId);
        await tenant.from('user_module_permissions').insert(tenPayload.map((p) => ({ user_id: authId, module_id: p.module_id })));
      }
    }

    // 11. Finalise the registry row with its links.
    await control.from('platform_projects')
      .update({ client_id: controlClientId, org_id: newOrgId, status: 'active', updated_at: new Date().toISOString() })
      .eq('key', projectKey);

    await mark('completed');
    logger.info(`[provision] ${input.name}: completed (project ${ref}, control client ${controlClientId})`);

    return {
      ok: true, projectKey, projectRef: ref, projectUrl: url,
      newOrgId, tenantClientId, controlClientId, adminEmail, adminPassword,
      runId, steps,
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    logger.error(`[provision] ${input.name}: FAILED at ${steps[steps.length - 1] || 'start'}: ${msg}`);
    await control.from('provisioning_runs')
      .update({ status: 'failed', error: msg, steps, updated_at: new Date().toISOString() })
      .eq('id', runId);
    // Leave any created project in place (billable + may hold partial state) but
    // drop it from the live registry so it can't serve traffic half-built.
    if (projectKey) await markDynamicProjectFailed(projectKey, msg).catch(() => {});
    throw new Error(msg);
  }
}

/** Re-hydrate the dynamic registry health note for status endpoints. */
export async function getProvisioningStatus(ref: string) {
  try { return await getProject(ref); } catch { return null; }
}

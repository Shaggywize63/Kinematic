import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, isUUID } from '../utils';
import { isDemo, getMockClients } from '../utils/demoData';
import { clearEntitlementCache } from '../lib/entitlements';
import { currentProjectKey, projectHs256Key, getProjectConfig, isKnownProject, adminClientFor, clearEmailProjectCache } from '../lib/projects';
import { SignJWT } from 'jose';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { encryptSecret, decryptSecret } from '../lib/secretBox';
import { logger } from '../lib/logger';
import { provisionClient as runProvision, provisioningPreflight } from '../services/provisionClient.service';

// Org-per-client is now the universal onboarding model: EVERY new client gets
// its OWN org (a row-level tenant) for isolation, and the parent org that
// owns/manages it is recorded in `owner_org_id`. This applies to the default
// (Tata) project too, now that its `clients` table carries owner_org_id +
// login_org_id + data_project_key/data_client_id + login_password_enc.
//
// A project can opt back into the legacy single-org model (client lives in the
// admin's own org, scoped by `org_id`) by listing its key in SINGLE_ORG_PROJECTS
// — a comma-separated escape hatch, empty by default. `currentProjectKey()` is
// never null, so an unmatched project is always org-per-client.
const SINGLE_ORG_PROJECTS = new Set(
  (process.env.SINGLE_ORG_PROJECTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
);
const orgPerClient = () => !SINGLE_ORG_PROJECTS.has(currentProjectKey());
const ownerColumn = () => (orgPerClient() ? 'owner_org_id' : 'org_id');

function orgSlug(name: string): string {
  const base = (name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Per-org active-user cap, settable from Client Management ───────────────
// The cap must land on the org that actually HOLDS this client's users, and be
// enforced there. For a same-project client that's its own org in the current
// project; for a cross-project client (data in another Supabase project) it's
// the linked client's org in that project — same target the module ceiling uses.
async function resolveCapTarget(client: {
  org_id?: string; data_project_key?: string; data_client_id?: string;
}): Promise<{ admin: SupabaseClient; orgId: string | null }> {
  const dp = client.data_project_key;
  const dcid = client.data_client_id;
  if (orgPerClient() && dp && isKnownProject(dp) && dp !== currentProjectKey() && dcid && isUUID(dcid)) {
    const remote = adminClientFor(dp);
    const { data } = await remote.from('clients').select('org_id').eq('id', dcid).maybeSingle();
    const org = (data as { org_id?: string } | null)?.org_id ?? null;
    if (org) return { admin: remote, orgId: org };
  }
  return { admin: supabaseAdmin, orgId: client.org_id ?? null };
}

// Normalise a max-active-users input to a positive int or null (null = no cap).
function parseUserCap(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Write (or clear, with null) the cap on the client's users-org via org_settings.
async function writeUserCap(client: { org_id?: string; data_project_key?: string; data_client_id?: string }, value: number | null): Promise<void> {
  const { admin, orgId } = await resolveCapTarget(client);
  if (!orgId) return;
  await admin.from('org_settings').delete().eq('org_id', orgId).eq('key', 'limits.max_active_users');
  if (value) await admin.from('org_settings').insert({ org_id: orgId, key: 'limits.max_active_users', value });
}

// Read the current cap for a set of clients (batched for same-project, per-link
// for cross-project) so the Client Management form can prepopulate it.
async function readUserCaps(clients: Array<{ id: string; org_id?: string; data_project_key?: string; data_client_id?: string }>): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  const isCross = (c: { data_project_key?: string; data_client_id?: string }) =>
    !!(orgPerClient() && c.data_project_key && isKnownProject(c.data_project_key)
      && c.data_project_key !== currentProjectKey() && c.data_client_id && isUUID(c.data_client_id));

  const same = clients.filter(c => !isCross(c));
  const orgIds = Array.from(new Set(same.map(c => c.org_id).filter(Boolean))) as string[];
  if (orgIds.length) {
    const { data } = await supabaseAdmin.from('org_settings')
      .select('org_id, value').eq('key', 'limits.max_active_users').in('org_id', orgIds);
    const byOrg: Record<string, number> = {};
    (data || []).forEach((r: { org_id: string; value: unknown }) => {
      const n = parseInt(String(r.value), 10); if (Number.isFinite(n)) byOrg[r.org_id] = n;
    });
    same.forEach(c => { out[c.id] = (c.org_id && byOrg[c.org_id]) ?? null; });
  }
  for (const c of clients.filter(isCross)) {
    try {
      const { admin, orgId } = await resolveCapTarget(c);
      if (!orgId) { out[c.id] = null; continue; }
      const { data } = await admin.from('org_settings')
        .select('value').eq('org_id', orgId).eq('key', 'limits.max_active_users').maybeSingle();
      const n = data ? parseInt(String((data as { value: unknown }).value), 10) : NaN;
      out[c.id] = Number.isFinite(n) ? n : null;
    } catch { out[c.id] = null; }
  }
  return out;
}

/**
 * GET /api/v1/clients
 * Admin only: List all clients for the organization
 */
export const getClients = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockClients());
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq(ownerColumn(), user.org_id)
    .order('name');

  if (error) {
    badRequest(res, error.message);
    return;
  }

  // Fetch module entitlements for each client (excludes universal modules,
  // which are always-on via the v_client_enabled_modules view).
  const clientIds = (data || []).map(c => c.id);
  const { data: accessData } = await supabaseAdmin
    .from('client_modules')
    .select('client_id, module_id, enabled, expires_at')
    .in('client_id', clientIds)
    .eq('enabled', true);

  const now = Date.now();
  // Per-org active-user caps (from the org holding each client's users).
  const caps = await readUserCaps((data || []) as Array<{ id: string; org_id?: string; data_project_key?: string; data_client_id?: string }>);
  const results = (data || []).map(client => ({
    ...client,
    max_active_users: caps[client.id] ?? null,
    modules: (accessData || [])
      .filter(a => a.client_id === client.id
        && (!a.expires_at || new Date(a.expires_at).getTime() > now))
      .map(a => a.module_id)
  }));

  ok(res, results);
});

/**
 * POST /api/v1/clients
 * Admin only: Create a new client
 */
export const createClient = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { name, contact_person, email, phone, modules, password, login_org_id, data_project_key, data_client_id, max_active_users } = req.body;

  if (!name) {
    badRequest(res, 'Client name is required');
    return;
  }

  // Parent-owns-sub-orgs (non-default projects): spin up a dedicated org for
  // this client so its data is isolated; the creating admin's org owns it.
  // Tata (default) keeps the client in the admin's own org.
  let clientOrgId = user.org_id;
  if (orgPerClient()) {
    const { data: org, error: orgErr } = await supabaseAdmin
      .from('organisations')
      .insert({ name, slug: orgSlug(name) })
      .select('id')
      .single();
    if (orgErr || !org) { badRequest(res, `Org creation failed: ${orgErr?.message || 'unknown'}`); return; }
    clientOrgId = org.id;
  }

  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .insert({
      org_id: clientOrgId,
      ...(orgPerClient() ? { owner_org_id: user.org_id } : {}),
      // Optional admin-set "Org ID" the Login button targets (falls back to
      // the client's own org). Only persisted on non-default projects.
      ...(orgPerClient() && typeof login_org_id === 'string' && isUUID(login_org_id) ? { login_org_id } : {}),
      // Cross-project data link (which project + client holds this org's data),
      // so the module ceiling set here syncs there.
      ...(orgPerClient() && typeof data_project_key === 'string' && isKnownProject(data_project_key) ? { data_project_key } : {}),
      ...(orgPerClient() && typeof data_client_id === 'string' && isUUID(data_client_id) ? { data_client_id } : {}),
      // Encrypted account password used by the "Login as client" button.
      ...(orgPerClient() && password ? { login_password_enc: encryptSecret(password) } : {}),
      name,
      contact_person,
      email,
      phone,
      is_active: true
    })
    .select()
    .single();

  if (error) {
    badRequest(res, error.message);
    return;
  }

  // Create/Sync administrator user for this client if password/email provided
  if (password && email) {
    let authId: string | undefined;

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: contact_person || name, role: 'client' },
    });

    if (authErr) {
      if (authErr.message.toLowerCase().includes('already')) {
        // Find existing Auth ID by email
        const { data: { users: listUsers } } = await supabaseAdmin.auth.admin.listUsers();
        authId = listUsers.find((u: any) => u.email?.toLowerCase() === email.toLowerCase())?.id;
      } else {
        console.error('Auth creation error:', authErr.message);
      }
    } else {
      authId = authData.user.id;
    }

    if (authId) {
      // Always upsert to public.users to ensure the profile exists and is linked
      await supabaseAdmin.from('users').upsert({
        id: authId,
        org_id: clientOrgId,
        client_id: client.id,
        name: contact_person || name,
        email,
        mobile: phone || '',
        role: 'client',
        is_active: true
      });
      // This email now lives in this project — drop any stale routing cache so
      // the next login resolves to the right project.
      clearEmailProjectCache(email);
    }
  }

  // Add module access if provided
  if (modules && Array.isArray(modules) && modules.length > 0) {
    const accessPayload = modules.map(m => ({
      client_id: client.id,
      module_id: m,
      enabled: true,
      source: 'manual',
      granted_by: user.id,
    }));
    await supabaseAdmin
      .from('client_modules')
      .upsert(accessPayload, { onConflict: 'client_id,module_id' });
    clearEntitlementCache(client.id);

    // Sync to user_module_permissions if we have an authId (administrator account)
    const { data: adminUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('client_id', client.id)
      .eq('role', 'client')
      .maybeSingle();

    if (adminUser) {
      const userPermissionsPayload = modules.map(m => ({
        user_id: adminUser.id,
        module_id: m
      }));
      // Delete old permissions and insert new ones
      await supabaseAdmin.from('user_module_permissions').delete().eq('user_id', adminUser.id);
      await supabaseAdmin.from('user_module_permissions').insert(userPermissionsPayload);
    }
  }

  // Per-org active-user cap (optional). Written to the org that holds this
  // client's users; enforced by assertActiveUserCap on user create/activate.
  if (max_active_users !== undefined) {
    try { await writeUserCap(client, parseUserCap(max_active_users)); }
    catch (e: any) { logger.warn(`[Clients] user-cap write failed for ${client.id}: ${e?.message || e}`); }
  }

  created(res, { ...client, modules: modules || [], max_active_users: parseUserCap(max_active_users) });
});

/**
 * GET /api/v1/clients/provision/preflight
 * Super-admin only: is automated per-client project provisioning available on
 * this deployment? Lets the UI show/hide the "dedicated project" toggle.
 */
export const provisionPreflight = asyncHandler(async (_req: AuthRequest, res: Response) => {
  ok(res, provisioningPreflight());
});

/**
 * POST /api/v1/clients/provision
 * Super-admin only: fully automated onboarding — creates a dedicated Supabase
 * project (separate DB) for the client, loads the golden schema, creates its
 * org + client record + admin user (test@<slug>.com), creates the control-plane
 * client record in Kinematic, and links the two. Idempotent via Idempotency-Key.
 */
export const provisionClientHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { name, contact_person, phone, email, password, modules, region } = req.body || {};
  if (!name || typeof name !== 'string') { badRequest(res, 'Client name is required'); return; }

  const pre = provisioningPreflight();
  if (!pre.ok) { badRequest(res, pre.reason || 'Provisioning is not configured'); return; }

  try {
    const result = await runProvision({
      name: name.trim(),
      contactPerson: contact_person,
      phone,
      adminEmail: typeof email === 'string' && email.trim() ? email.trim() : undefined,
      adminPassword: typeof password === 'string' && password ? password : undefined,
      modules: Array.isArray(modules) ? modules : [],
      region: typeof region === 'string' ? region : undefined,
      actorUserId: user.id,
      actorOrgId: user.org_id,
      idempotencyKey: (req.headers['idempotency-key'] as string) || undefined,
    });
    created(res, result);
  } catch (e: any) {
    badRequest(res, `Provisioning failed: ${e?.message || e}`);
  }
});

/**
 * POST /api/v1/clients/:id/impersonate
 * Super-admin only: mint a short-lived "Login as client" token scoped to the
 * client's own org. Signed with this project's HS256 secret so the normal
 * verifier accepts it; carries act:true + act_org_id, which the auth middleware
 * honours (for super_admin) to scope the whole session to that org. Lets the
 * super-admin enter a client org with no re-login.
 */
export const impersonateClient = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }

  // Only a client owned by the caller's org may be entered.
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('id', id)
    .eq(ownerColumn(), user.org_id)
    .single();
  if (error || !client) { notFound(res, 'Client not found'); return; }

  // Target = the admin-set "Org ID" field if present, else the client's own org.
  const loginOrg = (client as { login_org_id?: string }).login_org_id;
  const targetOrg = (typeof loginOrg === 'string' && isUUID(loginOrg)) ? loginOrg : client.org_id;

  const key = projectHs256Key(currentProjectKey());
  if (!key) { badRequest(res, 'Impersonation is not available for this project (no shared JWT secret configured)'); return; }

  const ttlSeconds = 60 * 60; // 1 hour
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    role: 'authenticated',
    email: (user as { email?: string }).email,
    act: true,
    act_org_id: targetOrg,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);

  ok(res, { token, org_id: targetOrg, client_id: client.id, name: client.name, expires_in: ttlSeconds });
});

/**
 * POST /api/v1/clients/:id/login-as
 * Super-admin only: log in using the client's stored account credentials
 * (email + encrypted password), authenticating against whichever Supabase
 * project that email routes to, and return a real session for that account.
 * Lets the super-admin "enter" the client's actual account/data (e.g. the live
 * Tata project) with no manual credential entry. The password is decrypted
 * server-side and never returned to the browser.
 */
export const loginAsClientCredentials = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }

  // This route is super_admin-only (see routes), so DON'T gate the lookup by the
  // caller's org — a super-admin whose session is temporarily scoped to another
  // org (acting-as/impersonation) must still be able to find the client. Look it
  // up by id in the current project.
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !client) { notFound(res, 'Client not found'); return; }

  const email = (client as { email?: string }).email;
  // Which environment to enter: the production org, or its staging replica.
  const env = (req.body && (req.body as { env?: string }).env === 'staging') ? 'staging' : 'production';

  // Which Supabase project holds this client's DATA (explicit per-client flag).
  const dataProjectRaw = (client as { data_project_key?: string }).data_project_key;
  const targetProject = (dataProjectRaw && isKnownProject(dataProjectRaw)) ? dataProjectRaw : currentProjectKey();
  const remote = adminClientFor(targetProject);

  // Resolve the client's PRODUCTION org in the target project. For a
  // cross-project client that's the linked client's org; else the admin-set
  // "Org ID" or the client's own org.
  let prodOrg: string | null = null;
  const dataClientId = (client as { data_client_id?: string }).data_client_id;
  if (dataClientId && isUUID(dataClientId)) {
    const { data: lc } = await remote.from('clients').select('org_id').eq('id', dataClientId).maybeSingle();
    prodOrg = (lc as { org_id?: string } | null)?.org_id ?? null;
  }
  if (!prodOrg) {
    const loginOrg = (client as { login_org_id?: string }).login_org_id;
    prodOrg = (typeof loginOrg === 'string' && isUUID(loginOrg)) ? loginOrg : client.org_id;
  }

  // For staging, resolve the staging replica linked via organisations.promotes_to.
  let targetOrg: string = prodOrg as string;
  if (env === 'staging') {
    const { data: st } = await remote
      .from('organisations').select('id')
      .eq('promotes_to', prodOrg).eq('environment', 'staging').maybeSingle();
    if (!st) { badRequest(res, 'No staging org is configured for this client'); return; }
    targetOrg = (st as { id: string }).id;
  }

  // Same project (same database): enter by impersonating the target org on the
  // existing super-admin session (maybeImpersonate honours X-Org-Id).
  if (targetProject === currentProjectKey()) {
    logger.info(`[Auth] super_admin ${user.id} entering client ${id} ${env} (org ${targetOrg})`);
    ok(res, { mode: 'impersonate', org_id: targetOrg, project: currentProjectKey(), client_id: client.id, name: client.name, env, staging: env === 'staging' });
    return;
  }

  // Cross-project client (data in another Supabase project, e.g. the live Tata
  // account): sign in with the stored creds, then act on the target org.
  const password = decryptSecret((client as { login_password_enc?: string }).login_password_enc);
  if (!email || !password) { badRequest(res, 'This cross-project client needs a stored login email + password.'); return; }
  const cfg = getProjectConfig(targetProject);
  const sb = createSupabaseClient(cfg.url, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: session, error: signInError } = await sb.auth.signInWithPassword({ email, password });
  if (signInError || !session?.session) {
    badRequest(res, `Login failed: ${signInError?.message || 'invalid stored credentials'}`);
    return;
  }

  logger.info(`[Auth] super_admin ${user.id} logged in as client ${id} (${email}) ${env} on project '${targetProject}'`);
  ok(res, {
    mode: 'credentials',
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
    project: targetProject,
    email,
    client_id: client.id,
    name: client.name,
    org_id: targetOrg,
    env,
    staging: env === 'staging',
  });
});

/**
 * Mirror a client's module CEILING into a linked client in ANOTHER Supabase
 * project. The Kinematic client record is the source of truth for the MAXIMUM
 * modules an org may use; which user gets what within that ceiling stays managed
 * inside the target org. Unchecked (decommissioned) modules are stripped from
 * the target client AND its users so they disappear there immediately.
 */
async function syncCeilingToLinkedProject(opts: {
  projectKey: string;
  targetClientId: string;
  ceilingModules: string[];
  grantedBy: string;
}): Promise<void> {
  const remote = adminClientFor(opts.projectKey);

  // Validate against the TARGET project's module catalog.
  const { data: cat } = await remote.from('modules').select('id');
  const valid = new Set((cat || []).map((m: { id: string }) => m.id));
  const ceiling = opts.ceilingModules.filter(m => valid.has(m));

  // Replace the target client's module ceiling.
  await remote.from('client_modules').delete().eq('client_id', opts.targetClientId);
  if (ceiling.length) {
    await remote.from('client_modules').insert(ceiling.map(m => ({
      client_id: opts.targetClientId,
      module_id: m,
      enabled: true,
      source: 'platform_ceiling',
      granted_by: opts.grantedBy,
    })));
  }

  // Decommission: drop any per-user permission no longer in the ceiling so an
  // unchecked module vanishes for every user. Per-user grants WITHIN the ceiling
  // are left untouched (the org decides who gets what).
  const { data: tUsers } = await remote.from('users').select('id').eq('client_id', opts.targetClientId);
  const ids = (tUsers || []).map((u: { id: string }) => u.id);
  if (ids.length) {
    let del = remote.from('user_module_permissions').delete().in('user_id', ids);
    if (ceiling.length) del = del.not('module_id', 'in', `(${ceiling.map(m => `"${m}"`).join(',')})`);
    await del;
  }

  clearEntitlementCache(opts.targetClientId);
}

/**
 * PATCH /api/v1/clients/:id
 * Admin only: Update client details and module access
 */
export const updateClient = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { name, contact_person, email, phone, is_active, password, modules, user_id, login_org_id, data_project_key, data_client_id, max_active_users } = req.body;

  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }
  // 1. Update Core Client Details
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .update({
      name,
      contact_person,
      email,
      phone,
      is_active,
      // "Org ID" the Login button targets; empty clears it. Non-default only.
      ...(orgPerClient() && login_org_id !== undefined
        ? { login_org_id: (typeof login_org_id === 'string' && isUUID(login_org_id)) ? login_org_id : null }
        : {}),
      // Cross-project link: which Supabase project + client holds this org's
      // real data, so the module ceiling here syncs there. Non-default only.
      ...(orgPerClient() && data_project_key !== undefined
        ? { data_project_key: (typeof data_project_key === 'string' && isKnownProject(data_project_key)) ? data_project_key : null }
        : {}),
      ...(orgPerClient() && data_client_id !== undefined
        ? { data_client_id: (typeof data_client_id === 'string' && isUUID(data_client_id)) ? data_client_id : null }
        : {}),
      // Update the encrypted "Login as" password only when a new one is given
      // (blank on edit = leave unchanged).
      ...(orgPerClient() && password ? { login_password_enc: encryptSecret(password) } : {}),
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .eq(ownerColumn(), user.org_id)
    .select()
    .single();

  if (error) {
    badRequest(res, `Client update failed: ${error.message}`);
    return;
  }

  if (!client) {
    notFound(res, 'Client not found or insufficient permissions');
    return;
  }

  // 2. Handle Password Update (if provided)
  if (password && email) {
    const { data: adminUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('client_id', id)
      .eq('role', 'client')
      .maybeSingle();

    if (adminUser) {
      const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(adminUser.id, { 
        password,
        user_metadata: { name: contact_person || name }
      });
      if (authErr) console.error('Client password update error:', authErr.message);
    }
  }

  // 3. Sync Module Access (Organization Level)
  if (modules && Array.isArray(modules)) {
    // Hardening: Filter modules against what actually exists in the 'modules' table 
    // to prevent foreign key violations from legacy or invalid IDs.
    const { data: validModules } = await supabaseAdmin.from('modules').select('id');
    const validIds = new Set((validModules || []).map(m => m.id));
    const filteredModules = modules.filter(m => validIds.has(m));

    // Replace the whole client_modules set for this client.
    await supabaseAdmin.from('client_modules').delete().eq('client_id', id);
    if (filteredModules.length > 0) {
      const accessPayload = filteredModules.map(m => ({
        client_id: id,
        module_id: m,
        enabled: true,
        source: 'manual',
        granted_by: user.id,
      }));
      console.log(`[DEBUG] Syncing ${accessPayload.length} modules for client ${id}:`, JSON.stringify(filteredModules));
      const { error: accessErr } = await supabaseAdmin.from('client_modules').insert(accessPayload);
      if (accessErr) {
        badRequest(res, `Failed to save client entitlements: ${accessErr.message}`);
        return;
      }
    }
    clearEntitlementCache(id);

    // 4. Sync User-Level Permissions for ALL Client Administrators/Users
    const { data: clientUsers } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('client_id', id)
      .eq('role', 'client');

    if (clientUsers && clientUsers.length > 0) {
      const allUserIds = clientUsers.map(u => u.id);
      
      // Delete old permissions for all these users
      await supabaseAdmin.from('user_module_permissions').delete().in('user_id', allUserIds);
      
      if (filteredModules.length > 0) {
        const userPermissionsPayload = allUserIds.flatMap(uid => 
          filteredModules.map(m => ({ user_id: uid, module_id: m }))
        );
        console.log(`[DEBUG] Syncing ${userPermissionsPayload.length} user-level perms for ${allUserIds.length} users.`);
        await supabaseAdmin.from('user_module_permissions').insert(userPermissionsPayload);
      }
    }
  }

  // 5. Cross-project ceiling sync: if this client is linked to a client in
  // another Supabase project (e.g. Tata Tiscon -> the live Kaiyo client), push
  // the module ceiling there. Failure here must not fail the local save.
  if (modules && Array.isArray(modules)) {
    const dataProject = (client as { data_project_key?: string }).data_project_key;
    const dataClientId = (client as { data_client_id?: string }).data_client_id;
    if (dataProject && isKnownProject(dataProject) && dataProject !== currentProjectKey()
        && dataClientId && isUUID(dataClientId)) {
      try {
        await syncCeilingToLinkedProject({
          projectKey: dataProject,
          targetClientId: dataClientId,
          ceilingModules: modules,
          grantedBy: user.id,
        });
        logger.info(`[Clients] synced module ceiling ${id} -> ${dataProject}/${dataClientId} (${modules.length})`);
      } catch (e: any) {
        logger.error(`[Clients] cross-project ceiling sync failed for ${id} -> ${dataProject}/${dataClientId}: ${e?.message || e}`);
      }
    }
  }

  // Per-org active-user cap (optional; only when the field was sent).
  let capOut: number | null = (client as { max_active_users?: number | null }).max_active_users ?? null;
  if (max_active_users !== undefined) {
    capOut = parseUserCap(max_active_users);
    try { await writeUserCap(client, capOut); }
    catch (e: any) { logger.warn(`[Clients] user-cap write failed for ${id}: ${e?.message || e}`); }
  }

  ok(res, { ...client, modules: modules || [], max_active_users: capOut });
});

/**
 * DELETE /api/v1/clients/:id
 * Admin only: Delete a client (soft delete or hard delete based on preference)
 * For safety, we'll do hard delete here as per system design
 */
export const deleteClient = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;

  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }
  const { error } = await supabaseAdmin
    .from('clients')
    .delete()
    .eq('id', id)
    .eq(ownerColumn(), user.org_id);

  if (error) {
    badRequest(res, error.message);
    return;
  }

  ok(res, { deleted: true });
});

/**
 * GET /api/v1/clients/:id/modules
 * Returns the effective enabled modules for a client (universal + client-grant + org-grant).
 */
export const getClientModules = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }

  const { data, error } = await supabaseAdmin
    .from('v_client_enabled_modules')
    .select('module_id, package, is_universal, sort_order, source')
    .eq('client_id', id)
    .order('package')
    .order('sort_order');

  if (error) { badRequest(res, error.message); return; }

  const enabled_modules = (data || []).map(r => r.module_id);
  const enabled_packages = Array.from(new Set((data || []).map(r => r.package).filter(Boolean) as string[]));
  ok(res, { client_id: id, enabled_modules, enabled_packages, rows: data });
});

/**
 * POST /api/v1/clients/:id/packages
 * Body: { packages: ['field_force','crm', ...], replace?: boolean }
 * Grants every module in the listed packages to a client. If replace=true,
 * removes any existing manual/inferred grants for OTHER packages first.
 */
export const grantClientPackages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { packages, replace } = req.body as { packages?: string[]; replace?: boolean };

  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }
  if (!Array.isArray(packages) || packages.length === 0) {
    badRequest(res, 'packages[] is required');
    return;
  }

  const allowed = new Set(['field_force', 'distribution', 'crm', 'business', 'system', 'people', 'audit']);
  const filtered = packages.filter(p => allowed.has(p));
  if (filtered.length === 0) { badRequest(res, 'No valid packages provided'); return; }

  const { data: modulesInPkg, error: modErr } = await supabaseAdmin
    .from('modules')
    .select('id, package, is_universal')
    .in('package', filtered);
  if (modErr) { badRequest(res, modErr.message); return; }

  // Universal modules don't need a row; they're auto-enabled. Filter them out.
  const grantable = (modulesInPkg || []).filter(m => !m.is_universal);

  if (replace) {
    // Remove every non-universal grant outside the requested packages
    const keepIds = new Set(grantable.map(m => m.id));
    const { data: existing } = await supabaseAdmin
      .from('client_modules')
      .select('module_id')
      .eq('client_id', id);
    const toRemove = (existing || []).filter(r => !keepIds.has(r.module_id)).map(r => r.module_id);
    if (toRemove.length > 0) {
      await supabaseAdmin
        .from('client_modules')
        .delete()
        .eq('client_id', id)
        .in('module_id', toRemove);
    }
  }

  if (grantable.length > 0) {
    const payload = grantable.map(m => ({
      client_id: id,
      module_id: m.id,
      enabled: true,
      source: 'package_grant',
      granted_by: user.id,
    }));
    const { error: upErr } = await supabaseAdmin
      .from('client_modules')
      .upsert(payload, { onConflict: 'client_id,module_id' });
    if (upErr) { badRequest(res, upErr.message); return; }
  }

  clearEntitlementCache(id);
  ok(res, { client_id: id, granted_packages: filtered, granted_modules: grantable.length });
});

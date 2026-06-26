import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, isUUID } from '../utils';
import { isDemo, getMockClients } from '../utils/demoData';
import { clearEntitlementCache } from '../lib/entitlements';
import { currentProjectKey, DEFAULT_PROJECT, projectHs256Key } from '../lib/projects';
import { SignJWT } from 'jose';

// Tata (default project) keeps the legacy single-org model: a client lives in
// the admin's own org and is scoped by `org_id`. Non-default projects (e.g.
// Kinematic) use parent-owns-sub-orgs: each client gets its OWN org for true
// data isolation, and the parent org that owns/manages it is recorded in
// `owner_org_id`. We ONLY reference owner_org_id for non-default projects, so
// Tata's schema (which has no such column) is never touched.
const orgPerClient = () => currentProjectKey() !== DEFAULT_PROJECT;
const ownerColumn = () => (orgPerClient() ? 'owner_org_id' : 'org_id');

function orgSlug(name: string): string {
  const base = (name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
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
  const results = (data || []).map(client => ({
    ...client,
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
  const { name, contact_person, email, phone, modules, password } = req.body;

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

  created(res, { ...client, modules: modules || [] });
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
    .select('id, name, org_id')
    .eq('id', id)
    .eq(ownerColumn(), user.org_id)
    .single();
  if (error || !client) { notFound(res, 'Client not found'); return; }

  const key = projectHs256Key(currentProjectKey());
  if (!key) { badRequest(res, 'Impersonation is not available for this project (no shared JWT secret configured)'); return; }

  const ttlSeconds = 60 * 60; // 1 hour
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    role: 'authenticated',
    email: (user as { email?: string }).email,
    act: true,
    act_org_id: client.org_id,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);

  ok(res, { token, org_id: client.org_id, client_id: client.id, name: client.name, expires_in: ttlSeconds });
});

/**
 * PATCH /api/v1/clients/:id
 * Admin only: Update client details and module access
 */
export const updateClient = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { name, contact_person, email, phone, is_active, password, modules, user_id } = req.body;

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

  ok(res, { ...client, modules: modules || [] });
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

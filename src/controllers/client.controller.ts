import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, isUUID } from '../utils';

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
    .eq('org_id', user.org_id)
    .order('name');

  if (error) {
    badRequest(res, error.message);
    return;
  }

  // Fetch module access for each client
  const clientIds = (data || []).map(c => c.id);
  const { data: accessData } = await supabaseAdmin
    .from('client_module_access')
    .select('*')
    .in('client_id', clientIds);

  const results = (data || []).map(client => ({
    ...client,
    modules: (accessData || [])
      .filter(a => a.client_id === client.id)
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

  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .insert({
      org_id: user.org_id,
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
        org_id: user.org_id,
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
      module_id: m
    }));
    await supabaseAdmin.from('client_module_access').insert(accessPayload);

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
    .eq('org_id', user.org_id)
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

    // We'll do this as a single sequence of delete and insert
    await supabaseAdmin.from('client_module_access').delete().eq('client_id', id);
    if (filteredModules.length > 0) {
      const accessPayload = filteredModules.map(m => ({ client_id: id, module_id: m }));
      console.log(`[DEBUG] Syncing ${accessPayload.length} modules for client ${id}:`, JSON.stringify(filteredModules));
      const { error: accessErr } = await supabaseAdmin.from('client_module_access').insert(accessPayload);
      if (accessErr) {
        badRequest(res, `Failed to save organizational module access: ${accessErr.message}`);
        return;
      }
    }

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
    .eq('org_id', user.org_id);

  if (error) {
    badRequest(res, error.message);
    return;
  }

  ok(res, { deleted: true });
});

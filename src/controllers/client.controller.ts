import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound } from '../utils';

/**
 * GET /api/v1/clients
 * Admin only: List all clients for the organization
 */
export const getClients = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
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

  // Create an initial user for this client if password/email provided
  if (password && email) {
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: contact_person || name, role: 'client' },
    });

    if (authErr) {
      // If user already exists in Auth, we'll try to find them or just report error
      console.error('Auth creation error:', authErr.message);
    } else {
      await supabaseAdmin.from('users').insert({
        id: authData.user.id,
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
  const { name, contact_person, email, phone, is_active, modules } = req.body;

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
    badRequest(res, error.message);
    return;
  }

  if (!client) {
    notFound(res, 'Client not found');
    return;
  }

  // Sync module access if provided
  if (modules && Array.isArray(modules)) {
    await supabaseAdmin.from('client_module_access').delete().eq('client_id', id);
    if (modules.length > 0) {
      const accessPayload = modules.map(m => ({
        client_id: id,
        module_id: m
      }));
      await supabaseAdmin.from('client_module_access').insert(accessPayload);
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

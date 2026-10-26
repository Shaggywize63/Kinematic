import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, isUUID } from '../utils';
import { isDemo, getMockClients } from '../utils/demoData';
import { clearEntitlementCache } from '../lib/entitlements';
import { clearClientFlagCache } from '../lib/clientFlags';
import { currentProjectKey, projectHs256Key, getProjectConfig, isKnownProject, adminClientFor, clearEmailProjectCache } from '../lib/projects';
import { SignJWT } from 'jose';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { encryptSecret, decryptSecret } from '../lib/secretBox';
import { logger } from '../lib/logger';
import { readOrgSettings, writeOrgSettings } from '../services/notificationPolicy';
import { cleanAppUiForStore } from '../lib/appItems';
import { financeCustomerIdOf, readSeatCap, countActiveUsers, nextUnpaidInvoice, countActiveUsersByOrg, nextUnpaidInvoicesByCustomer, type NextPayment } from '../services/clientBilling.service';
import { sendClientWelcome, sendClientPaymentReminder } from '../services/clientEmails.service';

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

// Cross-org control-plane allow-list. By DEFAULT the Client Management list is
// org-scoped for EVERY role (a super-admin sees only the clients their own home
// org owns), which preserves per-tenant isolation. A short allow-list of named
// platform super-admins is exempt: their list surfaces every live client across
// all orgs so one login can see and "Login as" every tenant they manage (e.g.
// sagar@… manages SRS + PASA + BMW, which sit under three different orgs). This
// is an explicit allow-list — NOT "any super_admin" — so adding a client-tenant
// super-admin never leaks other tenants' clients to them. Override the default
// membership with the CROSS_ORG_SUPERADMIN_EMAILS env var (comma-separated,
// case-insensitive); the built-in default covers the current platform admins so
// the feature works without an env change.
const CROSS_ORG_SUPERADMIN_EMAILS = new Set(
  (process.env.CROSS_ORG_SUPERADMIN_EMAILS || 's@kinematicapp.com,sagar@horizontechstudio.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
);
const seesAllClients = (user: { role?: string | null; email?: string | null }): boolean =>
  (user.role || '').toLowerCase() === 'super_admin'
  && CROSS_ORG_SUPERADMIN_EMAILS.has((user.email || '').trim().toLowerCase());

function orgSlug(name: string): string {
  const base = (name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalise a trial-period input ({ start_date, days }) into the record stored
 * on clients.settings.trial, with a SERVER-computed end_date (start date plus
 * `days` calendar days) so the UI's auto-calculated end can't be spoofed.
 * Returns null for a missing / invalid / non-positive input, which the caller
 * uses to clear an existing trial record.
 */
function computeTrial(input: unknown): { start_date: string; days: number; end_date: string } | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as { start_date?: unknown; days?: unknown };
  const start = typeof o.start_date === 'string' ? o.start_date.slice(0, 10) : '';
  const days = Math.round(Number(o.days));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(days) || days <= 0) return null;
  const d = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return { start_date: start, days, end_date: d.toISOString().slice(0, 10) };
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

/** Active, non-staff user counts per client (batched for same-project, per-link for cross-project). */
async function readActiveCounts(clients: Array<{ id: string; org_id?: string; data_project_key?: string; data_client_id?: string }>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const isCross = (c: { data_project_key?: string; data_client_id?: string }) =>
    !!(orgPerClient() && c.data_project_key && isKnownProject(c.data_project_key)
      && c.data_project_key !== currentProjectKey() && c.data_client_id && isUUID(c.data_client_id));
  const same = clients.filter((c) => !isCross(c));
  const orgIds = Array.from(new Set(same.map((c) => c.org_id).filter(Boolean))) as string[];
  if (orgIds.length) {
    const byOrg = await countActiveUsersByOrg(supabaseAdmin, orgIds);
    same.forEach((c) => { out[c.id] = (c.org_id && byOrg[c.org_id]) || 0; });
  }
  for (const c of clients.filter(isCross)) {
    try { const { admin, orgId } = await resolveCapTarget(c); out[c.id] = orgId ? await countActiveUsers(admin, orgId) : 0; }
    catch { out[c.id] = 0; }
  }
  return out;
}

/** The next unpaid invoice per client linked to a finance customer (batched by the managing org). */
async function readNextPayments(clients: Array<Record<string, any>>, user: { org_id?: string }): Promise<Record<string, NextPayment | null>> {
  const out: Record<string, NextPayment | null> = {};
  const linked = clients
    .map((c) => ({ c, cust: financeCustomerIdOf(c) }))
    .filter((x): x is { c: Record<string, any>; cust: string } => !!x.cust);
  if (!linked.length) return out;
  const byOrg = new Map<string, Array<{ c: Record<string, any>; cust: string }>>();
  for (const x of linked) {
    const org = managingOrgId(x.c, user);
    if (!org) continue;
    const g = byOrg.get(org);
    if (g) g.push(x); else byOrg.set(org, [x]);
  }
  for (const [org, group] of byOrg) {
    const map = await nextUnpaidInvoicesByCustomer(org, Array.from(new Set(group.map((x) => x.cust))));
    for (const x of group) out[x.c.id] = map[x.cust] ?? null;
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

  // Allow-listed platform super-admins (see CROSS_ORG_SUPERADMIN_EMAILS) operate
  // the whole control plane: they can already "Login as" ANY org (maybeImpersonate
  // has no allow-list), so their client list surfaces EVERY live client across all
  // orgs — not only the ones their own home org owns. Without this a super-admin
  // whose home org owns a single tenant (e.g. sagar@…, owner_org of SRS only)
  // could never see or switch into the other tenants they manage (BMW, PASA),
  // whose owner_org_id is the Kinematic parent org. EVERYONE else — including
  // non-allow-listed super-admins — stays scoped to the clients their own org
  // owns, so per-tenant isolation is unchanged for them.
  let query = supabaseAdmin
    .from('clients')
    .select('*')
    .order('name');
  if (!seesAllClients(user)) query = query.eq(ownerColumn(), user.org_id);
  const { data, error } = await query;

  if (error) {
    badRequest(res, error.message);
    return;
  }

  // Exclude soft-deleted clients (settings.deleted_at is set). Hard delete is
  // blocked by FK constraints from activities/leads/etc., so deletion is a
  // soft-delete that flags the row; the list must hide flagged rows.
  const liveClients = (data || []).filter(
    (c) => !(c as { settings?: { deleted_at?: unknown } | null }).settings?.deleted_at
  );

  // Fetch module entitlements for each client (excludes universal modules,
  // which are always-on via the v_client_enabled_modules view).
  const clientIds = liveClients.map(c => c.id);
  const { data: accessData } = await supabaseAdmin
    .from('client_modules')
    .select('client_id, module_id, enabled, expires_at')
    .in('client_id', clientIds)
    .eq('enabled', true);

  const now = Date.now();
  // Per-org active-user caps (from the org holding each client's users), the live active-user count,
  // and the next unpaid invoice for clients linked to a finance customer — so the Client Management
  // list can show seat usage and the next payment date per row without a round-trip per client.
  const caps = await readUserCaps(liveClients as Array<{ id: string; org_id?: string; data_project_key?: string; data_client_id?: string }>);
  const activeCounts = await readActiveCounts(liveClients as Array<{ id: string; org_id?: string; data_project_key?: string; data_client_id?: string }>);
  const nextPayments = await readNextPayments(liveClients as Array<Record<string, any>>, user);
  const results = liveClients.map(client => ({
    ...client,
    max_active_users: caps[client.id] ?? null,
    active_users: activeCounts[client.id] ?? 0,
    next_payment: nextPayments[client.id] ?? null,
    modules: (accessData || [])
      .filter(a => a.client_id === client.id
        && (!a.expires_at || new Date(a.expires_at).getTime() > now))
      .map(a => a.module_id)
  }));

  ok(res, results);
});

/**
 * Default entitlement for a brand-new client when the caller doesn't pass an
 * explicit `modules` list: the whole CRM package (non-universal modules whose
 * package = 'crm'). This prevents the "no grants → universal-modules-only →
 * every client-scoped user is locked out of CRM" trap that blocked the SRS
 * sub-admins on Tata Tiscon. An explicit `modules` list always wins over this.
 */
async function defaultClientModuleIds(): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('modules')
    .select('id')
    .eq('package', 'crm')
    .eq('is_universal', false);
  return (data || []).map((m) => m.id as string);
}

/**
 * Mirror a client's module grants into the legacy per-user `user_module_permissions`
 * table for EVERY user of the client — not just the `role='client'` owner. The
 * client-level entitlement is what actually gates access, but keeping the
 * per-user fallback in sync for sub_admins and other roles means "module access
 * as per assigned modules" holds no matter which code path reads it.
 */
async function syncClientUserModulePermissions(clientId: string, moduleIds: string[]): Promise<void> {
  const { data: clientUsers } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('client_id', clientId);
  const userIds = (clientUsers || []).map((u) => u.id);
  if (userIds.length === 0) return;

  // Replace the whole set for these users.
  await supabaseAdmin.from('user_module_permissions').delete().in('user_id', userIds);
  if (moduleIds.length === 0) return;
  const payload = userIds.flatMap((uid) => moduleIds.map((m) => ({ user_id: uid, module_id: m })));
  await supabaseAdmin.from('user_module_permissions').insert(payload);
}

/**
 * POST /api/v1/clients
 * Admin only: Create a new client
 */
export const createClient = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { name, contact_person, email, phone, modules, password, login_org_id, data_project_key, data_client_id, max_active_users, trial, finance_customer_id } = req.body;

  if (!name) {
    badRequest(res, 'Client name is required');
    return;
  }

  // Optional trial-period record set at creation time ({ start_date, days });
  // end_date is computed server-side. Stored under clients.settings.trial.
  const trialRec = computeTrial(trial);

  // Optional billing link: the finance customer this client is invoiced as, so
  // Client Management can surface the next unpaid invoice's due date/amount.
  // Stored under clients.settings.billing.finance_customer_id.
  const initialSettings: Record<string, unknown> = {};
  if (trialRec) initialSettings.trial = trialRec;
  if (typeof finance_customer_id === 'string' && isUUID(finance_customer_id)) {
    initialSettings.billing = { finance_customer_id };
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
      // Trial-period record and/or billing link (optional), stored on settings
      // so no schema change.
      ...(Object.keys(initialSettings).length ? { settings: initialSettings } : {}),
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

  // Auto-populate the CRM location master (36 states + major cities) for the
  // new client's dedicated org so the lead-form State/City picker works out of
  // the box. Idempotent (crm_seed_indian_locations upserts) and best-effort —
  // a seed failure must never fail client creation. Skipped for default-project
  // (Tata) clients, which share an already-seeded org.
  if (orgPerClient()) {
    try {
      await supabaseAdmin.rpc('crm_seed_indian_locations', { p_org_id: clientOrgId });
    } catch (e: any) {
      logger.warn(`[Clients] location seed failed for org ${clientOrgId}: ${e?.message || e}`);
    }
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

  // Module access. An explicit `modules` list wins; otherwise a new client
  // defaults to the CRM package so its users aren't locked out of everything
  // but the universal modules (the trap that blocked the SRS sub-admins).
  const requestedModules: string[] = (modules && Array.isArray(modules) && modules.length > 0)
    ? modules
    : await defaultClientModuleIds();

  // Filter against real module ids to prevent FK violations from bad input.
  const { data: validModules } = await supabaseAdmin.from('modules').select('id');
  const validIds = new Set((validModules || []).map((m) => m.id));
  const grantedModules = requestedModules.filter((m) => validIds.has(m));

  if (grantedModules.length > 0) {
    const accessPayload = grantedModules.map((m) => ({
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

    // Propagate to per-user permissions for ALL client users (at create time
    // that's just the owner, but the helper stays correct as users are added).
    await syncClientUserModulePermissions(client.id, grantedModules);
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
 * Dedicated per-client Supabase projects were created through supabase.com's Management API. Everything now runs on
 * the self-hosted stack in AWS, so that flow no longer exists; the two routes stay so an older dashboard build that
 * still asks gets a clear answer (preflight says "not available", which hides its "dedicated project" toggle).
 */
const PROVISIONING_RETIRED = 'Dedicated per-client project provisioning was retired with the move to AWS.';

/** GET /api/v1/clients/provision/preflight — super-admin only. */
export const provisionPreflight = asyncHandler(async (_req: AuthRequest, res: Response) => {
  ok(res, { ok: false, reason: PROVISIONING_RETIRED });
});

/** POST /api/v1/clients/provision — super-admin only. */
export const provisionClientHandler = asyncHandler(async (_req: AuthRequest, res: Response) => {
  res.status(410).json({ success: false, error: PROVISIONING_RETIRED });
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
  const { name, contact_person, email, phone, is_active, password, modules, user_id, login_org_id, data_project_key, data_client_id, max_active_users, app_ui, trial, finance_customer_id } = req.body;

  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }
  // 1. Update Core Client Details
  let updateQ = supabaseAdmin
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
    .eq('id', id);
  // Allow-listed cross-org super-admins (seesAllClients) may edit a client their
  // own org does not own — e.g. sagar editing PASA / BMW. Everyone else stays
  // scoped to owner_org. Without this exemption the owner-scoped UPDATE matched
  // 0 rows and `.single()` threw "JSON object requested, multiple (or no) rows
  // returned" — the Edit Client save error for a cross-org tenant.
  if (!seesAllClients(user)) updateQ = updateQ.eq(ownerColumn(), user.org_id);
  const { data: client, error } = await updateQ.select().single();

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

    // 4. Mirror the grant into per-user permissions for EVERY user of the client
    // (not just the role='client' owner) so sub_admins and other roles stay in
    // sync with the assigned modules.
    await syncClientUserModulePermissions(id, filteredModules);
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

  // 6. Per-client settings extras stored on clients.settings:
  //    - app_ui: which mobile nav items are shown (read on /auth/me).
  //    - trial:  the client's trial-period record ({ start_date, days, end_date }),
  //              control-plane metadata for Client Management. end_date is
  //              recomputed server-side so the UI's auto-calc can't be spoofed.
  //    Both live in the SAME jsonb, so they're merged in ONE write — two separate
  //    settings updates would each read the pre-update row and clobber the other.
  let appUiOut: any = ((client as { settings?: any }).settings || {})?.app_ui ?? null;
  let trialOut: any = ((client as { settings?: any }).settings || {})?.trial ?? null;
  const hasAppUi = app_ui !== undefined && app_ui !== null && typeof app_ui === 'object' && !Array.isArray(app_ui);
  const settingsExtras: Record<string, unknown> = {};
  // The layout (drag-and-drop order / bottom-bar placement) is cleaned on the way in: known ids only, no duplicates.
  const appUiToStore = hasAppUi ? cleanAppUiForStore(app_ui) : null;
  if (hasAppUi) settingsExtras.app_ui = appUiToStore;
  if (trial !== undefined) {
    // Sent → set or clear (null when invalid/empty, which removes the record).
    trialOut = computeTrial(trial);
    settingsExtras.trial = trialOut;
  }
  // Billing link (finance customer this client is invoiced as). Sent → set a
  // valid UUID or clear it (null). Merged into any existing billing sub-object.
  if (finance_customer_id !== undefined) {
    const curBilling = (((client as { settings?: { billing?: Record<string, unknown> } }).settings || {}).billing) || {};
    const fid = (typeof finance_customer_id === 'string' && isUUID(finance_customer_id)) ? finance_customer_id : null;
    settingsExtras.billing = { ...curBilling, finance_customer_id: fid };
  }
  if (Object.keys(settingsExtras).length > 0) {
    const curSettings = ((client as { settings?: any }).settings && typeof (client as any).settings === 'object' && !Array.isArray((client as any).settings))
      ? (client as any).settings : {};
    const mergedSettings = { ...curSettings, ...settingsExtras };
    let sUpd = supabaseAdmin.from('clients')
      .update({ settings: mergedSettings }).eq('id', id);
    if (!seesAllClients(user)) sUpd = sUpd.eq(ownerColumn(), user.org_id);
    const { error: sErr } = await sUpd;
    if (sErr) logger.warn(`[Clients] settings write failed for ${id}: ${sErr.message}`);
    else { if (hasAppUi) appUiOut = appUiToStore; clearClientFlagCache(id); }

    // Mirror app_ui ONLY to the linked data project (same idea as the
    // module-ceiling sync) so a client whose /auth/me is served from another
    // project sees it too. Trial is control-plane-only and not mirrored.
    if (hasAppUi) {
      const dataProject = (client as { data_project_key?: string }).data_project_key;
      const dataClientId = (client as { data_client_id?: string }).data_client_id;
      if (dataProject && isKnownProject(dataProject) && dataProject !== currentProjectKey()
          && dataClientId && isUUID(dataClientId)) {
        try {
          const remote = adminClientFor(dataProject);
          const { data: tc } = await remote.from('clients').select('settings').eq('id', dataClientId).maybeSingle();
          const cur = ((tc as any)?.settings && typeof (tc as any).settings === 'object' && !Array.isArray((tc as any).settings)) ? (tc as any).settings : {};
          await remote.from('clients').update({ settings: { ...cur, app_ui: appUiToStore } }).eq('id', dataClientId);
          clearClientFlagCache(dataClientId);
          logger.info(`[Clients] synced app_ui ${id} -> ${dataProject}/${dataClientId}`);
        } catch (e: any) {
          logger.error(`[Clients] app_ui cross-project mirror failed for ${id} -> ${dataProject}/${dataClientId}: ${e?.message || e}`);
        }
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

  ok(res, { ...client, modules: modules || [], max_active_users: capOut, app_ui: appUiOut, trial: trialOut });
});

/**
 * DELETE /api/v1/clients/:id
 * Admin only: Soft-delete a client. The row is flagged (settings.deleted_at)
 * and deactivated rather than hard-deleted, because client_id foreign keys on
 * leads/deals/activities/attendance/etc. have no ON DELETE CASCADE — a hard
 * DELETE both fails on referencing rows and would wipe a tenant's data.
 */
export const deleteClient = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;

  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return; }

  // SOFT delete. A client owns leads, deals, activities, attendance, form
  // submissions, users, route plans, etc. via client_id foreign keys that have
  // no ON DELETE CASCADE, so a hard DELETE (a) fails on the first referencing
  // row — e.g. activities_client_id_fkey — and (b) would irrecoverably wipe an
  // entire tenant's data. Instead mark the client deleted in settings.deleted_at
  // and deactivate it; getClients() filters these out so it disappears from the
  // Client Management list, while all data is preserved and recoverable. A true
  // purge is a separate, deliberate operation.
  let readQ = supabaseAdmin
    .from('clients')
    .select('settings')
    .eq('id', id);
  if (!seesAllClients(user)) readQ = readQ.eq(ownerColumn(), user.org_id);
  const { data: existing, error: readErr } = await readQ.maybeSingle();
  if (readErr) { badRequest(res, readErr.message); return; }
  if (!existing) { notFound(res, 'Client not found'); return; }

  const settings = {
    ...(((existing as { settings?: Record<string, unknown> }).settings) ?? {}),
    deleted_at: new Date().toISOString(),
    deleted_by: user.id,
  };
  let delQ = supabaseAdmin
    .from('clients')
    .update({ settings, is_active: false })
    .eq('id', id);
  if (!seesAllClients(user)) delQ = delQ.eq(ownerColumn(), user.org_id);
  const { error } = await delQ;

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

// ── Notifications per client (Client Management → Notifications) ─────────────────────────────────────────────
// Which of the catalogue's notifications (lib/notificationCatalog.ts) this client receives. Nothing is on by
// default; the setting lands on the org that holds the client's users, exactly like the seat cap above.

async function ownedClientOrg(req: AuthRequest, res: Response): Promise<{ admin: SupabaseClient; orgId: string; project: string } | null> {
  const user = req.user!;
  const { id } = req.params;
  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return null; }
  let q = supabaseAdmin.from('clients').select('id, org_id, data_project_key, data_client_id').eq('id', id);
  if (!seesAllClients(user)) q = q.eq(ownerColumn(), user.org_id);
  const { data: client, error } = await q.maybeSingle();
  if (error) { badRequest(res, error.message); return null; }
  if (!client) { notFound(res, 'Client not found'); return null; }
  const { admin, orgId } = await resolveCapTarget(client as { org_id?: string; data_project_key?: string; data_client_id?: string });
  if (!orgId) { badRequest(res, 'This client has no organisation to configure yet'); return null; }
  const linked = admin !== supabaseAdmin && (client as { data_project_key?: string }).data_project_key;
  return { admin, orgId, project: linked || currentProjectKey() };
}

/** GET /api/v1/clients/:id/notifications — the catalogue with this client's on/off flags. */
export const getClientNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  const target = await ownedClientOrg(req, res);
  if (!target) return;
  ok(res, await readOrgSettings(target.orgId, target.admin, target.project));
});

/** PUT /api/v1/clients/:id/notifications — body { enabled_kinds: string[] } (catalogue kinds, or ["*"] for all). */
export const setClientNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  const target = await ownedClientOrg(req, res);
  if (!target) return;
  try {
    await writeOrgSettings(target.orgId, (req.body ?? {}).enabled_kinds, req.user!.id, target.admin);
  } catch (e: any) {
    badRequest(res, e?.message || 'Could not save notification settings');
    return;
  }
  ok(res, await readOrgSettings(target.orgId, target.admin, target.project));
});

// ── Account & billing (Client Management → Account) ──────────────────────────
// Seat usage (allocated vs active), plus the next payment date/amount pulled
// from the client's next unpaid invoice via the linked finance customer, and
// the two transactional emailers (welcome + payment reminder).

/** Fetch a client the caller may manage (ownership-scoped unless a cross-org operator). */
async function ownedClient(req: AuthRequest, res: Response): Promise<Record<string, any> | null> {
  const user = req.user!;
  const { id } = req.params;
  if (!isUUID(id)) { notFound(res, 'Invalid client ID'); return null; }
  let q = supabaseAdmin.from('clients').select('*').eq('id', id);
  if (!seesAllClients(user)) q = q.eq(ownerColumn(), user.org_id);
  const { data: client, error } = await q.maybeSingle();
  if (error) { badRequest(res, error.message); return null; }
  if (!client) { notFound(res, 'Client not found'); return null; }
  return client as Record<string, any>;
}

/** The org that manages (and invoices) this client — where its finance data lives. */
function managingOrgId(client: Record<string, any>, user: { org_id?: string }): string {
  return String(client[ownerColumn()] || client.org_id || user.org_id || '');
}

/**
 * GET /api/v1/clients/:id/account
 * Seat allocation + live active count, the linked finance customer, and the
 * client's next unpaid invoice (next payment date/amount), if any.
 */
export const getClientAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const client = await ownedClient(req, res);
  if (!client) return;

  const { admin, orgId } = await resolveCapTarget(client as { org_id?: string; data_project_key?: string; data_client_id?: string });
  const allocated = orgId ? await readSeatCap(admin, orgId) : null;
  const active = orgId ? await countActiveUsers(admin, orgId) : 0;

  const financeCustomerId = financeCustomerIdOf(client);
  const nextPayment = financeCustomerId
    ? await nextUnpaidInvoice(managingOrgId(client, user), financeCustomerId)
    : null;

  ok(res, {
    name: client.name,
    contact_person: client.contact_person ?? null,
    contact_email: client.email ?? null,
    allocated,
    active,
    finance_customer_id: financeCustomerId,
    next_payment: nextPayment,
  });
});

/** POST /api/v1/clients/:id/send-welcome — email the client's contact a welcome message. */
export const sendClientWelcomeEmail = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const client = await ownedClient(req, res);
  if (!client) return;

  const to = String(client.email || '').trim();
  if (!to) { badRequest(res, 'This client has no contact email. Add one before sending a welcome email.'); return; }

  try {
    const r = await sendClientWelcome({
      orgId: managingOrgId(client, user), userId: user.id, to,
      data: { clientName: client.name, contactName: client.contact_person },
    });
    const status = (r as { status?: string }).status;
    ok(res, { sent: status !== 'failed', ...r });
  } catch (e: any) {
    badRequest(res, e?.message || 'Could not send the welcome email');
  }
});

/** POST /api/v1/clients/:id/send-payment-reminder — remind the client about their next unpaid invoice. */
export const sendClientPaymentReminderEmail = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const client = await ownedClient(req, res);
  if (!client) return;

  const to = String(client.email || '').trim();
  if (!to) { badRequest(res, 'This client has no contact email. Add one before sending a payment reminder.'); return; }

  const financeCustomerId = financeCustomerIdOf(client);
  if (!financeCustomerId) { badRequest(res, 'Link this client to a finance customer first, so the reminder can reference an invoice.'); return; }

  const invoice = await nextUnpaidInvoice(managingOrgId(client, user), financeCustomerId);
  if (!invoice) { badRequest(res, 'No unpaid invoice found for this client — there is nothing to remind about.'); return; }

  try {
    const r = await sendClientPaymentReminder({
      orgId: managingOrgId(client, user), userId: user.id, to,
      data: { clientName: client.name, contactName: client.contact_person, invoice },
    });
    const status = (r as { status?: string }).status;
    ok(res, { sent: status !== 'failed', invoice, ...r });
  } catch (e: any) {
    badRequest(res, e?.message || 'Could not send the payment reminder');
  }
});

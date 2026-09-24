/**
 * Onboard ByteBack — a FIELD-FORCE-ONLY client under the Kinematic tenant.
 *
 * What ByteBack gets:
 *   - Its own org + a `clients` row owned by the Kinematic parent org, so it
 *     shows up in Client Management for Kinematic.
 *   - 1 manager (designation data_scope='team') + 4 field executives
 *     (data_scope='own'), placeholder emails, NOT city-scoped.
 *   - Field-force module grants EXCEPT route_plan, route_optimization
 *     (outlet priorities ride on this), route_deviation, beat_productivity.
 *   - No CRM package and no KINI (kini_agentic_v2 left unset / off by default),
 *     so the KINI chatbot never appears (it lives only in the CRM shell).
 *
 * Runs against the **kinematic** Supabase project (control plane), never Tata.
 * Idempotent: safe to re-run. Modes: --inspect (default, read-only),
 * --dry-run (resolve + log, no writes), --commit (write).
 *
 * Usage (inside the VPC, backend image):
 *   node dist/tools/onboard-byteback.js --inspect
 *   node dist/tools/onboard-byteback.js --commit
 */
import { randomUUID } from 'crypto';
import { adminClientFor } from '../lib/projects';

const PROJECT = 'kinematic';

// Fixed identifiers so re-runs converge on the same rows.
const BYTEBACK_ORG_ID = '7e3b1c9a-2f44-4a6e-9b1d-0a2b3c4d5e6f';
const BYTEBACK_CLIENT_ID = '9c8d7e6f-5a4b-4c3d-8e1f-0a1b2c3d4e5f';
const ORG_NAME = 'ByteBack';
const ORG_SLUG = 'byteback';

// Placeholder credentials — replace the emails later via User Management.
const TEMP_PASSWORD = 'ByteBack@2026';
const MANAGER = { name: 'ByteBack Manager', email: 'manager@byteback.example', mobile: '' };
const FIELD_USERS = [
  { name: 'ByteBack User 1', email: 'user1@byteback.example', mobile: '' },
  { name: 'ByteBack User 2', email: 'user2@byteback.example', mobile: '' },
  { name: 'ByteBack User 3', email: 'user3@byteback.example', mobile: '' },
  { name: 'ByteBack User 4', email: 'user4@byteback.example', mobile: '' },
];

// Modules ByteBack must NOT get. Outlet priorities ride on route_optimization,
// so omitting it disables them too. All are off-by-default anyway.
const EXCLUDE_MODULES = new Set([
  'route_plan', 'route_optimization', 'route_deviation', 'beat_productivity', 'orders',
]);
// Always ensure these field-force modules are granted if present in the catalog.
const REQUIRE_MODULES = ['attendance', 'activities', 'form_builder'];

const MODE: 'inspect' | 'dry-run' | 'commit' =
  process.argv.includes('--commit') ? 'commit'
  : process.argv.includes('--dry-run') ? 'dry-run'
  : 'inspect';
const dry = MODE !== 'commit';
const db = adminClientFor(PROJECT); // kinematic service-role (bypasses RLS)

function log(...a: unknown[]) { console.log(...a); }

// Resolve the Kinematic parent org that will OWN this client (so it appears in
// Kinematic's Client Management). Prefer an explicit env, else the org named
// "Kinematic", else the most common owner_org_id across existing clients.
async function resolveOwnerOrg(): Promise<string> {
  if (process.env.BYTEBACK_OWNER_ORG) return process.env.BYTEBACK_OWNER_ORG;
  const byName = (await db.from('organisations').select('id,name').ilike('name', '%kinematic%')).data as any[] | null;
  if (byName && byName.length === 1) return byName[0].id;
  const cs = (await db.from('clients').select('owner_org_id').not('owner_org_id', 'is', null)).data as any[] | null;
  if (cs && cs.length) {
    const counts = new Map<string, number>();
    for (const c of cs) counts.set(c.owner_org_id, (counts.get(c.owner_org_id) || 0) + 1);
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (top) return top[0];
  }
  if (byName && byName.length > 1) return byName[0].id;
  throw new Error('Could not resolve Kinematic owner org — set BYTEBACK_OWNER_ORG');
}

// Field-force modules to grant = catalog rows in the field_force package
// (+ the REQUIRE_MODULES) minus the EXCLUDE set. Data-driven so the grant
// tracks whatever FF modules actually exist in the kinematic catalog.
async function resolveGrantModuleIds(): Promise<string[]> {
  const cat = (await db.from('modules').select('id,package,is_universal').limit(1000)).data as any[] | null;
  if (!cat) throw new Error('modules catalog unreadable');
  const grant = new Set<string>();
  for (const m of cat) {
    if (m.is_universal) continue; // universal modules are always on, no grant needed
    if (EXCLUDE_MODULES.has(m.id)) continue;
    if (m.package === 'field_force') grant.add(m.id);
  }
  for (const id of REQUIRE_MODULES) {
    if (EXCLUDE_MODULES.has(id)) continue;
    if (cat.some((m) => m.id === id)) grant.add(id);
  }
  return [...grant].sort();
}

async function ensureLogin(email: string, password: string, name: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name },
  });
  if (!error && data?.user) return data.user.id;
  if (error && error.message.toLowerCase().includes('already')) {
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 } as any);
    const found = list?.users?.find((u: any) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
  }
  throw new Error(`auth createUser ${email}: ${error?.message || 'unknown'}`);
}

async function ensureDesignation(name: string, dataScope: 'own' | 'team' | 'all', position: number, grantIds: string[]): Promise<string> {
  const existing = (await db.from('org_roles').select('id')
    .eq('org_id', BYTEBACK_ORG_ID).eq('name', name).is('deleted_at', null).maybeSingle()).data as any;
  if (existing?.id) return existing.id;
  const id = randomUUID();
  if (!dry) {
    const { error } = await db.from('org_roles').insert({
      id, org_id: BYTEBACK_ORG_ID, client_id: BYTEBACK_CLIENT_ID, name,
      parent_id: null, data_scope: dataScope, position,
      color: dataScope === 'team' ? '#2563eb' : '#6366f1',
      // Hierarchy role drives module access via org_roles.permissions — must list
      // the granted modules or the user's enabled_modules would cap to empty.
      permissions: grantIds, permissions_write: grantIds, assigned_cities: [],
    });
    if (error) throw new Error(`org_roles ${name}: ${error.message}`);
  }
  return id;
}

async function main() {
  log(`[onboard-byteback] mode=${MODE} project=${PROJECT} node_env=${process.env.NODE_ENV}`);

  const ownerOrg = await resolveOwnerOrg();
  const grantIds = await resolveGrantModuleIds();
  log(`owner_org (Kinematic parent) = ${ownerOrg}`);
  log(`modules to grant (${grantIds.length}): ${grantIds.join(', ') || '(none)'}`);
  log(`modules excluded: ${[...EXCLUDE_MODULES].join(', ')}`);

  if (MODE === 'inspect') {
    const existsOrg = (await db.from('organisations').select('id').eq('id', BYTEBACK_ORG_ID).maybeSingle()).data;
    const existsClient = (await db.from('clients').select('id,name').eq('id', BYTEBACK_CLIENT_ID).maybeSingle()).data;
    log(`INSPECT: org ${existsOrg ? 'EXISTS' : 'absent'}, client ${existsClient ? 'EXISTS' : 'absent'}`);
    return;
  }

  log(`\n=== ByteBack onboarding (${dry ? 'DRY-RUN — NO WRITES' : 'COMMIT — WRITING'}) ===`);

  // 1. Organisation
  const orgExists = (await db.from('organisations').select('id').eq('id', BYTEBACK_ORG_ID).maybeSingle()).data;
  log(`1. organisation ${ORG_NAME} (${BYTEBACK_ORG_ID}) — ${orgExists ? 'exists' : 'create'}`);
  if (!dry && !orgExists) {
    const { error } = await db.from('organisations').insert({ id: BYTEBACK_ORG_ID, name: ORG_NAME, slug: ORG_SLUG });
    if (error) throw new Error(`org: ${error.message}`);
  }

  // 2. Client (owned by the Kinematic parent org → shows in Client Management)
  const clientExists = (await db.from('clients').select('id').eq('id', BYTEBACK_CLIENT_ID).maybeSingle()).data;
  log(`2. client ${ORG_NAME} (${BYTEBACK_CLIENT_ID}) owner_org=${ownerOrg} — ${clientExists ? 'exists' : 'create'}`);
  if (!dry && !clientExists) {
    const { error } = await db.from('clients').insert({
      id: BYTEBACK_CLIENT_ID, org_id: BYTEBACK_ORG_ID, owner_org_id: ownerOrg,
      name: ORG_NAME, contact_person: 'ByteBack Manager', email: MANAGER.email, is_active: true,
      settings: {},
    });
    if (error) throw new Error(`client: ${error.message}`);
  }

  // 3. Designations: Manager (team) + Field Executive (own)
  log('3. designations (Manager=team, Field Executive=own)');
  const managerDesig = await ensureDesignation('Manager', 'team', 0, grantIds);
  const feDesig = await ensureDesignation('Field Executive', 'own', 1, grantIds);

  // 4. Users — 1 manager + 4 field executives. role tier 'sub_admin' mirrors the
  //    proven field-force config (PASA); data isolation comes from data_scope.
  log('4. users (1 manager + 4 field executives)');
  const mkUser = async (u: { name: string; email: string; mobile: string }, orgRole: string) => {
    log(`   - ${u.name} <${u.email}> role_desig=${orgRole === managerDesig ? 'Manager' : 'Field Executive'}`);
    if (dry) return;
    const dup = (await db.from('users').select('id').eq('org_id', BYTEBACK_ORG_ID).eq('email', u.email).maybeSingle()).data as any;
    const uid = dup?.id || await ensureLogin(u.email, TEMP_PASSWORD, u.name);
    const { error } = await db.from('users').upsert({
      id: uid, org_id: BYTEBACK_ORG_ID, client_id: BYTEBACK_CLIENT_ID, name: u.name,
      email: u.email, mobile: u.mobile, role: 'sub_admin', org_role_id: orgRole,
      city: null, is_active: true, must_change_password: true,
    }, { onConflict: 'id' });
    if (error) throw new Error(`users ${u.email}: ${error.message}`);
  };
  await mkUser(MANAGER, managerDesig);
  for (const u of FIELD_USERS) await mkUser(u, feDesig);

  // 5. Client modules — grant the FF subset (route/deviation/optimization/beat
  //    excluded above). No CRM package, no KINI.
  log(`5. client_modules (${grantIds.length})`);
  if (!dry && grantIds.length) {
    const payload = grantIds.map((m) => ({ client_id: BYTEBACK_CLIENT_ID, module_id: m, enabled: true, source: 'manual' }));
    const { error } = await db.from('client_modules').upsert(payload, { onConflict: 'client_id,module_id' });
    if (error) throw new Error(`client_modules: ${error.message}`);
  }

  log(`\n=== ${dry ? 'DRY-RUN complete (nothing written)' : 'COMMIT complete'} ===`);
  log(`ByteBack org=${BYTEBACK_ORG_ID} client=${BYTEBACK_CLIENT_ID}`);
  log(`Manager: ${MANAGER.email} · Field users: ${FIELD_USERS.map((u) => u.email).join(', ')} · temp password: ${TEMP_PASSWORD}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[onboard-byteback] FAILED:', e?.message || e); process.exit(1); });

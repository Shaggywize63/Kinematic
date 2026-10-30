/* eslint-disable no-console */
/**
 * Onboard "Bahwancy" — a PLANOGRAM-ONLY client under the KINEMATIC tenant.
 *
 * Bahwancy's field rep gets a deliberately stripped-down app with a single
 * action — "Store audit": pick a store from a DROPDOWN, open the camera, shoot
 * the shelf, submit. The compliance analysis is read back in the dashboard
 * ("the backend"). The store dropdown is populated from the backend store list
 * (GET /api/v1/stores, module-gated on `stores`), and the chosen store tags the
 * capture's store_id — so this client needs BOTH the `planograms` and `stores`
 * modules, and its stores must be populated (Client Management / dashboard).
 * It mirrors the MoiSoi planogram shell but store-backed, not storeless. The
 * app-side single-purpose shell is gated by this client's id (a compile-time
 * constant in Kinematic-App `Entitlements.kt` and Kinematic-iOS
 * `ClientFeatureGates.swift`, mirroring `isMoiSoi`); run this tool in --inspect
 * FIRST to print the real org_id / client_id to wire those gates.
 *
 * ADOPTS an already-created client (operator chose "adopt existing"): the org +
 * client + its existing admin were created in Client Management, so this tool
 * only ADDS what is missing and NEVER touches the existing client admin:
 *   - grants the `planograms` module (client_modules + the role permission list
 *     the dashboard's hasModule() gate reads),
 *   - ensures a "Field Executive" designation (own scope) carrying that grant,
 *   - ensures the paid field seat(s) from the roster,
 *   - labels the app's planogram menu entry "Store audit"
 *     (clients.settings.app_ui.labels.menu.planogram),
 *   - optionally writes a seat cap (only when BAHWANCY_SEAT_LIMIT is set).
 *
 * Runs against the **kinematic** Supabase project (service role), never Tata.
 * Idempotent: safe to re-run. Modes (argv): --inspect (default, read-only),
 * --dry-run (resolve + log, no writes), --commit (write).
 *
 * Secrets come from the environment, never source:
 *   BAHWANCY_SEAT_PASSWORD   temp password for the field seat(s) (required for --commit)
 * Optional:
 *   BAHWANCY_EXPECT_CLIENT_ID / BAHWANCY_EXPECT_ORG_ID  abort unless the client
 *       resolved by name has exactly these ids (a cross-check; never hard-coded)
 *   BAHWANCY_CLIENT_NAME     name to resolve (default "Bahwancy")
 *   BAHWANCY_FIELD_EMAIL     field seat email (default the supplied roster email)
 *   BAHWANCY_FIELD_NAME      field seat display name
 *   BAHWANCY_FIELD_MOBILE    field seat mobile (default a unique placeholder)
 *   BAHWANCY_SEAT_LIMIT      limits.max_active_users to enforce (unset = leave as-is)
 *
 * Usage (inside the VPC, backend image):
 *   node dist/tools/onboard-bahwancy.js --inspect
 *   node dist/tools/onboard-bahwancy.js --commit
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { adminClientFor, isKnownProject } from '../lib/projects';

const PROJECT = 'kinematic';
// Refuse to run if the kinematic project is not configured — adminClientFor()
// would otherwise silently fall back to the `default` (Tata) project and write
// to the wrong database. (Same guard gomant-setup uses.)
if (!isKnownProject(PROJECT)) {
  console.error('[onboard-bahwancy] the "kinematic" Supabase project is not configured (KINEMATIC_SUPABASE_URL / _ANON_KEY / _SERVICE_ROLE_KEY). Refusing to run against the wrong database.');
  process.exit(1);
}
const db = adminClientFor(PROJECT); // kinematic service-role (bypasses RLS)

const MODE: 'inspect' | 'dry-run' | 'commit' =
  process.argv.includes('--commit') ? 'commit'
  : process.argv.includes('--dry-run') ? 'dry-run'
  : 'inspect';
const dry = MODE !== 'commit';

const CLIENT_NAME = (process.env.BAHWANCY_CLIENT_NAME || 'Bahwancy').trim();

// —— roster (operator-supplied) ——
// A single field executive who runs store audits. Name/mobile unknown → derived
// placeholders (fix later in User Management); the email is the one real datum.
const FIELD_EMAIL = (process.env.BAHWANCY_FIELD_EMAIL || 'saalsinaidi93@gmail.com').trim().toLowerCase();
const FIELD_NAME = (process.env.BAHWANCY_FIELD_NAME || 'Bahwancy Field Executive').trim();
// users has a unique (org_id, mobile) constraint, so the seat needs its own value.
const FIELD_MOBILE = (process.env.BAHWANCY_FIELD_MOBILE || '9000000001').trim();

const SEAT_PASSWORD = process.env.BAHWANCY_SEAT_PASSWORD || '';
if (MODE === 'commit' && !SEAT_PASSWORD) {
  console.error('[onboard-bahwancy] set BAHWANCY_SEAT_PASSWORD to run --commit.');
  process.exit(1);
}

// Optional seat cap. Only written when explicitly provided, so an adopted
// client's existing cap is never silently overwritten.
const SEAT_LIMIT_RAW = process.env.BAHWANCY_SEAT_LIMIT;
const SEAT_LIMIT = SEAT_LIMIT_RAW != null && SEAT_LIMIT_RAW !== '' ? Number(SEAT_LIMIT_RAW) : undefined;
if (SEAT_LIMIT !== undefined && (!Number.isInteger(SEAT_LIMIT) || SEAT_LIMIT < 1)) {
  console.error(`[onboard-bahwancy] BAHWANCY_SEAT_LIMIT must be a positive integer (got "${SEAT_LIMIT_RAW}").`);
  process.exit(1);
}

// The modules Bahwancy buys. The planogram routes (/api/v1/planograms) are
// module-gated on `planograms`, so without that grant every capture 403s; the
// "Store audit" store dropdown fetches GET /api/v1/stores, module-gated on
// `stores` (readOpen), so the list is empty/403 without it.
const GRANT_MODULES = ['planograms', 'stores'];
// The app menu entry Bahwancy's rep sees, relabelled from the default "Planogram".
const MENU_ID = 'planogram';
const MENU_LABEL = 'Store audit';

function log(...a: unknown[]) { console.log(...a); }

type ClientRow = { id: string; org_id: string | null; name: string | null; is_active: boolean | null; settings: unknown };
const isPlainObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSoftDeleted = (c: ClientRow) => isPlainObj(c.settings) && !!(c.settings as any).deleted_at;

/** Resolve the already-created Bahwancy client by name. Zero or several live
 *  matches → print the candidates and abort (never guess). Cross-checked
 *  against BAHWANCY_EXPECT_* when set. */
async function resolveClient(): Promise<ClientRow> {
  const { data, error } = await db.from('clients')
    .select('id, org_id, name, is_active, settings')
    .ilike('name', CLIENT_NAME);
  if (error) throw new Error(`clients lookup: ${error.message}`);
  const live = ((data as ClientRow[] | null) || []).filter((c) => !isSoftDeleted(c));
  if (live.length === 0) {
    throw new Error(`no live client named "${CLIENT_NAME}" on the kinematic project. Create it in Client Management first (operator chose "adopt existing").`);
  }
  if (live.length > 1) {
    const lines = live.map((c) => `  - ${c.name} id=${c.id} org=${c.org_id} active=${c.is_active}`).join('\n');
    throw new Error(`several live clients match "${CLIENT_NAME}" — refusing to guess:\n${lines}\nDisambiguate with BAHWANCY_EXPECT_CLIENT_ID.`);
  }
  const client = live[0];
  const expectClient = (process.env.BAHWANCY_EXPECT_CLIENT_ID || '').trim();
  const expectOrg = (process.env.BAHWANCY_EXPECT_ORG_ID || '').trim();
  if (expectClient && client.id !== expectClient) {
    throw new Error(`resolved client ${client.id} != BAHWANCY_EXPECT_CLIENT_ID ${expectClient} — aborting.`);
  }
  if (expectOrg && client.org_id !== expectOrg) {
    throw new Error(`resolved org ${client.org_id} != BAHWANCY_EXPECT_ORG_ID ${expectOrg} — aborting.`);
  }
  if (!client.org_id) throw new Error(`client ${client.id} has no org_id — cannot proceed.`);
  return client;
}

/** Ensure the `planograms` module id exists in the catalog before granting it. */
async function assertModulesExist(ids: string[]): Promise<void> {
  const { data, error } = await db.from('modules').select('id').in('id', ids);
  if (error) throw new Error(`modules catalog: ${error.message}`);
  const have = new Set(((data as { id: string }[] | null) || []).map((m) => m.id));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) throw new Error(`module(s) not in the kinematic catalog: ${missing.join(', ')}`);
}

/** Ensure a designation (org_role) carrying the module grant. Idempotent: an
 *  existing one has its grant unioned in (re-runs pick up new modules). */
async function ensureDesignation(orgId: string, clientId: string, name: string, dataScope: 'own' | 'team' | 'all', position: number, grantIds: string[]): Promise<string> {
  const existing = (await db.from('org_roles').select('id, permissions, permissions_write')
    .eq('org_id', orgId).eq('name', name).is('deleted_at', null).maybeSingle()).data as any;
  if (existing?.id) {
    const merged = Array.from(new Set([...(existing.permissions || []), ...grantIds]));
    const mergedW = Array.from(new Set([...(existing.permissions_write || []), ...grantIds]));
    log(`   designation "${name}" exists (${existing.id}) — union grant`);
    if (!dry) {
      const { error } = await db.from('org_roles').update({ permissions: merged, permissions_write: mergedW }).eq('id', existing.id);
      if (error) throw new Error(`org_roles update ${name}: ${error.message}`);
    }
    return existing.id;
  }
  const id = randomUUID();
  log(`   designation "${name}" — create (${id}) scope=${dataScope}`);
  if (!dry) {
    const { error } = await db.from('org_roles').insert({
      id, org_id: orgId, client_id: clientId, name, parent_id: null, data_scope: dataScope,
      position, color: '#6366f1', permissions: grantIds, permissions_write: grantIds, assigned_cities: [],
    });
    if (error) throw new Error(`org_roles ${name}: ${error.message}`);
  }
  return id;
}

async function ensureLogin(email: string, password: string, name: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
  if (!error && data?.user) return data.user.id;
  if (error && error.message.toLowerCase().includes('already')) {
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 } as any);
    const found = list?.users?.find((u: any) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
  }
  throw new Error(`auth createUser ${email}: ${error?.message || 'unknown'}`);
}

/** Merge clients.settings.app_ui.labels.menu.<MENU_ID> = <MENU_LABEL>, preserving
 *  every other settings key. Refuses to touch a malformed settings/app_ui blob. */
async function ensureMenuLabel(clientId: string): Promise<void> {
  const { data, error } = await db.from('clients').select('settings').eq('id', clientId).maybeSingle();
  if (error) throw new Error(`settings read: ${error.message}`);
  const cur = (data as any)?.settings;
  if (cur != null && !isPlainObj(cur)) throw new Error('clients.settings is not a JSON object — fix it by hand first.');
  const settings: Record<string, unknown> = isPlainObj(cur) ? JSON.parse(JSON.stringify(cur)) : {};
  const appUi = settings.app_ui;
  if (appUi != null && !isPlainObj(appUi)) throw new Error('clients.settings.app_ui is not an object — fix it in Client Management first.');
  const ui: Record<string, unknown> = isPlainObj(appUi) ? { ...appUi } : {};
  const labels = isPlainObj(ui.labels) ? { ...(ui.labels as Record<string, unknown>) } : {};
  const menuLabels = isPlainObj(labels.menu) ? { ...(labels.menu as Record<string, unknown>) } : {};
  const already = menuLabels[MENU_ID];
  if (already === MENU_LABEL) { log(`   app_ui.labels.menu.${MENU_ID} already = "${MENU_LABEL}"`); return; }
  log(`   app_ui.labels.menu.${MENU_ID}: ${already === undefined ? '(unset)' : JSON.stringify(already)} → "${MENU_LABEL}"`);
  menuLabels[MENU_ID] = MENU_LABEL;
  labels.menu = menuLabels;
  ui.labels = labels;
  settings.app_ui = ui;
  if (!dry) {
    const { error: upErr } = await db.from('clients').update({ settings }).eq('id', clientId);
    if (upErr) throw new Error(`settings write: ${upErr.message}`);
  }
}

async function main() {
  log(`[onboard-bahwancy] mode=${MODE} project=${PROJECT} node_env=${process.env.NODE_ENV || '(unset)'}`);
  const client = await resolveClient();
  const orgId = client.org_id as string;
  const clientId = client.id;
  log(`resolved client "${client.name}"  org_id=${orgId}  client_id=${clientId}  active=${client.is_active}`);
  log(`>>> wire these two ids into the app gates (isBahwancy in Entitlements.kt / ClientFeatureGates.swift) <<<`);

  // Existing seats + admins (so inspect shows what "adopt" is adopting).
  const users = (await db.from('users').select('id,name,email,role,is_active,org_role_id').eq('client_id', clientId)).data as any[] | null;
  log(`existing users on client (${users?.length || 0}):`);
  for (const u of users || []) log(`   - ${u.name} <${u.email}> role=${u.role} active=${u.is_active}`);

  // Current module grants + seat cap (reported always).
  const mods = (await db.from('client_modules').select('module_id,enabled').eq('client_id', clientId)).data as any[] | null;
  log(`current client_modules (${mods?.length || 0}): ${(mods || []).map((m) => `${m.module_id}${m.enabled ? '' : '(off)'}`).join(', ') || '(none)'}`);
  const cap = (await db.from('org_settings').select('value').eq('org_id', orgId).eq('key', 'limits.max_active_users').maybeSingle()).data as any;
  log(`current seat cap (limits.max_active_users): ${cap ? cap.value : '(unset)'}`);

  if (MODE === 'inspect') {
    log('\nINSPECT only — no writes. Re-run with --dry-run to preview writes, --commit to apply.');
    return;
  }

  log(`\n=== Bahwancy onboarding (${dry ? 'DRY-RUN — NO WRITES' : 'COMMIT — WRITING'}) ===`);

  // 1. module catalog sanity + grant
  await assertModulesExist(GRANT_MODULES);
  log(`1. client_modules grant: ${GRANT_MODULES.join(', ')}`);
  if (!dry) {
    const payload = GRANT_MODULES.map((m) => ({ client_id: clientId, module_id: m, enabled: true, source: 'manual', notes: 'onboard-bahwancy' }));
    const { error } = await db.from('client_modules').upsert(payload, { onConflict: 'client_id,module_id' });
    if (error) throw new Error(`client_modules: ${error.message}`);
  }

  // 2. designation (own scope) carrying the planograms grant
  log('2. designation (Field Executive = own scope)');
  const feDesig = await ensureDesignation(orgId, clientId, 'Field Executive', 'own', 0, GRANT_MODULES);

  // 3. the field seat — never touches the existing client admin
  log(`3. field seat ${FIELD_NAME} <${FIELD_EMAIL}>`);
  if (!dry) {
    const dup = (await db.from('users').select('id').eq('org_id', orgId).eq('email', FIELD_EMAIL).maybeSingle()).data as any;
    const uid = dup?.id || await ensureLogin(FIELD_EMAIL, SEAT_PASSWORD, FIELD_NAME);
    const { error } = await db.from('users').upsert({
      id: uid, org_id: orgId, client_id: clientId, name: FIELD_NAME, email: FIELD_EMAIL, mobile: FIELD_MOBILE,
      role: 'sub_admin', org_role_id: feDesig, city: null, is_active: true, must_change_password: true,
    }, { onConflict: 'id' });
    if (error) throw new Error(`users ${FIELD_EMAIL}: ${error.message}`);
  }

  // 4. relabel the planogram menu entry → "Store audit"
  log(`4. app_ui label "${MENU_LABEL}"`);
  await ensureMenuLabel(clientId);

  // 5. seat cap — only when explicitly provided (never clobber an adopted cap silently)
  if (SEAT_LIMIT !== undefined) {
    log(`5. seat cap (limits.max_active_users = ${SEAT_LIMIT})`);
    if (!dry) {
      await db.from('org_settings').delete().eq('org_id', orgId).eq('key', 'limits.max_active_users');
      const { error } = await db.from('org_settings').insert({ org_id: orgId, key: 'limits.max_active_users', value: SEAT_LIMIT });
      if (error) throw new Error(`org_settings cap: ${error.message}`);
    }
  } else {
    log('5. seat cap — left as-is (set BAHWANCY_SEAT_LIMIT to change it)');
  }

  log(`\n=== ${dry ? 'DRY-RUN complete (nothing written)' : 'COMMIT complete'} ===`);
  log(`Bahwancy org=${orgId} client=${clientId}`);
  log(`Modules: ${GRANT_MODULES.join(', ')} · Field seat: ${FIELD_EMAIL} · Menu label: "${MENU_LABEL}"`);
  log('Reminder: populate Bahwancy stores (Client Management / dashboard) so the "Store audit" dropdown has entries — GET /api/v1/stores drives it.');
  log('Next: wire isBahwancy(client_id above) in Kinematic-App Entitlements.kt + Kinematic-iOS ClientFeatureGates.swift so the app opens the planogram "Store audit" shell with the store dropdown.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[onboard-bahwancy] FAILED:', e?.message || e); process.exit(1); });

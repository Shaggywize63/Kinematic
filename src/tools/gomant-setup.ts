/* eslint-disable no-console */
/**
 * Gomant onboarding — a field-sales + distribution client inside the Kinematic org.
 *
 * ONE-OFF, IDEMPOTENT, DRY-RUN BY DEFAULT. Nothing is written unless `--apply` is passed. Full write-up
 * (what it touches, why each module, equivalent plain SQL, rollback): docs/GOMANT.md.
 *
 *   npx tsx src/tools/gomant-setup.ts                      # dry run: prints the plan, writes nothing
 *   npx tsx src/tools/gomant-setup.ts --apply              # applies it
 *   node dist/tools/gomant-setup.js [--apply]              # same, from the built backend image (ECS task)
 *
 *   --expect-client-id=<uuid>   abort unless the client found by name has exactly this id (a cross-check;
 *                               the id is never hard-coded here)
 *   --dry-run                   explicit spelling of the default
 *
 * HOW IT CONNECTS. Unlike agrisynx-*.ts (which call the HTTP API with an admin TOKEN), this tool talks to
 * the database directly with the service-role client, like onboard-byteback.ts. The API cannot express
 * what is needed: PATCH /clients/:id {modules} REPLACES the whole client_modules set (and rewrites
 * user_module_permissions), POST /clients/:id/packages grants whole packages only, and nothing writes
 * clients.settings.attendance_rules. It targets the KINEMATIC project (CLAUDE.md: default tenant), never
 * Tata, and refuses to run if the kinematic project is not configured (adminClientFor() would otherwise
 * silently fall back to the default = Tata project). Needs the backend's own env: SUPABASE_URL /
 * SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY and KINEMATIC_SUPABASE_URL / _ANON_KEY / _SERVICE_ROLE_KEY.
 *
 * WHAT IT DOES (every step is skipped when already done, so re-running changes nothing):
 *   0. Finds the client named "Gomant" (case-insensitive, trimmed) in `clients`. Zero or several live
 *      matches -> prints the candidates and stops. Prints the id it matched.
 *   1. client_modules: INSERTS the grants that are missing (enabled=true, source='manual',
 *      notes='gomant-setup'; ON CONFLICT (client_id, module_id) DO NOTHING). It NEVER updates, disables or
 *      deletes an existing row — including rows that are disabled / expired, which are only reported.
 *      The `modules` registry is read, never written: ids that are not in it are reported, not created
 *      (no other tool in this repo inserts registry rows). Universal modules are always on and get no row.
 *   2. clients.settings.app_ui: hide-only keys (tabs.expenses, menu.expenses, menu.crm, menu.ask_kini,
 *      settings.crm_only_mode = false) merged into what is there; every other key is kept.
 *   3. clients.settings.attendance_rules: written ONLY when the client has none yet. Never overwritten.
 *      Steps 2 and 3 are one read-merge-write of clients.settings; other settings keys are preserved.
 *   4. Rupee Sales + Collection targets: NOT enabled (they need the CRM module) — prints what they need.
 *   5. Prints the checklist of what still needs a human (users, hierarchy, masters, Tally). Creates nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Json = Record<string, unknown>;
const isPlain = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// ── identity ────────────────────────────────────────────────────────────────
export const CLIENT_NAME = 'Gomant';
/** The Kinematic Supabase project (CLAUDE.md: the default tenant for changes). Never 'default' (= Tata). */
export const PROJECT = 'kinematic';
/** Tata's project ref (CLAUDE.md). A configured URL containing it means we are about to hit the wrong database. */
const TATA_PROJECT_REF = 'lnvxqjqfsxvtjvbzphou';

export const GRANT_SOURCE = 'manual'; // what onboard-byteback / onboard-pasa / Client Management use
export const GRANT_NOTE = 'gomant-setup';

// ── the module set ──────────────────────────────────────────────────────────
export interface WantedModule { id: string; group: string; why: string }

const FF = 'field force';
const DIST = 'distribution';
const EXTRA = 'added with the brief';

/**
 * The modules Gomant needs, with the reason from the code. `requireModule(x)` in src/app.ts / the routers is
 * the backend gate; the Android gates are named where they matter. Ids missing from the live registry are
 * reported, not created.
 */
export const WANTED_MODULES: WantedModule[] = [
  { id: 'attendance', group: FF, why: 'Attendance tab, check-in / check-out' },
  { id: 'live_tracking', group: FF, why: 'Live tracking map and location pings' },
  { id: 'analytics', group: FF, why: "requireModule('analytics') endpoints" },
  { id: 'reports', group: FF, why: "requireModule('reports'), also gates /distribution/reports" },
  { id: 'orders', group: FF, why: 'Field-force orders (registry package field_force)' },
  { id: 'work_activities', group: FF, why: 'Work-activity log written on check-in / check-out' },
  { id: 'route_plan', group: FF, why: 'route-plan routes carry no module gate; the Android Route Plan tab keys off the field_force package' },
  { id: 'visit_logs', group: FF, why: 'Visit logs (people package)' },
  { id: 'form_builder', group: FF, why: 'Visit / activity forms; also what shows the Android "New Form" tab' },
  { id: 'activities', group: FF, why: "requireModule('activities')" },
  { id: 'stores', group: FF, why: "requireModule('stores') (outlets)" },
  { id: 'users', group: FF, why: "requireModule('users') (user management)" },
  { id: 'zones', group: FF, why: "requireModule('zones')" },
  { id: 'cities', group: FF, why: "requireModule('cities')" },
  { id: 'settings', group: FF, why: 'Dashboard Settings (system package)' },
  { id: 'leave', group: FF, why: 'Leave (registered as universal by migrations/leave_module_registration.sql)' },

  { id: 'distribution', group: DIST, why: 'Base SKU: gates /distribution/control-tower|stages|ai and the dashboard Integrations (Tally) page; never implied (lib/entitlements.ts)' },
  { id: 'distribution_orders', group: DIST, why: '/distribution/orders' },
  { id: 'distribution_payments', group: DIST, why: '/distribution/payments (collections)' },
  { id: 'distribution_ledger', group: DIST, why: '/distribution/ledger (outstanding)' },
  { id: 'distribution_stock', group: DIST, why: '/distribution/stock; Android "Distributor Stock" menu' },
  { id: 'distribution_van', group: DIST, why: '/distribution/van-loads; Android "Van Load" menu' },
  { id: 'distribution_damage', group: DIST, why: '/distribution/damage; Android "Log Damage" menu' },
  { id: 'distribution_returns', group: DIST, why: '/distribution/returns' },
  { id: 'distribution_invoicing', group: DIST, why: '/distribution/invoices and /dispatches (the invoices Tally syncs)' },
  { id: 'distribution_distributors', group: DIST, why: '/distribution/distributors' },
  { id: 'distribution_pricing', group: DIST, why: '/distribution/price-lists' },
  { id: 'distribution_schemes', group: DIST, why: '/distribution/schemes' },

  { id: 'distribution_reconciliation', group: EXTRA, why: '/distribution/reconciliation' },
  { id: 'notifications', group: EXTRA, why: 'Notifications (people package)' },
];

/**
 * NEVER granted by this tool: crm* (includes crm_conversation_intel), finance*, field_expenses, planogram(s).
 * Also: route_optimization is deliberately not in WANTED_MODULES (not needed).
 */
const FORBIDDEN_ID = /^(crm|finance|field_expenses|planogram)/;
const FORBIDDEN_PACKAGES = new Set(['crm', 'finance']);

export interface RegistryRow { id: string; name?: string | null; package: string | null; is_universal: boolean | null }
export interface GrantRow { module_id: string; enabled: boolean | null; expires_at: string | null; source?: string | null; notes?: string | null }

export function isForbidden(id: string, registry: RegistryRow[] = []): boolean {
  if (FORBIDDEN_ID.test(id)) return true;
  const pkg = registry.find((r) => r.id === id)?.package;
  return !!pkg && FORBIDDEN_PACKAGES.has(pkg);
}

/** A grant that counts today: enabled and not expired (the same test v_client_enabled_modules applies). */
export function isLive(g: GrantRow, now = Date.now()): boolean {
  return g.enabled === true && (!g.expires_at || Date.parse(g.expires_at) > now);
}

export type ModuleAction = 'add' | 'granted' | 'universal' | 'inactive' | 'not_in_registry';
export interface ModuleStep { want: WantedModule; action: ModuleAction; package: string | null; detail?: string }

/** Per wanted module: what to do. Pure; existing rows are only ever classified, never scheduled for change. */
export function planModuleGrants(wanted: WantedModule[], registry: RegistryRow[], existing: GrantRow[], now = Date.now()): ModuleStep[] {
  const reg = new Map(registry.map((r) => [r.id, r]));
  const have = new Map(existing.map((g) => [g.module_id, g]));
  return wanted.map((want): ModuleStep => {
    const r = reg.get(want.id);
    if (!r) return { want, action: 'not_in_registry', package: null };
    if (r.is_universal) return { want, action: 'universal', package: r.package };
    const g = have.get(want.id);
    if (!g) return { want, action: 'add', package: r.package };
    if (isLive(g, now)) return { want, action: 'granted', package: r.package };
    return {
      want, action: 'inactive', package: r.package,
      detail: g.enabled === true ? `expired ${g.expires_at}` : 'enabled=false',
    };
  });
}

/** Packages the client will have: what it has now (or, failing a view read, derived from the rows) + the adds. */
export function packagesAfter(currentPackages: string[], steps: ModuleStep[]): string[] {
  const out = new Set(currentPackages);
  for (const s of steps) if (s.action === 'add' && s.package) out.add(s.package);
  return [...out].sort();
}

/** Packages derived from the rows alone (fallback when v_client_enabled_modules cannot be read). */
export function packagesFromRows(registry: RegistryRow[], existing: GrantRow[], now = Date.now()): string[] {
  const reg = new Map(registry.map((r) => [r.id, r]));
  const out = new Set<string>();
  for (const r of registry) if (r.is_universal && r.package) out.add(r.package);
  for (const g of existing) {
    const p = isLive(g, now) ? reg.get(g.module_id)?.package : null;
    if (p) out.add(p);
  }
  return [...out].sort();
}

// ── app_ui (what the Android app understands — hide-only) ───────────────────
/**
 * Every key below is read by the app (Kinematic-App, Entitlements.kt `menuVisible / tabVisible / settingsVisible`):
 *   tabs.expenses            HomeTabs.kt  homeTabId(EXPENSES)            (the Expenses bottom tab; opt-in anyway)
 *   menu.expenses            HomeScreen.kt side menu "Expenses"
 *   menu.crm / menu.ask_kini HomeScreen.kt side menu "CRM" / "Ask KINI"  (shown when the client holds the crm package)
 *   settings.crm_only_mode   AllScreens.kt Settings -> MODULES "CRM-only mode" switch
 * The semantics are hide-only: `false` hides, absent / true defers to the item's own gate. So the visible set
 * (Home, Attendance, Route Plan, orders, collections, targets, Van Load, ...) is NOT listed: those stay on
 * their module / package gates. Tabs / entries we do not hide stay at their default — see docs/GOMANT.md.
 */
export const APP_UI_HIDE: Record<string, Record<string, boolean>> = {
  tabs: { expenses: false },
  menu: { expenses: false, crm: false, ask_kini: false },
  settings: { crm_only_mode: false },
};

// ── attendance rules ────────────────────────────────────────────────────────
/** clients.settings.attendance_rules (shape and bounds: gomant-contract C1). Written only when absent. */
export const ATTENDANCE_RULES = {
  shift_start: '09:30',
  shift_end: '18:00',
  grace_minutes: 15,
  weekly_off: [0], // 0 = Sunday
  allow_offline_checkin: true,
};

/** Self-check of the constants above against the contract's bounds. Returns the problems (empty = fine). */
export function validateAttendanceRules(r: typeof ATTENDANCE_RULES): string[] {
  const problems: string[] = [];
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(r.shift_start)) problems.push('shift_start must be HH:MM (24h)');
  if (!hhmm.test(r.shift_end)) problems.push('shift_end must be HH:MM (24h)');
  if (!Number.isInteger(r.grace_minutes) || r.grace_minutes < 0 || r.grace_minutes > 120) problems.push('grace_minutes must be an integer 0..120');
  if (!Array.isArray(r.weekly_off) || r.weekly_off.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) problems.push('weekly_off must be a subset of 0..6');
  if (typeof r.allow_offline_checkin !== 'boolean') problems.push('allow_offline_checkin must be boolean');
  return problems;
}

// ── clients.settings plan ───────────────────────────────────────────────────
export interface AppUiChange { path: string; from: unknown; to: boolean }
export interface SettingsPlan {
  next: Json;
  appUiChanges: AppUiChange[];
  attendance: { action: 'set' | 'keep'; current?: unknown };
  changed: boolean;
}

/**
 * clients.settings with the Gomant keys laid over what is already there. Every other key (including other
 * app_ui keys and groups) is kept. Throws rather than overwrite something malformed.
 */
export function planSettings(existing: unknown): SettingsPlan {
  if (existing !== null && existing !== undefined && !isPlain(existing)) {
    throw new Error(`clients.settings is not a JSON object (${Array.isArray(existing) ? 'array' : typeof existing}); refusing to touch it — fix it by hand first.`);
  }
  const cur: Json = isPlain(existing) ? existing : {};
  const next: Json = { ...cur };

  // app_ui
  const curUi = cur.app_ui;
  if (curUi !== undefined && curUi !== null && !isPlain(curUi)) {
    throw new Error(`settings.app_ui is not an object (${Array.isArray(curUi) ? 'array' : typeof curUi}); refusing to overwrite it — fix it in Client Management first.`);
  }
  const ui: Json = isPlain(curUi) ? curUi : {};
  const nextUi: Json = { ...ui };
  const appUiChanges: AppUiChange[] = [];
  for (const [group, values] of Object.entries(APP_UI_HIDE)) {
    const have = ui[group];
    if (have !== undefined && have !== null && !isPlain(have)) {
      throw new Error(`settings.app_ui.${group} is not an object (${Array.isArray(have) ? 'array' : typeof have}); refusing to overwrite it — fix it in Client Management first.`);
    }
    const haveObj: Json = isPlain(have) ? have : {};
    for (const [key, to] of Object.entries(values)) {
      if (haveObj[key] !== to) appUiChanges.push({ path: `app_ui.${group}.${key}`, from: haveObj[key], to });
    }
    nextUi[group] = { ...haveObj, ...values };
  }
  next.app_ui = nextUi;

  // attendance_rules: present = configured by an admin (or by an earlier run) -> never overwritten.
  const curRules = cur.attendance_rules;
  let attendance: SettingsPlan['attendance'];
  if (curRules === undefined || curRules === null) {
    next.attendance_rules = { ...ATTENDANCE_RULES, weekly_off: [...ATTENDANCE_RULES.weekly_off] };
    attendance = { action: 'set' };
  } else if (isPlain(curRules)) {
    attendance = { action: 'keep', current: curRules };
  } else {
    throw new Error(`settings.attendance_rules is not an object (${Array.isArray(curRules) ? 'array' : typeof curRules}); refusing to overwrite it — fix it by hand first.`);
  }

  return { next, appUiChanges, attendance, changed: appUiChanges.length > 0 || attendance.action === 'set' };
}

// ── finding the client ──────────────────────────────────────────────────────
export interface ClientRow {
  id: string; name: string | null; org_id: string | null; owner_org_id: string | null;
  is_active: boolean | null; created_at?: string | null; settings?: unknown;
}

/** Case-insensitive, trimmed comparison key. */
export const normalizeName = (s: unknown): string => String(s ?? '').trim().toLowerCase();
const isSoftDeleted = (c: ClientRow) => isPlain(c.settings) && !!c.settings.deleted_at;

export interface ClientMatches { live: ClientRow[]; deleted: ClientRow[]; similar: ClientRow[] }

/** Exact (trimmed, case-insensitive) matches split live / soft-deleted, plus near misses that merely contain the name. */
export function findClients(all: ClientRow[], wanted = CLIENT_NAME): ClientMatches {
  const key = normalizeName(wanted);
  const exact = all.filter((c) => normalizeName(c.name) === key);
  return {
    live: exact.filter((c) => !isSoftDeleted(c)),
    deleted: exact.filter(isSoftDeleted),
    similar: all.filter((c) => normalizeName(c.name) !== key && normalizeName(c.name).includes(key)),
  };
}

export const describeClient = (c: ClientRow): string =>
  `id=${c.id}  name=${JSON.stringify(c.name)}  org_id=${c.org_id ?? '-'}  owner_org_id=${c.owner_org_id ?? '-'}  `
  + `active=${c.is_active}  created=${c.created_at ?? '-'}${isSoftDeleted(c) ? '  [SOFT-DELETED]' : ''}`;

// ── flags ───────────────────────────────────────────────────────────────────
export interface Flags { apply: boolean; help: boolean; expectClientId?: string }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(args: string[]): Flags {
  const flags: Flags = { apply: false, help: false };
  let dry = false;
  for (const a of args) {
    if (a === '--apply') flags.apply = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a.startsWith('--expect-client-id=')) {
      const v = a.slice('--expect-client-id='.length).trim();
      if (!UUID_RE.test(v)) throw new Error(`--expect-client-id needs a UUID, got "${v}"`);
      flags.expectClientId = v.toLowerCase();
    } else throw new Error(`Unknown argument "${a}". Use --apply, --dry-run, --expect-client-id=<uuid> or --help.`);
  }
  if (flags.apply && dry) throw new Error('Pass either --apply or --dry-run, not both.');
  return flags;
}

const USAGE = `Usage: gomant-setup [--apply] [--expect-client-id=<uuid>]
  (no flag)   dry run: print the plan, write nothing
  --apply     perform the writes
  --expect-client-id=<uuid>   abort unless the client found by name has this id`;

// ── database access ─────────────────────────────────────────────────────────
class Abort extends Error {}

/**
 * The kinematic project's service-role client, or an Abort. adminClientFor() silently falls back to the
 * DEFAULT project (= Tata in production) when the requested key is not registered, so we check first.
 * ../lib/projects is imported lazily: it throws at load time without the backend env, and we want a clear
 * message instead of a stack trace.
 */
async function connect(): Promise<{ db: SupabaseClient; host: string }> {
  let projects: typeof import('../lib/projects');
  try {
    projects = await import('../lib/projects');
  } catch (e: any) {
    throw new Abort(`Could not load the project registry (${e?.message || e}). This tool needs the backend's env: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY and KINEMATIC_SUPABASE_URL / KINEMATIC_SUPABASE_ANON_KEY / KINEMATIC_SUPABASE_SERVICE_ROLE_KEY.`);
  }
  if (!projects.isKnownProject(PROJECT)) {
    throw new Abort(`Project "${PROJECT}" is not configured (set KINEMATIC_SUPABASE_URL, KINEMATIC_SUPABASE_ANON_KEY and KINEMATIC_SUPABASE_SERVICE_ROLE_KEY). Refusing to fall back to the default (Tata) project.`);
  }
  const cfg = projects.getProjectConfig(PROJECT);
  const def = projects.getProjectConfig(projects.DEFAULT_PROJECT);
  if (cfg.key !== PROJECT || cfg.url === def.url || cfg.url.includes(TATA_PROJECT_REF)) {
    throw new Abort(`Project "${PROJECT}" resolves to the default / Tata database (${new URL(cfg.url).host}). Refusing to run.`);
  }
  return { db: projects.adminClientFor(PROJECT), host: new URL(cfg.url).host };
}

/** All rows of a query, 1000 at a time (PostgREST caps a response at 1000 by default). */
async function fetchAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) break;
  }
  return out;
}

async function readSettings(db: SupabaseClient, clientId: string): Promise<unknown> {
  const { data, error } = await db.from('clients').select('settings').eq('id', clientId).maybeSingle();
  if (error) throw new Error(`read clients.settings: ${error.message}`);
  if (!data) throw new Abort(`client ${clientId} no longer exists`);
  return (data as { settings?: unknown }).settings;
}

/** What the client can use today according to the entitlement view the API itself reads, or null if unreadable. */
async function readEffective(db: SupabaseClient, clientId: string): Promise<{ modules: string[]; packages: string[] } | null> {
  const { data, error } = await db.from('v_client_enabled_modules').select('module_id, package').eq('client_id', clientId);
  if (error || !data) return null;
  const rows = data as Array<{ module_id: string; package: string | null }>;
  return {
    modules: rows.map((r) => r.module_id).sort(),
    packages: [...new Set(rows.map((r) => r.package).filter(Boolean) as string[])].sort(),
  };
}

// ── output ──────────────────────────────────────────────────────────────────
const log = (...a: unknown[]) => console.log(...a);
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const json = (v: unknown) => (v === undefined ? '(unset)' : JSON.stringify(v));

const LABEL: Record<ModuleAction, string> = {
  add: 'ADD     ',
  granted: 'ok      ',
  universal: 'universal',
  inactive: 'INACTIVE',
  not_in_registry: 'MISSING ',
};

function printChecklist() {
  log(`
5. STILL NEEDS HUMAN INPUT (this tool creates none of it)
   Users — name, email, mobile (10 digits, unique per org), role/designation, city for each:
     [ ] admin user(s)
     [ ] supervisor / manager user(s)
     [ ] sales-rep user(s)
   Hierarchy:
     [ ] who reports to whom (users.supervisor_id) and the designations (org_roles: data_scope team / own);
         tick the modules above on each designation — once a designation's permission list is non-empty the
         dashboard hides any module not listed on it
     [ ] zone / city assignment per rep
   Masters (dashboard import or Distribution pages):
     [ ] outlets / stores, with the distributor each is assigned to
     [ ] distributors
     [ ] SKUs / products (+ brands) and the price list(s); schemes if any
     [ ] route plans per rep; an activity of type "order_collection" (or with "order" in its name) assigned on
         the route, otherwise the app does not show "Book Order" / "Collect Payment" on the outlet screen
   Tally (Distribution -> Integrations -> Connect Tally):
     [ ] exact Tally company name (it is the SVCURRENTCOMPANY in every voucher)
     [ ] ledger names in that company: Sales, Cash, Bank, CGST, SGST, IGST, Sales Returns / credit note
     [ ] a Windows PC running Tally on which to install the bridge agent (the agent secret is shown once)
   Decisions:
     [ ] confirm attendance rules (09:30-18:00, grace 15, Sunday off, offline check-in allowed)
     [ ] stricter app bar? (see docs/GOMANT.md, "Left at default")
     [ ] rupee targets: needs the CRM module (see 4 above) — decide whether that is acceptable`);
}

// ── main ────────────────────────────────────────────────────────────────────
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseArgs(argv);
  if (flags.help) { log(USAGE); return; }
  const apply = flags.apply;
  const tag = apply ? '' : '[dry-run] ';

  // Self-checks on the constants: these must never be wrong, whatever the data says.
  const ids = WANTED_MODULES.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Abort('internal: duplicate module id in WANTED_MODULES');
  const bad = ids.filter((id) => isForbidden(id));
  if (bad.length) throw new Abort(`internal: WANTED_MODULES contains modules that must never be granted: ${bad.join(', ')}`);
  const ruleProblems = validateAttendanceRules(ATTENDANCE_RULES);
  if (ruleProblems.length) throw new Abort(`internal: ATTENDANCE_RULES invalid: ${ruleProblems.join('; ')}`);

  log(`=== Gomant setup — ${apply ? 'APPLY (writing)' : 'DRY RUN (nothing is written; pass --apply to apply)'} ===`);
  const { db, host } = await connect();
  log(`database: project "${PROJECT}" (${host})`);

  // 0. the client
  const all = await fetchAll<ClientRow>((from, to) =>
    db.from('clients').select('id, name, org_id, owner_org_id, is_active, created_at, settings').order('created_at').range(from, to));
  const found = findClients(all);
  if (found.live.length !== 1) {
    const lines: string[] = [];
    if (found.live.length === 0) {
      lines.push(`No live client named "${CLIENT_NAME}" (case-insensitive, trimmed) in project "${PROJECT}".`);
      if (found.deleted.length) lines.push('Soft-deleted with that name (ignored):', ...found.deleted.map((c) => `  ${describeClient(c)}`));
      if (found.similar.length) lines.push('Similar names:', ...found.similar.map((c) => `  ${describeClient(c)}`));
      if (!found.deleted.length && !found.similar.length) {
        const live = all.filter((c) => !isSoftDeleted(c));
        lines.push(`Clients that exist (${live.length}${live.length > 50 ? ', first 50' : ''}):`, ...live.slice(0, 50).map((c) => `  ${describeClient(c)}`));
      }
    } else {
      lines.push(`${found.live.length} live clients are named "${CLIENT_NAME}" — refusing to guess. Candidates:`, ...found.live.map((c) => `  ${describeClient(c)}`));
      if (found.deleted.length) lines.push('Soft-deleted (ignored):', ...found.deleted.map((c) => `  ${describeClient(c)}`));
    }
    throw new Abort(lines.join('\n'));
  }
  const client = found.live[0];
  log(`\nMATCHED CLIENT\n  ${describeClient(client)}`);
  if (flags.expectClientId && flags.expectClientId !== client.id.toLowerCase()) {
    throw new Abort(`--expect-client-id=${flags.expectClientId} does not match the client found by name (${client.id}). Nothing was changed.`);
  }
  if (client.is_active === false) log('  WARNING: this client is not active.');
  if (found.deleted.length) log(`  note: ${found.deleted.length} soft-deleted client(s) with the same name were ignored.`);

  // 1. modules
  const registry = await fetchAll<RegistryRow>((from, to) =>
    db.from('modules').select('id, name, package, is_universal').order('id').range(from, to));
  const existing = await fetchAll<GrantRow>((from, to) =>
    db.from('client_modules').select('module_id, enabled, expires_at, source, notes').eq('client_id', client.id).order('module_id').range(from, to));
  const refused = ids.filter((id) => isForbidden(id, registry));
  if (refused.length) throw new Abort(`Refusing: registry says these belong to a package this client must not get: ${refused.join(', ')}`);

  const steps = planModuleGrants(WANTED_MODULES, registry, existing);
  const effective = await readEffective(db, client.id);
  const currentPackages = effective?.packages ?? packagesFromRows(registry, existing);
  const after = packagesAfter(currentPackages, steps);
  const toAdd = steps.filter((s) => s.action === 'add');

  log(`\n1. client_modules — insert-only (existing rows are never changed). ${existing.length} row(s) exist today.`);
  let lastGroup = '';
  for (const s of steps) {
    if (s.want.group !== lastGroup) { log(`   -- ${s.want.group}`); lastGroup = s.want.group; }
    const extra = s.action === 'inactive' ? ` (${s.detail}; left untouched — enable it in the Clients page)`
      : s.action === 'universal' ? ' (always on, no row needed)'
      : s.action === 'not_in_registry' ? ' (not in the modules registry; not granted, not created)' : '';
    log(`   ${LABEL[s.action]} ${pad(s.want.id, 28)} ${pad(s.package ? `[${s.package}]` : '', 16)} ${s.want.why}${extra}`);
  }
  const wantedIds = new Set(ids);
  const keptExtras = existing.filter((g) => isLive(g) && !wantedIds.has(g.module_id)).map((g) => g.module_id).sort();
  if (keptExtras.length) log(`   existing grants outside this set (kept as they are): ${keptExtras.join(', ')}`);
  const forbiddenHeld = [
    ...existing.filter((g) => isLive(g) && isForbidden(g.module_id, registry)).map((g) => g.module_id),
    ...registry.filter((r) => r.is_universal && isForbidden(r.id, registry)).map((r) => `${r.id} (universal)`),
  ];
  if (forbiddenHeld.length) {
    log(`   WARNING: the client already holds modules it should not have: ${forbiddenHeld.join(', ')}.`);
    log('            This tool does not remove grants. app_ui hides the CRM / Expenses menus, but remove them in Client Management.');
  }
  const missing = steps.filter((s) => s.action === 'not_in_registry').map((s) => s.want.id);
  if (missing.length) log(`   NOT IN REGISTRY (skipped): ${missing.join(', ')}`);
  log(`   -> ${toAdd.length} to add${toAdd.length ? `: ${toAdd.map((s) => s.want.id).join(', ')}` : ''}`);
  log(`   packages ${effective ? 'today' : '(derived from rows)'}: ${currentPackages.join(', ') || '(none)'}  ->  after: ${after.join(', ')}`);
  if (!after.includes('field_force')) log('   WARNING: no field_force package -> the Android Home bar would show only Home (hasFieldForce() is false).');
  if (!after.includes('distribution')) log('   WARNING: no distribution package -> no orders / collections in the app (hasDistribution() is false).');
  if (after.includes('crm')) log('   WARNING: the crm package is present -> the app\'s CRM menus are only hidden (step 2), not absent.');

  // 2 + 3. clients.settings
  const plan = planSettings(client.settings);
  log('\n2. clients.settings.app_ui — hide-only keys, merged into what is there');
  if (plan.appUiChanges.length === 0) log('   already up to date');
  for (const c of plan.appUiChanges) log(`   ${tag}set ${pad(c.path, 30)} ${json(c.from)} -> ${json(c.to)}`);
  log('3. clients.settings.attendance_rules — only when absent');
  if (plan.attendance.action === 'keep') log(`   already configured, left as is: ${json(plan.attendance.current)}`);
  else log(`   ${tag}set ${json(ATTENDANCE_RULES)}`);

  // 4. targets (never written)
  const holdsCrm = after.includes('crm') || existing.some((g) => isLive(g) && g.module_id === 'crm');
  log(`
4. Rupee Sales + Collection targets — NOT enabled by this tool
   They live under /api/v1/crm/targets/*, and the whole CRM router is gated by requireModule('crm')
   (src/routes/crm.routes.ts). 'crm' is on the do-not-grant list, so enabling targets would mean giving a
   CRM client entitlement (the client holds crm today: ${holdsCrm ? 'YES' : 'no'}). What it would need, all of:
     a) grant module 'crm' (package crm) -> the app then has hasCrm(); step 2 already hides its "CRM" and
        "Ask KINI" menu entries (menu.crm / menu.ask_kini = false)
     b) crm_settings config.targets.types = [{"key":"sales"},{"key":"collection"}] on the client's own row
        (org_id ${client.org_id ?? '?'}, client_id ${client.id}); if it has no row of its own the org default row is read
     c) migrations/crm_target_entries.sql applied (table crm_target_entries) before reps can log entries
   Android needs nothing: the Home "My targets" card appears once /crm/targets/types returns types.`);

  // apply
  if (apply) {
    log('\n--- applying ---');
    if (toAdd.length) {
      const rows = toAdd.map((s) => ({ client_id: client.id, module_id: s.want.id, enabled: true, source: GRANT_SOURCE, notes: GRANT_NOTE }));
      const { error } = await db.from('client_modules').upsert(rows, { onConflict: 'client_id,module_id', ignoreDuplicates: true });
      if (error) throw new Error(`client_modules insert: ${error.message}`);
      log(`client_modules: requested ${rows.length} insert(s)`);
    } else log('client_modules: nothing to add');

    // Re-read right before the write so the merge uses the freshest settings.
    const fresh = planSettings(await readSettings(db, client.id));
    if (fresh.changed) {
      const { data, error } = await db.from('clients').update({ settings: fresh.next }).eq('id', client.id).select('settings').maybeSingle();
      if (error) throw new Error(`clients.settings update: ${error.message}`);
      if (!data) throw new Error('clients.settings update matched no row');
      log('clients.settings: written');
    } else log('clients.settings: nothing to change');

    // verify by reading back
    const problems: string[] = [];
    const nowGrants = await fetchAll<GrantRow>((from, to) =>
      db.from('client_modules').select('module_id, enabled, expires_at, source, notes').eq('client_id', client.id).order('module_id').range(from, to));
    const stillMissing = planModuleGrants(WANTED_MODULES, registry, nowGrants).filter((s) => s.action === 'add').map((s) => s.want.id);
    if (stillMissing.length) problems.push(`grants still missing after insert: ${stillMissing.join(', ')}`);
    const settingsNow = planSettings(await readSettings(db, client.id));
    if (settingsNow.changed) problems.push('clients.settings does not read back as expected');
    const eff = await readEffective(db, client.id);
    log(`verified: effective packages now: ${(eff?.packages ?? ['(view unreadable)']).join(', ')}`);
    if (problems.length) throw new Error(`VERIFY FAILED: ${problems.join('; ')}`);
    log('verified: grants present, app_ui and attendance_rules read back as planned');
    log('Note: a running API caches entitlements ~60 s and a logged-in user\'s profile up to 5 min; reps may need to sign in again.');
  }

  printChecklist();
  log(apply ? '\nDone.' : '\nDry run only — nothing was changed. Re-run with --apply to apply.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Abort ? `\nABORTED: ${e.message}` : `\nFAILED: ${e?.message || e}`);
      process.exit(1);
    });
}

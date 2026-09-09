/* eslint-disable no-console */
/**
 * PASA client onboarding — Tata (`default`) project.
 *
 * Runs as a ONE-OFF ECS task on the backend image, so it inherits the
 * backend's own service-role connection to the Tata Supabase project — the
 * tenant where SRS and BMW Ventures already live. Nothing here runs inside
 * the web server.
 *
 * Modes (argv):
 *   --inspect  (default) READ-ONLY. Dumps the Tata org model + SRS config.
 *   --dry-run  Prints the exact create plan — NO writes.
 *   --commit   Performs the idempotent writes.
 *
 * Model (verified via --inspect): the Tata project is org-per-client. SRS is
 * client a1f67468 in org 00000000-…-0001 ("Kaiyo Technology Labs"); BMW is in
 * its own org. So PASA gets its OWN new org, and SRS's org-scoped config
 * (products / pipelines+stages / custom-field defs / lead sources / activity
 * subjects / the designation tree) is COPIED into it — the same shape BMW has.
 *
 * Decisions (operator-approved):
 *   • 40 users (25 sales BM/ASM/ASO/CSE + 15 Consumer Champions). Krishna
 *     Kachhap skipped (no email). Kishan Prasad created, city scope pending.
 *   • Every user gets a login; shared temp password (Pasa@12345). Admin
 *     pasa@kinematicapp.com keeps Manvik@1221.
 *   • Designations mirror SRS: BM→Business Managers, SM→Area Sales Manager,
 *     ASO→Area Sales Officer, CC→Consumer Champion, plus a NEW
 *     "Consumer Sales Executive" (own scope, under Area Sales Officer) for CSE.
 *   • Steel-dealer code behaviours (match SRS): PASA's client_id is added to
 *     STEEL_DEALER_CLIENT_IDS and LIVE_TRACKING_DISABLED_CLIENT_IDS by a
 *     SEPARATE code PR — not this data script.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { adminClientFor, DEFAULT_PROJECT } from '../lib/projects';

// ── Fixed identifiers (shared with the steel-dealer code PR) ───────────────
const SRS_ORG_ID = '00000000-0000-0000-0000-000000000001';
const SRS_CLIENT_ID = 'a1f67468-526e-4734-be3a-2cb132cc2804';
const PASA_ORG_ID = 'c5efb1ec-2912-4619-90f7-93b5172fd712';
const PASA_CLIENT_ID = '1fcda02a-8af6-4019-bef9-2a9dfacae4a3';
const PASA_ORG_NAME = 'PASA';
const PASA_ORG_SLUG = 'pasa-house';
const OWNER_ORG_FALLBACK = '11111111-1111-4111-8111-111111111111'; // BMW's owner (platform master)
const ADMIN_EMAIL = 'pasa@kinematicapp.com';
const ADMIN_PASSWORD = 'Manvik@1221';
const TEMP_PASSWORD = 'Pasa@12345';
const NEW_DESIGNATION = 'Consumer Sales Executive'; // created under Area Sales Officer

type PasaUser = {
  name: string; mobile: string; email: string; group: 'sales' | 'cc';
  designation: string; state: string; cities: string[]; stateLevel: boolean; pendingLocation: boolean;
};

// —— embedded roster (parsed from Sales_Team_Details.xlsx + the CC image) ——
const PASA_USERS: PasaUser[] = [
  {
    "name": "HARISH CHANDRA SINGH",
    "mobile": "9934362270",
    "email": "bmgaya.tiscon@pasahouse.com",
    "group": "sales",
    "designation": "Business Managers",
    "state": "Bihar",
    "cities": [
      "Gaya"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Chandan Kumar",
    "mobile": "9955993244",
    "email": "smgaya.tiscon@pasahouse.com",
    "group": "sales",
    "designation": "Area Sales Manager",
    "state": "Bihar",
    "cities": [
      "Lakhisarai"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "ABHISHEK KUMAR",
    "mobile": "6201914891",
    "email": "abhikumar4604@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Bihar",
    "cities": [
      "Gaya"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Nandan Mishra",
    "mobile": "9113714018",
    "email": "nandankumarmishra16389@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Bihar",
    "cities": [
      "Jamui"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Anand Kumar Panday",
    "mobile": "8229858650",
    "email": "anandk49355@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Bihar",
    "cities": [
      "Jehanabad"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "RANJEET KUMAR",
    "mobile": "8340684772",
    "email": "ranjeetkumar1207@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Bihar",
    "cities": [
      "Nalanda"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "RAVISHEK RANJAN",
    "mobile": "9102320215",
    "email": "ravishekranjan8@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Bihar",
    "cities": [
      "Aurangabad"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "PAWAN KUMAR",
    "mobile": "9934598592",
    "email": "pawankr141093@gmail.com",
    "group": "sales",
    "designation": "Consumer Sales Executive",
    "state": "Bihar",
    "cities": [
      "Nalanda"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "RAMAN KUMAR JHA",
    "mobile": "9204756531",
    "email": "bmjhk.tiscon@pasahouse.com",
    "group": "sales",
    "designation": "Business Managers",
    "state": "Jharkhand",
    "cities": [],
    "stateLevel": true,
    "pendingLocation": false
  },
  {
    "name": "ABHIJIT AGARWAL",
    "mobile": "7004709213",
    "email": "smrnc.tiscon@pasahouse.com",
    "group": "sales",
    "designation": "Business Managers",
    "state": "Jharkhand",
    "cities": [],
    "stateLevel": true,
    "pendingLocation": false
  },
  {
    "name": "KUNAL ANAND",
    "mobile": "7091197742",
    "email": "luckyanand.sl@gmail.com",
    "group": "sales",
    "designation": "Area Sales Manager",
    "state": "Jharkhand",
    "cities": [
      "Garhwa",
      "Gumla",
      "Latehar",
      "Palamu"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "SANJEEV JHA",
    "mobile": "9431753077",
    "email": "smjsr.tiscon@pasahouse.com",
    "group": "sales",
    "designation": "Area Sales Manager",
    "state": "Jharkhand",
    "cities": [
      "East Singhbhum",
      "Saraikela-Kharsawan",
      "West Singhbhum"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "TOMAL GHOSH",
    "mobile": "9955831841",
    "email": "tomal.ghosh15@gmail.com",
    "group": "sales",
    "designation": "Area Sales Manager",
    "state": "Jharkhand",
    "cities": [
      "East Singhbhum",
      "Saraikela-Kharsawan",
      "West Singhbhum"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "BABLU MALLICK",
    "mobile": "9304171743",
    "email": "malikbablu0000@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "Ramgarh"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "DHANMANT KUMAR MISHRA",
    "mobile": "9939245155",
    "email": "asodtg.tiscon@pasahouse.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "Daltonganj",
      "Latehar",
      "Palamu"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "RAJEEV KUMAR",
    "mobile": "7991184486",
    "email": "rajeev.f109@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "Hazaribagh"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "NAVNEET UPADHYAY",
    "mobile": "9801612406",
    "email": "n7479889081@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "Garhwa"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "PRATIK ROY",
    "mobile": "9155535666",
    "email": "roypratik1908@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "Chatra",
      "Koderma"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "ASHUTOSH KUMAR",
    "mobile": "7011939427",
    "email": "ashutosh.pandey1992000@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "East Singhbhum",
      "Saraikela-Kharsawan",
      "West Singhbhum"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "AMIT KUMAR",
    "mobile": "7033898207",
    "email": "amit66643@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "East Singhbhum",
      "Saraikela-Kharsawan",
      "West Singhbhum"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "BINAY KUMAR",
    "mobile": "9955500745",
    "email": "becbinay@gmail.com",
    "group": "sales",
    "designation": "Area Sales Officer",
    "state": "Jharkhand",
    "cities": [
      "Ranchi"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "KAMLESH  KR PANDEY",
    "mobile": "6201568684",
    "email": "kamleshpandey98756@gmail.com",
    "group": "sales",
    "designation": "Consumer Sales Executive",
    "state": "Jharkhand",
    "cities": [
      "Daltonganj",
      "Latehar",
      "Palamu"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "ARMAN MADHU",
    "mobile": "7480003993",
    "email": "armanmadhu9@gmail.com",
    "group": "sales",
    "designation": "Consumer Sales Executive",
    "state": "Jharkhand",
    "cities": [
      "Jamshedpur"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "ROSHAN KUMAR",
    "mobile": "9229369611",
    "email": "kumaroshan001@gmail.com",
    "group": "sales",
    "designation": "Consumer Sales Executive",
    "state": "Jharkhand",
    "cities": [
      "Hazaribagh"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "RAGHVENDRA KUMAR PANDEY",
    "mobile": "8340431344",
    "email": "raghavjbk3@gmail.com",
    "group": "sales",
    "designation": "Consumer Sales Executive",
    "state": "Jharkhand",
    "cities": [
      "Ranchi"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Kundan Kumar",
    "mobile": "9039673935",
    "email": "kundan.com007@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Lakhisarai"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Satish Kumar",
    "mobile": "9304239187",
    "email": "satishsingh3139@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Jamui"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Sujeet Kumar",
    "mobile": "8102368247",
    "email": "kumarsujeet89355@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Jehanabad"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Prashant Kumar",
    "mobile": "7462067548",
    "email": "prashant.kumar35035@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Gaya"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Ravishankar Mishra",
    "mobile": "7783874540",
    "email": "ravishankarmishra14399@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Gaya"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Rakesh Kumar",
    "mobile": "6202595269",
    "email": "rakesh620720@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Aurangabad"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Sumant Kumar",
    "mobile": "7050512627",
    "email": "sumant80h@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Aurangabad"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Gopal Anand",
    "mobile": "9304117610",
    "email": "visualsingh36@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Bihar",
    "cities": [
      "Nalanda"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Kishan Prasad",
    "mobile": "8877378474",
    "email": "kishanprasad727@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Jharkhand",
    "cities": [],
    "stateLevel": false,
    "pendingLocation": true
  },
  {
    "name": "Mukesh Mahto",
    "mobile": "7258911171",
    "email": "mmahto3000@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Jharkhand",
    "cities": [
      "Ranchi"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Vikram Kumar Yadav",
    "mobile": "7870541131",
    "email": "yadavikram0132@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Jharkhand",
    "cities": [
      "Ranchi"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Ravi Yadav",
    "mobile": "7488043879",
    "email": "yadavravi1746@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Jharkhand",
    "cities": [
      "Koderma"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Safique Ansari",
    "mobile": "7979083574",
    "email": "safiqueansari01@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Jharkhand",
    "cities": [
      "Garhwa"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Nitin Mandal",
    "mobile": "7488200656",
    "email": "nitinmandal580@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Jharkhand",
    "cities": [
      "West Singhbhum"
    ],
    "stateLevel": false,
    "pendingLocation": false
  },
  {
    "name": "Ram Prawesh Sahu",
    "mobile": "9931122747",
    "email": "rampraweshsahu123@gmail.com",
    "group": "cc",
    "designation": "Consumer Champion",
    "state": "Jharkhand",
    "cities": [
      "Palamu"
    ],
    "stateLevel": false,
    "pendingLocation": false
  }
];

const MODE: 'inspect' | 'dry-run' | 'commit' =
  process.argv.includes('--commit') ? 'commit'
  : process.argv.includes('--dry-run') ? 'dry-run'
  : 'inspect';
const dry = MODE !== 'commit';

const db = adminClientFor(DEFAULT_PROJECT); // Tata service-role (bypasses RLS)

// City → state (derived from the roster) + the full PASA territory.
const CITY_STATE = new Map<string, string>();
for (const u of PASA_USERS) for (const c of u.cities) CITY_STATE.set(c, u.state);
const ALL_CITIES = Array.from(CITY_STATE.keys()).sort();
const citiesForState = (st: string) => ALL_CITIES.filter(c => CITY_STATE.get(c) === st);

function log(...a: unknown[]) { console.log(...a); }
async function insertChunked(table: string, rows: any[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from(table).insert(rows.slice(i, i + 200));
    if (error) throw new Error(`insert ${table}: ${error.message}`);
  }
}

// ── read-only inspection (unchanged) ───────────────────────────────────────
async function inspect() {
  const clients = (await db.from('clients')
    .select('id,name,org_id,owner_org_id,is_active,created_at')).data || [];
  const srs = (clients as any[]).find(c => String(c.name).toLowerCase().includes('srs'));
  const report: any = { project: DEFAULT_PROJECT, single_org_projects_env: process.env.SINGLE_ORG_PROJECTS ?? '(unset)', clients };
  if (srs) {
    report.srs_org_id = srs.org_id;
    report.org_roles = (await db.from('org_roles')
      .select('id,name,parent_id,data_scope,position,deleted_at').eq('org_id', srs.org_id)).data;
  }
  console.log('PASA_INSPECT_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('PASA_INSPECT_REPORT_END');
}

// ── copy an org-scoped config table SRS→PASA, returning old→new id map ──────
async function copyTable(table: string, transform?: (row: any) => void): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // Idempotent: if PASA already has rows here, assume copied and re-map by a stable key.
  const existing = (await db.from(table).select('*').eq('org_id', PASA_ORG_ID)).data || [];
  const src = (await db.from(table).select('*').eq('org_id', SRS_ORG_ID)).data || [];
  if (existing.length > 0) {
    log(`   · ${table}: ${existing.length} already present in PASA org — skip copy`);
    return map;
  }
  const rows: any[] = [];
  for (const r of src as any[]) {
    const nid = randomUUID();
    map.set(r.id, nid);
    const row: any = { ...r };
    delete row.created_at; delete row.updated_at;
    row.id = nid; row.org_id = PASA_ORG_ID;
    rows.push(row);
  }
  if (transform) for (const row of rows) transform(row);
  log(`   · ${table}: copy ${rows.length} rows SRS→PASA`);
  if (!dry && rows.length) await insertChunked(table, rows);
  return map;
}

// ── copy the org_roles designation tree (self-referential parent remap) ─────
async function copyDesignations(): Promise<Map<string, string>> {
  const byName = new Map<string, string>(); // designation name → new id
  const existing = (await db.from('org_roles').select('id,name').eq('org_id', PASA_ORG_ID)).data || [];
  if (existing.length > 0) {
    for (const r of existing as any[]) byName.set(r.name, r.id);
    log(`   · org_roles: ${existing.length} already in PASA org — reuse`);
    return byName;
  }
  const src = ((await db.from('org_roles').select('*').eq('org_id', SRS_ORG_ID)).data || [])
    .filter((r: any) => !r.deleted_at);
  const idMap = new Map<string, string>();
  for (const r of src as any[]) idMap.set(r.id, randomUUID());
  const capCities = ALL_CITIES; // PASA territory as the city cap for every designation
  const rows = (src as any[]).map((r: any) => {
    const row: any = { ...r };
    delete row.created_at; delete row.updated_at;
    row.id = idMap.get(r.id);
    row.org_id = PASA_ORG_ID;
    row.parent_id = r.parent_id ? (idMap.get(r.parent_id) || null) : null;
    row.assigned_cities = capCities; // re-scope from SRS territory to PASA's
    byName.set(r.name, row.id);
    return row;
  });
  log(`   · org_roles: copy ${rows.length} designations SRS→PASA`);
  if (!dry && rows.length) await insertChunked('org_roles', rows);

  // NEW designation: Consumer Sales Executive (own scope), under Area Sales Officer.
  if (!byName.has(NEW_DESIGNATION)) {
    const aso = (src as any[]).find(r => r.name === 'Area Sales Officer');
    const nid = randomUUID();
    const row: any = {
      id: nid, org_id: PASA_ORG_ID, name: NEW_DESIGNATION,
      parent_id: aso ? idMap.get(aso.id) : null,
      data_scope: 'own', position: (aso?.position ?? 0) + 1, color: aso?.color ?? '#6366f1',
      permissions: aso?.permissions ?? [], permissions_write: aso?.permissions_write ?? [],
      assigned_cities: capCities,
    };
    byName.set(NEW_DESIGNATION, nid);
    log(`   · org_roles: create NEW "${NEW_DESIGNATION}" (own, under Area Sales Officer)`);
    if (!dry) { const { error } = await db.from('org_roles').insert(row); if (error) throw new Error(`org_roles new: ${error.message}`); }
  }
  return byName;
}

// ── create or find a GoTrue login, returns the auth user id ─────────────────
async function ensureLogin(email: string, password: string, name: string): Promise<string> {
  if (dry) return '(dry)';
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

async function ensureUserRow(row: any) {
  if (dry) return;
  const { error } = await db.from('users').upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`users upsert ${row.email}: ${error.message}`);
}

async function commit() {
  log(`\n=== PASA onboarding (${dry ? 'DRY-RUN — NO WRITES' : 'COMMIT — WRITING'}) ===`);

  // 0. owner org (mirror BMW's owner) + SRS module list up front.
  const bmw = (await db.from('clients').select('owner_org_id').ilike('name', '%bmw%').maybeSingle()).data as any;
  const ownerOrg = bmw?.owner_org_id || OWNER_ORG_FALLBACK;
  const srsModules = ((await db.from('client_modules').select('module_id').eq('client_id', SRS_CLIENT_ID)).data || [])
    .map((m: any) => m.module_id);

  // 1. Organisation
  const orgExists = (await db.from('organisations').select('id').eq('id', PASA_ORG_ID).maybeSingle()).data;
  log(`1. organisation ${PASA_ORG_NAME} (${PASA_ORG_ID}) — ${orgExists ? 'exists' : 'create'}`);
  if (!dry && !orgExists) {
    const { error } = await db.from('organisations').insert({ id: PASA_ORG_ID, name: PASA_ORG_NAME, slug: PASA_ORG_SLUG });
    if (error) throw new Error(`org: ${error.message}`);
  }

  // 2. Client
  const clientExists = (await db.from('clients').select('id').eq('id', PASA_CLIENT_ID).maybeSingle()).data;
  log(`2. client ${PASA_ORG_NAME} (${PASA_CLIENT_ID}) owner_org=${ownerOrg} — ${clientExists ? 'exists' : 'create'}`);
  if (!dry && !clientExists) {
    const { error } = await db.from('clients').insert({
      id: PASA_CLIENT_ID, org_id: PASA_ORG_ID, owner_org_id: ownerOrg,
      name: PASA_ORG_NAME, contact_person: 'PASA Admin', email: ADMIN_EMAIL, is_active: true,
    });
    if (error) throw new Error(`client: ${error.message}`);
  }

  // 3. Seed CRM locations (36 states + cities) for the new org.
  log('3. seed CRM locations (crm_seed_indian_locations)');
  if (!dry) { try { await db.rpc('crm_seed_indian_locations', { p_org_id: PASA_ORG_ID }); } catch (e: any) { log('   ! location seed:', e?.message || e); } }

  // 4. Copy org-scoped config SRS → PASA.
  log('4. copy config SRS→PASA');
  const catMap = await copyTable('crm_product_categories');
  await copyTable('crm_products', (row) => { if (row.category_id && catMap.get(row.category_id)) row.category_id = catMap.get(row.category_id); });
  const pipeMap = await copyTable('crm_pipelines');
  await copyTable('crm_deal_stages', (row) => { if (row.pipeline_id && pipeMap.get(row.pipeline_id)) row.pipeline_id = pipeMap.get(row.pipeline_id); });
  await copyTable('crm_lead_sources');
  await copyTable('crm_custom_field_defs', (row) => { if (row.client_id === SRS_CLIENT_ID) row.client_id = PASA_CLIENT_ID; });
  await copyTable('crm_activity_subjects', (row) => { if (row.client_id === SRS_CLIENT_ID) row.client_id = PASA_CLIENT_ID; });
  // crm_settings (SRS had none → default blank row)
  const hasSettings = (await db.from('crm_settings').select('org_id').eq('org_id', PASA_ORG_ID).maybeSingle()).data;
  if (!hasSettings) { log('   · crm_settings: create default row'); if (!dry) await db.from('crm_settings').insert({ org_id: PASA_ORG_ID, business_type: 'both', config: {} }); }

  // 5. Designation tree (+ new Consumer Sales Executive).
  log('5. designations');
  const desigByName = await copyDesignations();
  const desigId = (name: string) => desigByName.get(name) || null;

  // 6. FFM cities for user_city_assignments (ensure each district exists in PASA org).
  log('6. ensure FFM cities for PASA territory');
  const cityIdByName = new Map<string, string>();
  {
    const existing = (await db.from('cities').select('id,name').eq('org_id', PASA_ORG_ID)).data || [];
    for (const c of existing as any[]) cityIdByName.set(String(c.name).toLowerCase(), c.id);
    const toCreate: any[] = [];
    for (const name of ALL_CITIES) {
      if (!cityIdByName.has(name.toLowerCase())) {
        const id = randomUUID();
        toCreate.push({ id, org_id: PASA_ORG_ID, name, state: CITY_STATE.get(name), client_id: null });
        cityIdByName.set(name.toLowerCase(), id);
      }
    }
    log(`   · FFM cities: ${ALL_CITIES.length} needed, ${toCreate.length} to create`);
    if (!dry && toCreate.length) await insertChunked('cities', toCreate);
  }
  const cityId = (name: string) => cityIdByName.get(name.toLowerCase());

  // 7. Admin (pasa@) — sub_admin + CRM Admin designation.
  log(`7. admin ${ADMIN_EMAIL} (sub_admin + CRM Admin)`);
  if (!dry) {
    const adminId = await ensureLogin(ADMIN_EMAIL, ADMIN_PASSWORD, 'PASA Admin');
    await ensureUserRow({
      id: adminId, org_id: PASA_ORG_ID, client_id: PASA_CLIENT_ID, name: 'PASA Admin',
      email: ADMIN_EMAIL, mobile: '', role: 'sub_admin', org_role_id: desigId('CRM Admin'), is_active: true,
    });
  }

  // 8. Users.
  log(`8. users (${PASA_USERS.length})`);
  let created = 0, existing = 0, assigns = 0;
  for (const u of PASA_USERS) {
    const orgRole = desigId(u.designation);
    // scope: explicit districts, or (state-level BM) the whole state's districts.
    const scopeCities = u.stateLevel ? citiesForState(u.state) : u.cities;
    log(`   - ${u.name} · ${u.designation} · ${orgRole ? '' : '[NO DESIG] '}scope=[${scopeCities.join(', ') || (u.pendingLocation ? 'PENDING' : '—')}]`);
    if (dry) { created++; assigns += scopeCities.length; continue; }
    // idempotent: reuse the login if this PASA user already exists, else create it.
    const dup = (await db.from('users').select('id').eq('org_id', PASA_ORG_ID).eq('email', u.email).maybeSingle()).data as any;
    let uid: string;
    if (dup) { uid = dup.id; existing++; } else { uid = await ensureLogin(u.email, TEMP_PASSWORD, u.name); created++; }
    await ensureUserRow({
      id: uid, org_id: PASA_ORG_ID, client_id: PASA_CLIENT_ID, name: u.name, email: u.email,
      mobile: u.mobile, role: 'sub_admin', org_role_id: orgRole, city: u.cities[0] || null, is_active: true,
    });
    // City scope (user_city_assignments = user_id + city_id; no org_id column).
    // Replace so re-runs converge and a previously-failed user is repaired.
    const rows = scopeCities.map(c => ({ user_id: uid, city_id: cityId(c) })).filter(r => r.city_id);
    await db.from('user_city_assignments').delete().eq('user_id', uid);
    if (rows.length) { await insertChunked('user_city_assignments', rows); assigns += rows.length; }
  }
  log(`   → users new=${created} existing=${existing} city_assignments=${assigns}`);

  // 9. Client modules (mirror SRS).
  log(`9. client_modules (${srsModules.length} from SRS)`);
  if (!dry && srsModules.length) {
    const payload = srsModules.map((m: string) => ({ client_id: PASA_CLIENT_ID, module_id: m, enabled: true, source: 'manual' }));
    const { error } = await db.from('client_modules').upsert(payload, { onConflict: 'client_id,module_id' });
    if (error) throw new Error(`client_modules: ${error.message}`);
  }

  log(`\n=== ${dry ? 'DRY-RUN complete (nothing written)' : 'COMMIT complete'} ===`);
  log(`PASA org=${PASA_ORG_ID} client=${PASA_CLIENT_ID}`);
  log(`Designations: ${Array.from(desigByName.keys()).join(', ')}`);
}

async function main() {
  log(`[onboard-pasa] mode=${MODE} project=${DEFAULT_PROJECT} node_env=${process.env.NODE_ENV}`);
  if (MODE === 'inspect') return inspect();
  return commit();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[onboard-pasa] FAILED:', e?.stack || e);
  process.exit(1);
});

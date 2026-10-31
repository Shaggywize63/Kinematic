/* eslint-disable no-console */
/**
 * DVGPL "Retailer Survey" — seed a Form Builder form for the DVGPL client on
 * the KINEMATIC tenant (project `kinematic`), linked to a DVGPL-scoped
 * `Retailer Survey` activity.
 *
 * This is the field survey for Dairy Fun ice-cream retailers. It mirrors the
 * paper sheet with two deliberate changes requested by the client:
 *   • the "Follow-up Details" section is removed;
 *   • a new "Order Information" section is added — Order Received (Yes/No) and,
 *     only when Yes, Boxes Quantity + Order Value (conditional via
 *     depends_on_id / depends_on_value, which both apps evaluate
 *     case-insensitively).
 * The General Information "Distributor Name" field is a dropdown of the DVGPL
 * distributor list.
 *
 * Hard client isolation: the form (and its linked activity) are stamped with
 * DVGPL's client_id, so only DVGPL dashboards and DVGPL mobile reps see them
 * (see migration_builder_forms_client_id.sql + the builder read filters).
 *
 * Run as a ONE-OFF ECS task on the backend image (same pattern as
 * onboard-pasa.ts) so it inherits the backend's service-role connection.
 *
 * Modes (argv):
 *   --inspect  (default) READ-ONLY. Lists the kinematic clients so you can
 *              confirm the DVGPL client id, and reports whether the form exists.
 *   --dry-run  Prints the exact create plan — NO writes.
 *   --commit   Performs the idempotent writes.
 *
 * Options:
 *   --client-id=<uuid>   Use this DVGPL client id instead of discovering by name.
 *   --publish            Create the form as `published` (live for apps) instead
 *                        of `draft`. Default is draft so an admin can review it
 *                        in the builder and publish with one click.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { adminClientFor } from '../lib/projects';

const PROJECT = 'kinematic';
const CLIENT_NAME_MATCH = 'dvgpl'; // case-insensitive substring match on clients.name
const ACTIVITY_NAME = 'Retailer Survey';
const FORM_TITLE = 'Retailer Survey';
const FORM_DESCRIPTION = 'Dairy Fun retailer market survey — shop, freezer, competitor and order details.';

const MODE: 'inspect' | 'dry-run' | 'commit' =
  process.argv.includes('--commit') ? 'commit'
  : process.argv.includes('--dry-run') ? 'dry-run'
  : 'inspect';
const dry = MODE !== 'commit';
const PUBLISH = process.argv.includes('--publish');
const CLIENT_ID_ARG = (process.argv.find((a) => a.startsWith('--client-id=')) || '').split('=')[1] || '';

const db = adminClientFor(PROJECT);

// ── DVGPL distributor list (General Information → Distributor Name dropdown) ──
const DISTRIBUTORS = [
  'Ayance Traders',
  'VS Enterprises',
  'KK Brothers',
  'Mubeen Enterprises',
  'Gurtaran Enterprises',
  'Gaurav Enterprises',
  'Mehroz Enterprises Kanpur',
];

type Opt = { label: string; value: string };
const opts = (labels: string[]): Opt[] => labels.map((l) => ({ label: l, value: l }));

// ── Question specs (stable `key` → resolved to a UUID + q_order at build time).
//    `section` rows are section_header dividers. `dep`/`depVal` wire conditional
//    visibility (depends_on_id = the referenced key's question id). ──
type QSpec = {
  key: string;
  qtype: string;
  label: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  dep?: string;      // key of the question this one depends on
  depVal?: string;   // value that reveals this question
};

const SECTIONS: QSpec[] = [
  // 1. General Information
  { key: 'sec_general', qtype: 'section_header', label: '1. General Information' },
  { key: 'survey_date', qtype: 'date', label: 'Survey Date', required: true },
  { key: 'sales_exec', qtype: 'short_text', label: 'Sales Executive Name' },
  { key: 'distributor', qtype: 'dropdown', label: 'Distributor Name', required: true, options: DISTRIBUTORS },
  { key: 'territory', qtype: 'short_text', label: 'Territory / Area' },
  { key: 'market_beat', qtype: 'short_text', label: 'Market / Beat' },

  // 2. Retailer Details
  { key: 'sec_retailer', qtype: 'section_header', label: '2. Retailer Details' },
  { key: 'shop_name', qtype: 'short_text', label: 'Shop Name', required: true },
  { key: 'owner_name', qtype: 'short_text', label: 'Owner Name' },
  { key: 'mobile', qtype: 'phone', label: 'Mobile Number' },
  { key: 'address', qtype: 'long_text', label: 'Full Shop Address' },
  { key: 'shop_type', qtype: 'dropdown', label: 'Shop Type', options: ['General Store', 'Bakery', 'Confectionery', 'Juice & Shake Shop', 'Restaurant', 'Other'] },
  { key: 'gps', qtype: 'location', label: 'GPS Location' },

  // 3. Current Ice Cream Business
  { key: 'sec_current', qtype: 'section_header', label: '3. Current Ice Cream Business' },
  { key: 'selling_ice_cream', qtype: 'yes_no', label: 'Currently Selling Ice Cream' },
  { key: 'brands_available', qtype: 'checkbox', label: 'Brands Available', options: ['Dairy Fun', 'Amul', 'Vadilal', 'Cream Bell', "Kwality Wall's", 'Havmor', 'Other'] },
  { key: 'monthly_sales', qtype: 'number', label: 'Approximate Monthly Ice Cream Sales (₹)' },
  { key: 'peak_sales', qtype: 'number', label: 'Peak Season Monthly Sales (₹)' },
  { key: 'main_products', qtype: 'checkbox', label: 'Main Selling Products', options: ['Cups', 'Cones', 'Sticks', 'Family Packs', 'Kulfi', 'Other'] },
  { key: 'daily_sales', qtype: 'number', label: 'Average Daily Ice Cream Sales (₹)' },

  // 4. Freezer Details
  { key: 'sec_freezer', qtype: 'section_header', label: '4. Freezer Details' },
  { key: 'freezer_available', qtype: 'yes_no', label: 'Freezer Available' },
  { key: 'freezer_brand', qtype: 'short_text', label: 'Freezer Brand' },
  { key: 'freezer_type', qtype: 'short_text', label: 'Freezer Type / Capacity' },
  { key: 'freezer_count', qtype: 'number', label: 'Number of Freezers' },
  { key: 'freezer_ownership', qtype: 'dropdown', label: 'Freezer Ownership', options: ['Company', 'Retailer-Owned'] },
  { key: 'competitor_freezer', qtype: 'yes_no', label: 'Competitor Freezer Available' },
  { key: 'additional_freezer', qtype: 'yes_no', label: 'Additional Freezer Required' },

  // 5. Competitor Information
  { key: 'sec_competitor', qtype: 'section_header', label: '5. Competitor Information' },
  { key: 'comp_brand', qtype: 'short_text', label: 'Main Competitor Brand' },
  { key: 'comp_distributor', qtype: 'short_text', label: 'Competitor Distributor Name' },
  { key: 'comp_margin', qtype: 'short_text', label: 'Retailer Margin / Discount' },
  { key: 'comp_schemes', qtype: 'long_text', label: 'Competitor Schemes / Offers' },
  { key: 'comp_deposit', qtype: 'number', label: 'Competitor Freezer Deposit (₹)' },
  { key: 'credit_facility', qtype: 'yes_no', label: 'Credit Facility Available' },

  // 6. Dairy Fun Sales Opportunity
  { key: 'sec_opportunity', qtype: 'section_header', label: '6. Dairy Fun Sales Opportunity' },
  { key: 'selling_dairyfun', qtype: 'yes_no', label: 'Currently Selling Dairy Fun' },
  { key: 'interested_dairyfun', qtype: 'yes_no', label: 'Interested in Dairy Fun' },
  { key: 'expected_monthly', qtype: 'number', label: 'Expected Monthly Dairy Fun Sales (₹)' },
  { key: 'required_capacity', qtype: 'short_text', label: 'Required Freezer Capacity' },
  { key: 'expected_opening_order', qtype: 'number', label: 'Expected Opening Order (₹)' },
  { key: 'expected_discount', qtype: 'short_text', label: 'Expected Retailer Discount' },
  { key: 'reason_not_selling', qtype: 'long_text', label: 'Reason for Not Selling Dairy Fun' },

  // 7. Sales Executive Remarks
  { key: 'sec_remarks', qtype: 'section_header', label: '7. Sales Executive Remarks' },
  { key: 'remarks', qtype: 'long_text', label: 'Remarks' },

  // 8. Order Information  (replaces the paper form's Follow-up Details)
  { key: 'sec_order', qtype: 'section_header', label: '8. Order Information' },
  { key: 'order_received', qtype: 'yes_no', label: 'Order Received', required: true },
  { key: 'order_boxes', qtype: 'number', label: 'Boxes Quantity', dep: 'order_received', depVal: 'Yes' },
  { key: 'order_value', qtype: 'number', label: 'Order Value (₹)', dep: 'order_received', depVal: 'Yes' },
];

function log(...a: unknown[]) { console.log(...a); }

async function inspect() {
  const { data: clients, error } = await db.from('clients')
    .select('id,name,org_id,is_active,created_at').order('name');
  if (error) throw new Error(`clients: ${error.message}`);
  const dvgpl = (clients || []).filter((c: any) => String(c.name).toLowerCase().includes(CLIENT_NAME_MATCH));
  const report = {
    project: PROJECT,
    client_name_match: CLIENT_NAME_MATCH,
    dvgpl_candidates: dvgpl,
    all_clients: clients,
  };
  console.log('DVGPL_INSPECT_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('DVGPL_INSPECT_REPORT_END');
  if (dvgpl.length === 1) {
    const c = dvgpl[0] as any;
    const existing = (await db.from('builder_forms')
      .select('id,title,status,client_id,activity_id')
      .eq('org_id', c.org_id).eq('client_id', c.id).eq('title', FORM_TITLE)).data || [];
    log(`\nDVGPL client = ${c.name} (${c.id}) org=${c.org_id}`);
    log(existing.length ? `Form "${FORM_TITLE}" already exists: ${JSON.stringify(existing)}` : `Form "${FORM_TITLE}" not yet present.`);
  } else {
    log(`\n${dvgpl.length} DVGPL candidate(s). Pass --client-id=<uuid> to pin the exact client.`);
  }
}

async function resolveClient(): Promise<{ id: string; org_id: string; name: string }> {
  if (CLIENT_ID_ARG) {
    const { data, error } = await db.from('clients').select('id,name,org_id').eq('id', CLIENT_ID_ARG).maybeSingle();
    if (error) throw new Error(`clients: ${error.message}`);
    if (!data) throw new Error(`No client with id ${CLIENT_ID_ARG} on project ${PROJECT}.`);
    return data as any;
  }
  const { data, error } = await db.from('clients').select('id,name,org_id').ilike('name', `%${CLIENT_NAME_MATCH}%`);
  if (error) throw new Error(`clients: ${error.message}`);
  const rows = (data || []) as any[];
  if (rows.length === 0) throw new Error(`No client matching "${CLIENT_NAME_MATCH}" on project ${PROJECT}. Run --inspect, then pass --client-id=<uuid>.`);
  if (rows.length > 1) throw new Error(`${rows.length} clients match "${CLIENT_NAME_MATCH}": ${rows.map((r) => `${r.name} (${r.id})`).join(', ')}. Pin one with --client-id=<uuid>.`);
  return rows[0];
}

async function ensureActivity(orgId: string, clientId: string): Promise<string> {
  const { data: found } = await db.from('activities')
    .select('id').eq('org_id', orgId).eq('client_id', clientId).eq('name', ACTIVITY_NAME).maybeSingle();
  if (found) { log(`   · activity "${ACTIVITY_NAME}" exists (${(found as any).id}) — reuse`); return (found as any).id; }
  const id = randomUUID();
  log(`   · activity "${ACTIVITY_NAME}" — create (${id})`);
  if (!dry) {
    // `activities.type` is a NOT-NULL enum (no default). SURVEY is the
    // field-force activity type for a retailer market survey.
    const { error } = await db.from('activities').insert({
      id, org_id: orgId, client_id: clientId, name: ACTIVITY_NAME, type: 'SURVEY', icon: '🍦', color: '#E01E2C', is_active: true,
    });
    if (error) throw new Error(`activities insert: ${error.message}`);
  }
  return id;
}

async function commit() {
  log(`\n=== DVGPL Retailer Survey seed (${dry ? 'DRY-RUN — NO WRITES' : 'COMMIT — WRITING'}) · project=${PROJECT} ===`);
  const client = await resolveClient();
  log(`1. DVGPL client = ${client.name} (${client.id}) org=${client.org_id}`);

  // Idempotent: if the form already exists for this client, stop (don't duplicate).
  const { data: existing } = await db.from('builder_forms')
    .select('id,status').eq('org_id', client.org_id).eq('client_id', client.id).eq('title', FORM_TITLE).maybeSingle();
  if (existing) {
    log(`2. form "${FORM_TITLE}" already exists (${(existing as any).id}, status=${(existing as any).status}) — nothing to do.`);
    log(`   Delete it in the builder (or by id) and re-run if you want a fresh copy.`);
    return;
  }

  log('2. linked activity');
  const activityId = await ensureActivity(client.org_id, client.id);

  const formId = randomUUID();
  const pageId = randomUUID();
  const status = PUBLISH ? 'published' : 'draft';
  log(`3. form "${FORM_TITLE}" (${formId}) status=${status} activity=${activityId}`);
  log(`   ${SECTIONS.length} questions (${SECTIONS.filter((s) => s.qtype === 'section_header').length} sections, distributor dropdown = ${DISTRIBUTORS.length} options)`);

  // Resolve each spec to a row with a stable id + sequential q_order.
  const idByKey = new Map<string, string>();
  for (const s of SECTIONS) idByKey.set(s.key, randomUUID());
  const questionRows = SECTIONS.map((s, i) => ({
    id: idByKey.get(s.key)!,
    form_id: formId,
    page_id: pageId,
    qtype: s.qtype,
    label: s.label,
    is_required: !!s.required,
    q_order: i,
    options: s.options ? opts(s.options) : [],
    validation: {},
    logic: [],
    placeholder: s.placeholder ?? null,
    depends_on_id: s.dep ? idByKey.get(s.dep)! : null,
    depends_on_value: s.depVal ?? null,
    keyboard_type: s.qtype === 'number' ? 'number' : s.qtype === 'phone' ? 'phone' : 'default',
    image_count: 1,
    camera_only: false,
    is_consent: false,
    media_config: {},
  }));

  if (dry) {
    log('\n   PLAN (questions):');
    for (const r of questionRows) {
      const dep = r.depends_on_id ? ` [shown when "${SECTIONS.find((s) => idByKey.get(s.key) === r.depends_on_id)?.label}" = ${r.depends_on_value}]` : '';
      const o = (r.options as Opt[]).length ? ` {${(r.options as Opt[]).map((x) => x.label).join(', ')}}` : '';
      log(`   ${String(r.q_order).padStart(2)}. ${r.qtype.padEnd(14)} ${r.label}${r.is_required ? ' *' : ''}${o}${dep}`);
    }
    log('\n=== DRY-RUN complete (nothing written) ===');
    return;
  }

  // form → page → questions
  const { error: ef } = await db.from('builder_forms').insert({
    id: formId, org_id: client.org_id, client_id: client.id,
    title: FORM_TITLE, description: FORM_DESCRIPTION,
    icon: '🍦', cover_color: '#E01E2C', status, version: 1,
    activity_id: activityId, requires_photo: false, requires_gps: true,
  });
  if (ef) throw new Error(`builder_forms insert: ${ef.message}`);

  const { error: ep } = await db.from('builder_pages').insert({
    id: pageId, form_id: formId, title: 'Retailer Survey', page_order: 0,
  });
  if (ep) throw new Error(`builder_pages insert: ${ep.message}`);

  const { error: eq } = await db.from('builder_questions').insert(questionRows);
  if (eq) throw new Error(`builder_questions insert: ${eq.message}`);

  log(`\n=== COMMIT complete ===`);
  log(`form=${formId} client=${client.id} org=${client.org_id} activity=${activityId} status=${status} questions=${questionRows.length}`);
  if (!PUBLISH) log(`Form is a DRAFT — open it in Form Builder and publish to make it live for DVGPL reps (or re-run with --publish).`);
}

async function main() {
  log(`[seed-dvgpl-retailer-survey] mode=${MODE} project=${PROJECT} publish=${PUBLISH} node_env=${process.env.NODE_ENV}`);
  if (MODE === 'inspect') return inspect();
  return commit();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[seed-dvgpl-retailer-survey] FAILED:', e?.stack || e);
  process.exit(1);
});

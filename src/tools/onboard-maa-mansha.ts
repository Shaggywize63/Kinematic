/* eslint-disable no-console */
/**
 * Onboard "Maa Mansha Pharma" — a pharmaceutical distribution client under the
 * KINEMATIC tenant (Field-Force + CRM + the daily tele-calling desk).
 *
 * Modelled on onboard-aadinath.ts. ADOPTS a client that was already created via
 * the Client Management UI / POST /api/v1/clients and configures everything the
 * pharma workflow needs WITHOUT creating any field staff (the real MR + desk
 * roster is loaded later from the customer/staff master):
 *   - module grants  (field_force + crm + analytics packages, strict project)
 *   - designations   (Owner / Desk Operator / MR) — the desk operator role is
 *                     what generateDailyCallList() resolves callers against
 *   - CRM config     (pharma lead statuses, field overrides, lead sources,
 *                     custom fields, the 3 call-status labels, calling-desk +
 *                     customer-intel settings)
 *   - attendance rules + org_settings
 *
 * Runs as a one-off ECS task on the backend image against the kinematic
 * Supabase project (service role). Idempotent. Modes (env ONBOARD_MODE):
 *   inspect (default, read-only) | dry (resolve + log, no writes) | commit.
 *
 * Org/client are resolved from env ORG_ID / CLIENT_ID when provided, else looked
 * up by client name (CLIENT_NAME, default "Maa Mansha Pharma").
 *
 *   ONBOARD_MODE=inspect node dist/tools/onboard-maa-mansha.js
 *   ONBOARD_MODE=commit  node dist/tools/onboard-maa-mansha.js
 */
import { randomUUID } from 'crypto';
import { adminClientFor } from '../lib/projects';

const PROJECT = 'kinematic';
const db = adminClientFor(PROJECT);

const MODE: 'inspect' | 'dry' | 'commit' =
  (process.env.ONBOARD_MODE as any) === 'commit' ? 'commit'
  : (process.env.ONBOARD_MODE as any) === 'dry' ? 'dry'
  : 'inspect';
const dry = MODE !== 'commit';

const CLIENT_NAME = process.env.CLIENT_NAME || 'Maa Mansha Pharma';
let ORG_ID = process.env.ORG_ID || '';
let CLIENT_ID = process.env.CLIENT_ID || '';

// Grant the full field_force + crm packages plus these explicit ids (the daily
// calling desk gates on crm_activities; customer intelligence on analytics).
const REQUIRE_MODULES = [
  'attendance', 'face_attendance', 'activities', 'field_expenses', 'analytics',
  'live_tracking', 'visit_logs', 'route_plan', 'route_optimization', 'route_deviation', 'beat_productivity',
  'crm', 'crm_leads', 'crm_deals', 'crm_contacts', 'crm_accounts', 'crm_activities', 'crm_settings',
  'leaderboard', 'broadcast',
];

// Pharma lead lifecycle (the CRM pipeline; distinct from the 3 CALL statuses).
const LEAD_STATUSES = [
  { value: 'new',             label: 'New Customer',     is_open: true, position: 1, color: '#3b82f6' },
  { value: 'contacted',       label: 'Contacted',        is_open: true, position: 2, color: '#6366f1' },
  { value: 'ordering',        label: 'Ordering',         is_open: true, position: 3, color: '#16a34a' },
  { value: 'regular',         label: 'Regular Customer', is_open: true, position: 4, color: '#0ea5e9' },
  { value: 'dormant',         label: 'Dormant',          is_open: true, position: 5, color: '#f59e0b' },
  { value: 'lost',            label: 'Lost',             is_lost: true, position: 6, color: '#dc2626' },
];

// The 3 pharma CALL dispositions (desk). Stored so the dashboard + apps render
// the client's exact wording and colours over the fixed status keys.
const CALL_STATUSES = [
  { value: 'order_taken',   label: 'Call Connected – Order Taken',   color: '#16a34a' },
  { value: 'order_pending', label: 'Call Connected – Order Pending', color: '#f59e0b' },
  { value: 'no_order',      label: 'No Order Today',                 color: '#6b7280' },
];

const LOST_REASONS = [
  { value: 'switched_supplier',  label: 'Switched to another supplier' },
  { value: 'price',              label: 'Price / scheme not competitive' },
  { value: 'shop_closed',        label: 'Shop closed / shut down' },
  { value: 'payment_dispute',    label: 'Payment / credit dispute' },
  { value: 'no_requirement',     label: 'No current requirement' },
  { value: 'other',              label: 'Other', requires_comment: true },
];

// Pharma field overrides — hide B2C/consumer fields, relabel for a chemist book.
const FIELD_OVERRIDES: Record<string, any> = {
  'lead.title': { hidden: true }, 'lead.industry': { hidden: true }, 'lead.score': { hidden: true },
  'lead.is_b2c': { hidden: true }, 'lead.country': { hidden: true },
  'lead.marketing_consent': { hidden: true }, 'lead.whatsapp_consent': { hidden: true }, 'lead.data_consent': { hidden: true },
  'lead.date_of_birth': { hidden: true }, 'lead.gender': { hidden: true },
  'lead.preferred_contact_method': { hidden: true }, 'lead.address_line2': { hidden: true },
  'lead.phone': { label: 'Mobile Number', required: true },
  'lead.company': { label: 'Firm / Chemist Name', required: true },
  'lead.email': { label: 'Email (optional)' },
  'lead.address_line1': { label: 'Shop Address' },
  'lead.city': { label: 'City / Town', required: true }, 'lead.state': { label: 'State' },
};

// Pharma-specific custom fields on the customer record.
const CUSTOM_FIELDS = [
  { field_key: 'customer_type',   label: 'Customer Type',      field_type: 'select',  position: 1, options: ['Chemist / Pharmacy', 'Hospital', 'Nursing Home', 'Clinic', 'Doctor', 'Stockist', 'Wholesaler', 'Retailer'] },
  { field_key: 'drug_license_no', label: 'Drug Licence No.',   field_type: 'text',    position: 2 },
  { field_key: 'gstin',           label: 'GSTIN',              field_type: 'text',    position: 3 },
  { field_key: 'credit_days',     label: 'Credit Days',        field_type: 'number',  position: 4 },
  { field_key: 'beat_name',       label: 'Beat / Route',       field_type: 'text',    position: 5 },
  { field_key: 'next_follow_up_date', label: 'Next Follow-up', field_type: 'date',    position: 6 },
];

const LEAD_SOURCES = [
  { name: 'Existing Customer', type: 'referral' }, { name: 'MR Field Visit', type: 'manual' },
  { name: 'Desk / Tele-calling', type: 'manual' }, { name: 'Doctor Referral', type: 'referral' },
  { name: 'Walk-in', type: 'manual' }, { name: 'Camp / Event', type: 'event' },
];

const ATTENDANCE_RULES = {
  shift_start: '09:30', shift_end: '18:30', grace_minutes: 15, weekly_off: [0],
  selfie_required: true, allow_offline_checkin: true, form_checkin_required: false,
  track_transport_mode: true, required_minutes: 510, half_day_cutoff: '13:30',
};

// Calling-desk + customer-intelligence settings (read by desk.service /
// customerIntel.service). customer_source 'accounts' = the chemist master.
const CALLING_DESK = { customer_source: 'accounts', operator_role_name: 'Desk Operator', auto_assign: true };
const CUSTOMER_INTEL = { dormant_days: 30, churned_days: 90, new_window_days: 30 };

function log(...a: unknown[]) { console.log('[maa-mansha]', ...a); }

async function resolveClient(): Promise<void> {
  if (ORG_ID && CLIENT_ID) { log(`using env ids org=${ORG_ID} client=${CLIENT_ID}`); return; }
  const { data, error } = await db.from('clients').select('id, org_id, name').ilike('name', `${CLIENT_NAME}%`).limit(10);
  if (error) throw new Error(`client lookup failed: ${error.message}`);
  const rows = (data as any[]) || [];
  if (!rows.length) throw new Error(`no client found matching "${CLIENT_NAME}" in project ${PROJECT}. Create it via Client Management first, or pass ORG_ID/CLIENT_ID.`);
  if (rows.length > 1) throw new Error(`ambiguous: ${rows.length} clients match "${CLIENT_NAME}" (${rows.map((r) => r.id).join(', ')}). Pass CLIENT_ID.`);
  CLIENT_ID = rows[0].id; ORG_ID = rows[0].org_id;
  log(`resolved client "${rows[0].name}" org=${ORG_ID} client=${CLIENT_ID}`);
}

async function resolveGrantModuleIds(): Promise<string[]> {
  const cat = (await db.from('modules').select('id,package,is_universal').limit(1000)).data as any[] | null || [];
  const grant = new Set<string>();
  for (const m of cat) { if (m.is_universal) continue; if (m.package === 'field_force' || m.package === 'crm') grant.add(m.id); }
  const ids = new Set(cat.map((m) => m.id));
  for (const id of REQUIRE_MODULES) if (ids.has(id)) grant.add(id);
  return [...grant].sort();
}

async function ensureDesignation(name: string, scope: 'own' | 'team', position: number, grant: string[]): Promise<string> {
  const existing = (await db.from('org_roles').select('id,permissions,permissions_write')
    .eq('org_id', ORG_ID).eq('name', name).is('deleted_at', null).maybeSingle()).data as any;
  if (existing?.id) {
    const merged = [...new Set([...(existing.permissions || []), ...grant])];
    if (!dry) { const { error } = await db.from('org_roles').update({ permissions: merged, permissions_write: merged }).eq('id', existing.id); if (error) throw new Error(`org_roles ${name}: ${error.message}`); }
    return existing.id;
  }
  const id = randomUUID();
  if (!dry) {
    const { error } = await db.from('org_roles').insert({
      id, org_id: ORG_ID, client_id: CLIENT_ID, name, parent_id: null, data_scope: scope, position,
      color: scope === 'team' ? '#2563eb' : '#6366f1', permissions: grant, permissions_write: grant, assigned_cities: [],
    });
    if (error) throw new Error(`org_roles ${name}: ${error.message}`);
  }
  return id;
}

async function commit() {
  log(`MODE=${MODE}`);
  await resolveClient();
  const grant = await resolveGrantModuleIds();
  log(`modules=${grant.length}`);

  log('designations (Owner / Desk Operator / MR)');
  await ensureDesignation('Owner', 'team', 0, [...grant, 'users']);
  await ensureDesignation('Desk Operator', 'own', 1, [...new Set([...grant, 'crm', 'crm_leads', 'crm_accounts', 'crm_activities', 'analytics'])]);
  await ensureDesignation('MR', 'own', 2, [...new Set([...grant, 'attendance', 'live_tracking', 'visit_logs', 'route_plan', 'crm', 'crm_accounts', 'crm_activities'])]);
  log('NOTE: no field staff created — load the real MR + desk roster from the staff master, assigning each to the matching designation.');

  log(`client_modules (${grant.length})`);
  if (!dry && grant.length) {
    const payload = grant.map((m) => ({ client_id: CLIENT_ID, module_id: m, enabled: true, source: 'manual' }));
    const { error } = await db.from('client_modules').upsert(payload, { onConflict: 'client_id,module_id' });
    if (error) throw new Error(`client_modules: ${error.message}`);
  }

  log('CRM config (statuses, call-status labels, field overrides, desk + intel settings)');
  const existing = (await db.from('crm_settings').select('id,config').eq('org_id', ORG_ID).eq('client_id', CLIENT_ID).maybeSingle()).data as any;
  const config = {
    ...(existing?.config || {}),
    lead_statuses: LEAD_STATUSES, lost_reasons: LOST_REASONS,
    call_statuses: CALL_STATUSES,
    calling_desk: { ...((existing?.config?.calling_desk) || {}), ...CALLING_DESK },
    customer_intel: { ...((existing?.config?.customer_intel) || {}), ...CUSTOMER_INTEL },
    field_overrides: { ...((existing?.config?.field_overrides) || {}), ...FIELD_OVERRIDES },
  };
  if (!dry) {
    if (existing?.id) { const { error } = await db.from('crm_settings').update({ config, business_type: 'b2b' }).eq('id', existing.id); if (error) throw new Error(`crm_settings: ${error.message}`); }
    else { const { error } = await db.from('crm_settings').insert({ org_id: ORG_ID, client_id: CLIENT_ID, business_type: 'b2b', config }); if (error) throw new Error(`crm_settings: ${error.message}`); }
  }

  const haveSrc = (await db.from('crm_lead_sources').select('id').eq('org_id', ORG_ID).eq('client_id', CLIENT_ID)).data || [];
  if (!dry && !haveSrc.length) { const { error } = await db.from('crm_lead_sources').insert(LEAD_SOURCES.map((s) => ({ org_id: ORG_ID, client_id: CLIENT_ID, name: s.name, type: s.type, is_active: true }))); if (error) throw new Error(`lead_sources: ${error.message}`); }

  const haveCf = ((await db.from('crm_custom_field_defs').select('field_key').eq('org_id', ORG_ID).eq('client_id', CLIENT_ID).eq('entity_type', 'lead')).data || []).map((r: any) => r.field_key);
  const toCreate = CUSTOM_FIELDS.filter((f) => !haveCf.includes(f.field_key));
  if (!dry && toCreate.length) { const { error } = await db.from('crm_custom_field_defs').insert(toCreate.map((f) => ({ org_id: ORG_ID, client_id: CLIENT_ID, entity_type: 'lead', field_key: f.field_key, label: f.label, field_type: f.field_type, options: (f as any).options || null, required: !!(f as any).required, hidden: false, position: f.position, is_active: true }))); if (error) throw new Error(`custom_fields: ${error.message}`); }

  log('attendance rules + org_settings');
  if (!dry) {
    const cur = (await db.from('clients').select('settings').eq('id', CLIENT_ID).maybeSingle()).data as any;
    const settings = { ...((cur?.settings) || {}), attendance_rules: { ...((cur?.settings?.attendance_rules) || {}), ...ATTENDANCE_RULES } };
    const { error } = await db.from('clients').update({ settings }).eq('id', CLIENT_ID); if (error) throw new Error(`attendance_rules: ${error.message}`);
    for (const [key, value] of [['attendance_auto_checkout', false], ['attendance_checkout_reminder', true]] as const) {
      await db.from('org_settings').delete().eq('org_id', ORG_ID).eq('key', key);
      const { error: e2 } = await db.from('org_settings').insert({ org_id: ORG_ID, key, value }); if (e2) throw new Error(`org_settings ${key}: ${e2.message}`);
    }
  }
  log(`DONE (${dry ? 'DRY' : 'COMMIT'}) org=${ORG_ID} client=${CLIENT_ID}`);
}

async function inspect() {
  await resolveClient();
  const org = (await db.from('organisations').select('id,name').eq('id', ORG_ID).maybeSingle()).data;
  const client = (await db.from('clients').select('id,name').eq('id', CLIENT_ID).maybeSingle()).data;
  const settings = (await db.from('crm_settings').select('config').eq('org_id', ORG_ID).eq('client_id', CLIENT_ID).maybeSingle()).data as any;
  log('INSPECT', {
    org: !!org, client: !!client, grant: (await resolveGrantModuleIds()).length,
    has_call_statuses: !!settings?.config?.call_statuses, has_calling_desk: !!settings?.config?.calling_desk,
  });
}

(async () => {
  log(`start mode=${MODE}`);
  if (MODE === 'inspect') await inspect(); else await commit();
  process.exit(0);
})().catch((e) => { console.error('[maa-mansha] FAILED', e?.stack || e); process.exit(1); });

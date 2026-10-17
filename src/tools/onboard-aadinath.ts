/* eslint-disable no-console */
/**
 * Onboard "Aadinath Peripherals & Consumables" — CRM + Field-Force client under
 * the KINEMATIC tenant. Modelled on onboard-byteback.ts (Kinematic-tenant org/
 * client/users) + onboard-pasa.ts (CRM config), but ADOPTS a client that was
 * already created via POST /api/v1/clients (admin "Mitali"
 * <aadinath@kinematicapp.com>, 27 default CRM modules). It adds only what was
 * missing — designations, the 8 team seats, the field-force module grants, the
 * lead-management CRM config, and the attendance rules — and never touches the
 * existing client admin.
 *
 * Runs as a one-off ECS task on the backend image against the kinematic
 * Supabase project (service role). Idempotent. Modes (env ONBOARD_MODE):
 *   inspect (default, read-only) | dry (resolve + log, no writes) | commit.
 * Seat password is injected by reference (env SEAT_PASSWORD) — never in source.
 *
 *   ONBOARD_MODE=inspect node dist/tools/onboard-aadinath.js
 *   ONBOARD_MODE=commit  node dist/tools/onboard-aadinath.js
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

// Adopt the already-created org + client + admin.
const ORG_ID = '28098501-d112-4ddf-b827-847372d66dbc';
const CLIENT_ID = 'c8114586-86f5-446e-8944-287d6bdd273a';

const TEMP_PASSWORD = process.env.SEAT_PASSWORD || '';
if (MODE === 'commit' && !TEMP_PASSWORD) { console.error('[aadinath] missing SEAT_PASSWORD'); process.exit(1); }

type Seat = { name: string; email: string; mobile: string; placeholder: boolean };
// Members without an email in the requirement doc get a clearly-placeholder
// .example address (fix later in User Management); no mobiles were supplied so
// unique placeholders are assigned (users has a unique (org_id, mobile)).
const SALES: Seat[] = [
  { name: 'Abhishek', email: 'abhishek@aadinathp.com',      mobile: '9000000001', placeholder: false },
  { name: 'Pinesh',   email: 'ps.aadinathp@gmail.com',      mobile: '9000000002', placeholder: false },
  { name: 'Devika',   email: 'devikavedvanshi11@gmail.com', mobile: '9000000003', placeholder: false },
  { name: 'Mahesh',   email: 'mahesh@aadinathp.example',    mobile: '9000000004', placeholder: true },
  { name: 'Kiran',    email: 'kiran.pw@gmail.com',          mobile: '9000000005', placeholder: false },
];
const ENGINEERING: Seat[] = [
  { name: 'Manish',   email: 'manish@aadinathp.example',    mobile: '9000000006', placeholder: true },
  { name: 'Trushant', email: 'trushant@aadinathp.example',  mobile: '9000000007', placeholder: true },
  { name: 'Atish',    email: 'atish@aadinathp.example',     mobile: '9000000008', placeholder: true },
];

// Grant the full field_force + crm packages (Field Force Mgmt Advanced + Lead
// Management Advanced) plus these explicit ids in case they are universal/other.
const REQUIRE_MODULES = [
  'attendance', 'face_attendance', 'activities', 'field_expenses', 'analytics',
  'crm', 'crm_leads', 'crm_deals', 'crm_contacts', 'crm_accounts', 'crm_activities',
  'crm_settings', 'route_optimization', 'route_plan', 'route_deviation',
];

const LEAD_STATUSES = [
  { value: 'new_lead',       label: 'New Lead',       is_open: true, position: 1, color: '#3b82f6' },
  { value: 'contacted',      label: 'Contacted',      is_open: true, position: 2, color: '#6366f1' },
  { value: 'qualified',      label: 'Qualified',      is_open: true, position: 3, color: '#8b5cf6' },
  { value: 'quotation_sent', label: 'Quotation Sent', is_open: true, position: 4, color: '#a855f7' },
  { value: 'negotiation',    label: 'Negotiation',    is_open: true, position: 5, color: '#f59e0b' },
  { value: 'won',            label: 'Won',            is_won: true,  position: 6, color: '#16a34a' },
  { value: 'lost',           label: 'Lost',           is_lost: true, position: 7, color: '#dc2626' },
  { value: 'on_hold',        label: 'On Hold',        is_open: true, position: 8, color: '#6b7280' },
  { value: 'tender',         label: 'Tender',         is_open: true, position: 9, color: '#0ea5e9' },
];
const LOST_REASONS = [
  { value: 'price_too_high',        label: 'Price too high' },
  { value: 'competitor_selected',   label: 'Competitor selected' },
  { value: 'customer_unresponsive', label: 'Customer unresponsive' },
  { value: 'requirement_cancelled', label: 'Requirement cancelled' },
  { value: 'product_unavailable',   label: 'Product unavailable' },
  { value: 'delivery_timeline',     label: 'Delivery/timeline issue' },
  { value: 'budget_not_approved',   label: 'Budget not approved' },
  { value: 'tender_lost',           label: 'Tender lost' },
  { value: 'other',                 label: 'Other', requires_comment: true },
];
const FIELD_OVERRIDES: Record<string, any> = {
  'lead.title': { hidden: true }, 'lead.industry': { hidden: true }, 'lead.score': { hidden: true },
  'lead.is_b2c': { hidden: true }, 'lead.city': { hidden: true }, 'lead.state': { hidden: true },
  'lead.country': { hidden: true }, 'lead.marketing_consent': { hidden: true },
  'lead.whatsapp_consent': { hidden: true }, 'lead.data_consent': { hidden: true },
  'lead.date_of_birth': { hidden: true }, 'lead.gender': { hidden: true },
  'lead.preferred_contact_method': { hidden: true }, 'lead.address_line2': { hidden: true },
  'lead.postal_code': { hidden: true },
  'lead.phone': { label: 'Mobile Number', required: true }, 'lead.email': { label: 'Email Address' },
  'lead.company': { label: 'Company Name' }, 'lead.address_line1': { label: 'Company Address / Location' },
};
const CUSTOM_FIELDS = [
  { field_key: 'customer_type',       label: 'Customer Type',       field_type: 'select',   position: 1, options: ['Dealer', 'Distributor', 'Contractor', 'Corporate', 'Government/PSU', 'Retail'] },
  { field_key: 'product_category',    label: 'Product Category',    field_type: 'select',   position: 2, options: ['Printers', 'Cartridges & Toners', 'Computers & Laptops', 'Networking', 'CCTV & Security', 'Consumables', 'Accessories', 'Other'] },
  { field_key: 'requirement_details', label: 'Requirements',        field_type: 'longtext', position: 3 },
  { field_key: 'next_follow_up_date', label: 'Next Follow-up Date', field_type: 'date',     position: 4, required: true },
  { field_key: 'payment_status',      label: 'Payment Status',      field_type: 'select',   position: 5, options: ['Pending', 'Advance Received', 'Partial', 'Paid', 'Overdue', 'Not Applicable'] },
];
const LEAD_SOURCES = [
  { name: 'Website', type: 'web_form' }, { name: 'Referral', type: 'referral' },
  { name: 'Cold Call', type: 'manual' }, { name: 'Walk-in', type: 'manual' },
  { name: 'Exhibition / Event', type: 'event' }, { name: 'Tender Portal', type: 'manual' },
  { name: 'Social Media', type: 'social' }, { name: 'Existing Customer', type: 'referral' },
];
// required_minutes (8h30m) + half_day_cutoff (11:15) are honoured by
// attendanceRules.service.ts; the rest are the standard per-client keys.
const ATTENDANCE_RULES = {
  shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0],
  selfie_required: true, allow_offline_checkin: true, form_checkin_required: false,
  track_transport_mode: true, required_minutes: 510, half_day_cutoff: '11:15',
};

function log(...a: unknown[]) { console.log('[aadinath]', ...a); }

async function resolveGrantModuleIds(): Promise<string[]> {
  const cat = (await db.from('modules').select('id,package,is_universal').limit(1000)).data as any[] | null || [];
  const grant = new Set<string>();
  for (const m of cat) { if (m.is_universal) continue; if (m.package === 'field_force' || m.package === 'crm') grant.add(m.id); }
  const ids = new Set(cat.map((m) => m.id));
  for (const id of REQUIRE_MODULES) if (ids.has(id)) grant.add(id);
  return [...grant].sort();
}
async function ensureLogin(email: string, password: string, name: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
  if (!error && data?.user) return data.user.id;
  if (error && String(error.message || '').toLowerCase().includes('already')) {
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 } as any);
    const found = list?.users?.find((u: any) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (found) return found.id;
  }
  throw new Error(`auth createUser ${email}: ${error?.message || 'unknown'}`);
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
async function mkUser(u: Seat, orgRoleId: string, label: string) {
  log(`   - ${u.name} <${u.email}> · ${label}${u.placeholder ? ' [PLACEHOLDER EMAIL]' : ''}`);
  if (dry) return;
  const dup = (await db.from('users').select('id').eq('org_id', ORG_ID).eq('email', u.email).maybeSingle()).data as any;
  const uid = dup?.id || await ensureLogin(u.email, TEMP_PASSWORD, u.name);
  const { error } = await db.from('users').upsert({
    id: uid, org_id: ORG_ID, client_id: CLIENT_ID, name: u.name, email: u.email, mobile: u.mobile,
    role: 'sub_admin', org_role_id: orgRoleId, city: null, is_active: true, must_change_password: true,
  }, { onConflict: 'id' });
  if (error) throw new Error(`users ${u.email}: ${error.message}`);
}

async function commit() {
  log(`MODE=${MODE}`);
  const grant = await resolveGrantModuleIds();
  log(`modules=${grant.length}`);

  log('designations');
  const managerDesig = await ensureDesignation('Manager', 'team', 0, [...grant, 'users']);
  const salesDesig = await ensureDesignation('Sales Executive', 'own', 1, grant);
  const engDesig = await ensureDesignation('Service Engineer', 'own', 2, grant);
  void managerDesig; // reserved for a future manager assignment

  log('users (5 sales + 3 engineering); existing client admin untouched');
  for (const u of SALES) await mkUser(u, salesDesig, 'Sales Executive');
  for (const u of ENGINEERING) await mkUser(u, engDesig, 'Service Engineer');

  log(`client_modules (${grant.length})`);
  if (!dry && grant.length) {
    const payload = grant.map((m) => ({ client_id: CLIENT_ID, module_id: m, enabled: true, source: 'manual' }));
    const { error } = await db.from('client_modules').upsert(payload, { onConflict: 'client_id,module_id' });
    if (error) throw new Error(`client_modules: ${error.message}`);
  }

  log('CRM config');
  const existing = (await db.from('crm_settings').select('id,config').eq('org_id', ORG_ID).eq('client_id', CLIENT_ID).maybeSingle()).data as any;
  const config = {
    ...(existing?.config || {}),
    lead_statuses: LEAD_STATUSES, lost_reasons: LOST_REASONS,
    won_criteria: { require_order_confirmation: true, note: 'Won requires a Purchase Order or official order confirmation.' },
    field_overrides: { ...((existing?.config?.field_overrides) || {}), ...FIELD_OVERRIDES },
  };
  if (!dry) {
    if (existing?.id) { const { error } = await db.from('crm_settings').update({ config, business_type: 'both' }).eq('id', existing.id); if (error) throw new Error(`crm_settings: ${error.message}`); }
    else { const { error } = await db.from('crm_settings').insert({ org_id: ORG_ID, client_id: CLIENT_ID, business_type: 'both', config }); if (error) throw new Error(`crm_settings: ${error.message}`); }
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
  const org = (await db.from('organisations').select('id,name').eq('id', ORG_ID).maybeSingle()).data;
  const client = (await db.from('clients').select('id,name').eq('id', CLIENT_ID).maybeSingle()).data;
  log('INSPECT', { org: !!org, client: !!client, grant: (await resolveGrantModuleIds()).length });
}

(async () => {
  log(`start mode=${MODE}`);
  if (MODE === 'inspect') await inspect(); else await commit();
  process.exit(0);
})().catch((e) => { console.error('[aadinath] FAILED', e?.stack || e); process.exit(1); });

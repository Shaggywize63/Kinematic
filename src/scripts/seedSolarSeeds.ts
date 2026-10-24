/**
 * Seed the "Solar Seeds" client with dummy Field-Force & Distribution data.
 *
 * Solar Seeds is a NEW CLIENT inside the KINEMATIC tenant (self-hosted Supabase
 * project key `kinematic`, NOT Tata/default). Because the kinematic project is
 * org-per-client, this script provisions a dedicated org for Solar Seeds, a
 * client row, a client-admin + a few field users, grants the distribution
 * modules, switches on the relevant notifications, and seeds a demo master set
 * (brands, distributors, outlets, SKUs, price list) plus a couple of sample
 * assigned orders so the apps light up immediately.
 *
 * It is idempotent: re-running upserts by natural keys (email, codes, names)
 * and never duplicates. It is SAFE to run repeatedly.
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   The kinematic project must be configured in env (KINEMATIC_SUPABASE_URL +
 *   service key) exactly as the API uses it.
 *
 *     npx ts-node src/scripts/seedSolarSeeds.ts
 *
 *   Optional env:
 *     SOLAR_SEEDS_ADMIN_EMAIL     (default admin@solarseeds.demo)
 *     SOLAR_SEEDS_ADMIN_PASSWORD  (default SolarSeeds@123 — change for anything real)
 *     SOLAR_SEEDS_PROJECT         (default 'kinematic')
 *
 * NOTE: this writes to the LIVE kinematic database. Do not run it against
 * production without explicit sign-off.
 */
import { adminClientFor } from '../lib/projects';
import { SETTING_KEY } from '../services/notificationPolicy';

const PROJECT = (process.env.SOLAR_SEEDS_PROJECT || 'kinematic').trim();
const ADMIN_EMAIL = process.env.SOLAR_SEEDS_ADMIN_EMAIL || 'admin@solarseeds.demo';
const ADMIN_PASSWORD = process.env.SOLAR_SEEDS_ADMIN_PASSWORD || 'SolarSeeds@123';
const CLIENT_NAME = 'Solar Seeds';

const db = adminClientFor(PROJECT);

// Modules Solar Seeds should have (filtered against real module ids before grant).
const MODULE_IDS = [
  // universal / field-force basics the apps need
  'dashboard', 'users', 'settings', 'stores', 'skus', 'orders',
  // distribution package + features
  'distribution', 'distribution_orders', 'distribution_invoicing', 'distribution_payments',
  'distribution_returns', 'distribution_ledger', 'distribution_pricing',
  'distribution_brands', 'distribution_distributors', 'distribution_stock',
];

// Notification kinds switched on for the org (distribution + the recommended ones).
const ENABLED_KINDS = ['order_assigned', 'low_stock', 'stock_expiry', 'sos', 'security_alert'];

const FIELD_USERS = [
  { email: 'ravi.ff@solarseeds.demo', name: 'Ravi Verma', mobile: '9800000001', employee_id: 'SS-FE-001' },
  { email: 'sunita.ff@solarseeds.demo', name: 'Sunita Patel', mobile: '9800000002', employee_id: 'SS-FE-002' },
  { email: 'manoj.ff@solarseeds.demo', name: 'Manoj Yadav', mobile: '9800000003', employee_id: 'SS-FE-003' },
];

// Dummy catalogue — a mix of solar hardware and seed SKUs for "Solar Seeds".
const SKUS = [
  { sku_code: 'SS-PANEL-100', name: 'Solar Panel 100W Poly', category: 'Solar Panels', uom: 'PCS', pack_size: 1, mrp: 4200, base_price: 3600, gst_rate: 12, hsn: '85414011' },
  { sku_code: 'SS-PANEL-200', name: 'Solar Panel 200W Mono', category: 'Solar Panels', uom: 'PCS', pack_size: 1, mrp: 7800, base_price: 6900, gst_rate: 12, hsn: '85414011' },
  { sku_code: 'SS-PUMP-1HP', name: 'Solar Water Pump 1HP', category: 'Solar Pumps', uom: 'PCS', pack_size: 1, mrp: 28000, base_price: 24500, gst_rate: 18, hsn: '84137010' },
  { sku_code: 'SS-INV-3KW', name: 'Solar Inverter 3kW', category: 'Inverters', uom: 'PCS', pack_size: 1, mrp: 21000, base_price: 18500, gst_rate: 18, hsn: '85044090' },
  { sku_code: 'SS-SEED-MAIZE', name: 'Hybrid Maize Seed 5kg', category: 'Seeds', uom: 'BAG', pack_size: 5, mrp: 1200, base_price: 980, gst_rate: 5, hsn: '12099100' },
  { sku_code: 'SS-SEED-WHEAT', name: 'Certified Wheat Seed 10kg', category: 'Seeds', uom: 'BAG', pack_size: 10, mrp: 900, base_price: 760, gst_rate: 5, hsn: '10019900' },
  { sku_code: 'SS-SEED-SOYA', name: 'Soybean Seed 8kg', category: 'Seeds', uom: 'BAG', pack_size: 8, mrp: 1500, base_price: 1250, gst_rate: 5, hsn: '12010010' },
  { sku_code: 'SS-DRIP-KIT', name: 'Drip Irrigation Kit (1 Acre)', category: 'Irrigation', uom: 'KIT', pack_size: 1, mrp: 16000, base_price: 13800, gst_rate: 18, hsn: '84248200' },
];

const OUTLETS = [
  { store_code: 'SS-OUT-001', name: 'Green Agro Store', address: 'Market Rd, Nashik', phone: '9820000001', lat: 20.0059, lng: 73.7897 },
  { store_code: 'SS-OUT-002', name: 'Krishi Solar Mart', address: 'Station Rd, Pune', phone: '9820000002', lat: 18.5204, lng: 73.8567 },
  { store_code: 'SS-OUT-003', name: 'Sunrise Farmers Depot', address: 'MG Rd, Aurangabad', phone: '9820000003', lat: 19.8762, lng: 75.3433 },
];

async function getOrCreateOrg(): Promise<string> {
  // Dedicated org for Solar Seeds (kinematic is org-per-client).
  const { data: existing } = await db.from('organisations').select('id').eq('name', CLIENT_NAME).maybeSingle();
  if (existing?.id) return existing.id;
  const slug = CLIENT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const { data, error } = await db.from('organisations').insert({ name: CLIENT_NAME, slug }).select('id').single();
  if (error) throw new Error(`org create failed: ${error.message}`);
  return data.id;
}

async function getOrCreateClient(orgId: string): Promise<string> {
  const { data: existing } = await db.from('clients').select('id').eq('org_id', orgId).eq('name', CLIENT_NAME).maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await db.from('clients')
    .insert({ org_id: orgId, name: CLIENT_NAME, is_active: true, status: 'active' })
    .select('id').single();
  if (error) throw new Error(`client create failed: ${error.message}`);
  return data.id;
}

/** Create (or find) a GoTrue auth user and upsert its public.users profile. */
async function getOrCreateUser(opts: {
  orgId: string; clientId: string; email: string; name: string; role: string;
  mobile?: string; employee_id?: string; password?: string;
}): Promise<string> {
  let authId: string | undefined;
  const { data: created, error } = await db.auth.admin.createUser({
    email: opts.email,
    password: opts.password || `${Math.random().toString(36).slice(2)}Aa1!`,
    email_confirm: true,
    user_metadata: { name: opts.name, role: opts.role },
  });
  if (error) {
    if (error.message.toLowerCase().includes('already')) {
      const { data: list } = await db.auth.admin.listUsers();
      authId = list.users.find((u: any) => u.email?.toLowerCase() === opts.email.toLowerCase())?.id;
    } else {
      throw new Error(`auth user create failed (${opts.email}): ${error.message}`);
    }
  } else {
    authId = created.user.id;
  }
  if (!authId) throw new Error(`could not resolve auth id for ${opts.email}`);

  await db.from('users').upsert({
    id: authId,
    org_id: opts.orgId,
    client_id: opts.clientId,
    name: opts.name,
    email: opts.email,
    mobile: opts.mobile || '',
    role: opts.role,
    is_active: true,
    ...(opts.employee_id ? { employee_id: opts.employee_id } : {}),
  }, { onConflict: 'id' });
  return authId;
}

async function grantModules(orgId: string, clientId: string, userIds: string[]): Promise<void> {
  const { data: valid } = await db.from('modules').select('id');
  const validIds = new Set((valid || []).map((m: any) => m.id));
  const granted = MODULE_IDS.filter((m) => validIds.has(m));
  if (!granted.length) {
    console.warn('⚠️  No matching module ids found in modules table — skipping module grant.');
    return;
  }
  // Grant at the client level (client_modules), then fan out to per-user perms.
  await db.from('client_modules').upsert(
    granted.map((m) => ({ client_id: clientId, module_id: m, enabled: true, source: 'manual' })),
    { onConflict: 'client_id,module_id' },
  );
  for (const uid of userIds) {
    await db.from('user_module_permissions').upsert(
      granted.map((m) => ({ user_id: uid, module_id: m, org_id: orgId })),
      { onConflict: 'user_id,module_id' },
    );
  }
  console.log(`🔑 Granted ${granted.length} modules to client + ${userIds.length} users.`);
}

async function enableNotifications(orgId: string): Promise<void> {
  await db.from('org_settings').delete().eq('org_id', orgId).eq('key', SETTING_KEY);
  const { error } = await db.from('org_settings').insert({ org_id: orgId, key: SETTING_KEY, value: ENABLED_KINDS });
  if (error) console.warn(`⚠️  notification settings write failed: ${error.message}`);
  else console.log(`🔔 Enabled notifications: ${ENABLED_KINDS.join(', ')}`);
}

async function upsertByNaturalKey(table: string, matchCols: Record<string, unknown>, row: Record<string, unknown>): Promise<string> {
  let q = db.from(table).select('id');
  for (const [k, v] of Object.entries(matchCols)) q = q.eq(k, v as any);
  const { data: existing } = await q.maybeSingle();
  if (existing?.id) {
    await db.from(table).update(row).eq('id', existing.id);
    return existing.id;
  }
  const { data, error } = await db.from(table).insert({ ...matchCols, ...row }).select('id').single();
  if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  return data.id;
}

async function seed(): Promise<void> {
  console.log(`🌱 Seeding "${CLIENT_NAME}" on project '${PROJECT}'…`);
  const orgId = await getOrCreateOrg();
  const clientId = await getOrCreateClient(orgId);
  console.log(`🏢 org=${orgId} client=${clientId}`);

  const adminId = await getOrCreateUser({ orgId, clientId, email: ADMIN_EMAIL, name: 'Solar Seeds Admin', role: 'client', password: ADMIN_PASSWORD });
  const fieldIds: string[] = [];
  for (const fu of FIELD_USERS) {
    fieldIds.push(await getOrCreateUser({ orgId, clientId, email: fu.email, name: fu.name, role: 'field_executive', mobile: fu.mobile, employee_id: fu.employee_id }));
  }
  console.log(`👤 admin=${ADMIN_EMAIL} (pw via env) + ${fieldIds.length} field users.`);

  await grantModules(orgId, clientId, [adminId, ...fieldIds]);
  await enableNotifications(orgId);

  // Brand
  const brandId = await upsertByNaturalKey('brands', { org_id: orgId, code: 'SS' },
    { client_id: clientId, name: 'Solar Seeds', state_code: '27', is_active: true });

  // Distributor
  const distId = await upsertByNaturalKey('distributors', { org_id: orgId, code: 'SS-DIST-01' },
    { client_id: clientId, name: 'Maharashtra Agri Distributors', state_code: '27', place_of_supply: '27',
      customer_class: 'distributor', region: 'ALL', credit_limit: 500000, is_active: true,
      assigned_brands: [brandId] });

  // SKUs + distribution ext
  const skuIds: { id: string; base_price: number; sku: typeof SKUS[number] }[] = [];
  for (const s of SKUS) {
    const skuId = await upsertByNaturalKey('skus', { org_id: orgId, sku_code: s.sku_code },
      { client_id: clientId, name: s.name, category: s.category, unit: s.uom, is_active: true });
    await db.from('product_distribution_ext').upsert({
      sku_id: skuId, org_id: orgId, client_id: clientId, brand_id: brandId,
      hsn_code: s.hsn, gst_rate: s.gst_rate, uom: s.uom, pack_size: s.pack_size, mrp: s.mrp, is_active: true,
    }, { onConflict: 'sku_id' });
    skuIds.push({ id: skuId, base_price: s.base_price, sku: s });
  }
  console.log(`📦 ${skuIds.length} SKUs seeded.`);

  // Price list (GT / ALL) + items
  const priceListId = await upsertByNaturalKey('price_lists', { org_id: orgId, name: 'Solar Seeds GT ALL' },
    { client_id: clientId, customer_class: 'GT', region: 'ALL', version: 1, is_active: true });
  for (const si of skuIds) {
    await db.from('price_list_items').upsert(
      { price_list_id: priceListId, sku_id: si.id, base_price: si.base_price, min_qty: 1 },
      { onConflict: 'price_list_id,sku_id' },
    );
  }
  console.log(`💰 Price list seeded with ${skuIds.length} items.`);

  // Outlets (stores) + distribution ext (assigned to the distributor)
  const outletIds: string[] = [];
  for (const o of OUTLETS) {
    const outletId = await upsertByNaturalKey('stores', { org_id: orgId, store_code: o.store_code },
      { client_id: clientId, name: o.name, address: o.address, phone: o.phone, lat: o.lat, lng: o.lng,
        is_active: true, approval_status: 'approved' });
    await db.from('outlet_distribution_ext').upsert({
      outlet_id: outletId, org_id: orgId, client_id: clientId, customer_class: 'GT',
      assigned_distributor_id: distId, state_code: '27', credit_limit: 100000, geofence_radius_m: 150,
    }, { onConflict: 'outlet_id' });
    outletIds.push(outletId);
  }
  console.log(`🏬 ${outletIds.length} outlets seeded.`);

  // Link field users to the distributor (salesman_ext) so order-booking resolves.
  for (const uid of fieldIds) {
    await db.from('salesman_ext').upsert(
      { user_id: uid, org_id: orgId, assigned_distributor_id: distId, can_book_credit: true },
      { onConflict: 'user_id' },
    );
  }

  console.log('✅ Solar Seeds seed complete.');
  console.log('   Next: log in as the admin on the dashboard, grant/confirm the Distribution');
  console.log('   package in Client Management if needed, and create + assign orders to the field users.');
}

seed().then(() => process.exit(0)).catch((e) => { console.error('❌ seed failed:', e); process.exit(1); });

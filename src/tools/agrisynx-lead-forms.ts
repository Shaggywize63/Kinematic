/**
 * Agrisynx lead forms — Dealer and Farmer.
 *
 * Everything the two forms need is DATA in the existing settings, so nothing here changes the
 * code that other clients run:
 *   - the lead-type names ("Dealer" / "Farmers" instead of B2B / B2C)  -> crm_settings.config.lead_form
 *   - which built-in fields each form shows, and what they are called   -> crm_settings.config.field_overrides
 *   - the extra fields (Description, Crop, Suggested Product, photos)  -> crm custom fields
 *
 * Dealer  = B2B:  Shop Name, Dealer Name, Location, Mobile Number, Description, Schedule Visit, Shop Image
 * Farmers = B2C:  Farmer Name, Mobile Number, Location, Crop, Suggested Product, Photo
 *
 * Run it against the API as an agrisynx (or org) admin — it is idempotent, so running it again
 * updates in place and never duplicates a field:
 *
 *   TOKEN=<admin access token> CLIENT_ID=<agrisynx client uuid> \
 *     npx tsx src/tools/agrisynx-lead-forms.ts [--dry-run]
 *
 *   optional: API_URL (default https://api.kinematicapp.com), PROJECT (X-Kinematic-Project, default
 *   'kinematic').
 *
 * Everything can also be edited by hand afterwards in Settings -> Custom Fields; this only gives a
 * correct starting point. The crop list is a starting list — edit it there.
 */
import { OPTION_SEARCHABLE, OPTION_SOURCE_PRODUCTS } from '../lib/customFieldOptions';

// ── crops ───────────────────────────────────────────────────────────────────
export const CROPS: string[] = Array.from(new Set([
  // cereals & millets
  'Rice (Paddy)', 'Wheat', 'Maize', 'Jowar (Sorghum)', 'Bajra (Pearl Millet)', 'Ragi (Finger Millet)', 'Barley', 'Oats',
  'Foxtail Millet', 'Little Millet', 'Kodo Millet', 'Barnyard Millet', 'Proso Millet',
  // pulses
  'Tur (Pigeon Pea)', 'Chana (Bengal Gram)', 'Moong (Green Gram)', 'Urad (Black Gram)', 'Masoor (Lentil)', 'Peas (Dry)',
  'Horse Gram', 'Moth Bean', 'Cowpea', 'Rajma (Kidney Bean)', 'Field Bean (Lablab)',
  // oilseeds
  'Groundnut', 'Soybean', 'Mustard', 'Rapeseed', 'Sunflower', 'Sesame (Til)', 'Safflower', 'Castor', 'Linseed', 'Niger', 'Coconut', 'Oil Palm',
  // fibre & cash crops
  'Cotton', 'Jute', 'Sugarcane', 'Tobacco', 'Mesta', 'Sunhemp',
  // vegetables
  'Tomato', 'Brinjal (Eggplant)', 'Green Chilli', 'Capsicum', 'Okra (Bhindi)', 'Cabbage', 'Cauliflower', 'Onion', 'Garlic', 'Potato',
  'Sweet Potato', 'Carrot', 'Radish', 'Beetroot', 'Spinach', 'Fenugreek (Methi)', 'Coriander (Leaf)', 'Cucumber', 'Bottle Gourd',
  'Bitter Gourd', 'Ridge Gourd', 'Snake Gourd', 'Ash Gourd', 'Pumpkin', 'Cluster Bean (Guar)', 'French Bean', 'Green Peas', 'Drumstick (Moringa)',
  'Tapioca (Cassava)', 'Yam', 'Colocasia (Arbi)', 'Lettuce', 'Broccoli', 'Sweet Corn', 'Baby Corn', 'Spring Onion', 'Zucchini',
  // fruits
  'Mango', 'Banana', 'Papaya', 'Guava', 'Pomegranate', 'Grapes', 'Lemon / Lime', 'Orange', 'Sweet Orange (Mosambi)', 'Apple', 'Pineapple',
  'Watermelon', 'Muskmelon', 'Sapota (Chikoo)', 'Custard Apple', 'Jackfruit', 'Litchi', 'Dragon Fruit', 'Amla', 'Ber', 'Fig', 'Strawberry',
  'Cashew', 'Arecanut', 'Pear', 'Plum', 'Peach', 'Kiwi', 'Avocado', 'Tamarind',
  // spices & plantation
  'Turmeric', 'Ginger', 'Dry Chilli', 'Black Pepper', 'Cardamom', 'Cumin', 'Coriander (Seed)', 'Fennel', 'Ajwain', 'Clove', 'Nutmeg',
  'Tea', 'Coffee', 'Rubber', 'Betel Vine',
  // flowers, aromatic, fodder & others
  'Marigold', 'Rose', 'Jasmine', 'Chrysanthemum', 'Tuberose', 'Gerbera', 'Aloe Vera', 'Stevia', 'Lemongrass', 'Mint', 'Napier Grass',
  'Lucerne (Alfalfa)', 'Berseem', 'Fodder Maize', 'Bamboo', 'Mushroom', 'Vegetable Nursery', 'Other',
])).sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));

// ── the two forms ───────────────────────────────────────────────────────────
export const DEALER_DESCRIPTIONS = ['Dealer Visit', 'First Time Visit', 'Dealer Appoint', 'Order/Collection'];

export interface CustomFieldDef {
  entity_type: 'lead';
  field_key: string;
  label: string;
  field_type: 'select' | 'image';
  options?: string[];
  required: boolean;
  applies_to: 'b2b' | 'b2c';
  position: number;
}

export const CUSTOM_FIELDS: CustomFieldDef[] = [
  // Dealer (B2B)
  { entity_type: 'lead', field_key: 'visit_description', label: 'Description (Type of activity)', field_type: 'select',
    options: DEALER_DESCRIPTIONS, required: true, applies_to: 'b2b', position: 10 },
  { entity_type: 'lead', field_key: 'shop_image', label: 'Shop Image', field_type: 'image', required: true, applies_to: 'b2b', position: 20 },
  // Farmers (B2C)
  { entity_type: 'lead', field_key: 'crop', label: 'Crop', field_type: 'select',
    options: [OPTION_SEARCHABLE, ...CROPS], required: true, applies_to: 'b2c', position: 10 },
  // Choices come from the Products section; only the product NAME is stored (no price).
  { entity_type: 'lead', field_key: 'suggested_product', label: 'Suggested Product', field_type: 'select',
    options: [OPTION_SOURCE_PRODUCTS], required: false, applies_to: 'b2c', position: 20 },
  { entity_type: 'lead', field_key: 'farmer_photo', label: 'Photo', field_type: 'image', required: true, applies_to: 'b2c', position: 30 },
];

type Override = { label?: string; required?: boolean; hidden?: boolean };
const hide = (scope: 'b2b' | 'b2c', keys: string[]): Record<string, Override> =>
  Object.fromEntries(keys.map((k) => [`lead.${k}@${scope}`, { hidden: true, required: false }]));

export const FIELD_OVERRIDES: Record<string, Override> = {
  // Dealer
  'lead.first_name@b2b': { label: 'Dealer Name', required: true },
  'lead.last_name@b2b': { hidden: true, required: false },
  'lead.company@b2b': { label: 'Shop Name', required: true },
  'lead.phone@b2b': { label: 'Mobile Number', required: true },
  'lead.address_line1@b2b': { label: 'Location', required: true },
  ...hide('b2b', ['email', 'title', 'industry', 'alternate_mobiles', 'status', 'source_id', 'address_line2', 'postal_code', 'country']),
  // Farmers
  'lead.first_name@b2c': { label: 'Farmer Name', required: true },
  'lead.last_name@b2c': { hidden: true, required: false },
  'lead.phone@b2c': { label: 'Mobile Number', required: true },
  'lead.address_line1@b2c': { label: 'Location', required: true },
  ...hide('b2c', ['email', 'date_of_birth', 'gender', 'preferred_contact_method', 'alternate_mobiles', 'status', 'source_id',
    'address_line2', 'postal_code', 'country', 'marketing_consent', 'whatsapp_consent']),
};

export const LEAD_FORM = {
  segment_labels: { b2b: 'Dealer', b2c: 'Farmers' },
  address_on_b2b: true,
  schedule_visit: { segments: ['b2b'] as Array<'b2b' | 'b2c'> },
};

// ── planning (pure, so it is testable) ──────────────────────────────────────
export interface ExistingField { id: string; field_key: string; entity_type?: string }

export type Step =
  | { op: 'create'; field: CustomFieldDef }
  | { op: 'update'; id: string; field: CustomFieldDef };

/** Create what is missing, update what is already there (matched by field_key). */
export function planFields(existing: ExistingField[]): Step[] {
  const byKey = new Map(existing.filter((f) => !f.entity_type || f.entity_type === 'lead').map((f) => [f.field_key, f]));
  return CUSTOM_FIELDS.map((field) => {
    const hit = byKey.get(field.field_key);
    return hit ? { op: 'update', id: hit.id, field } : { op: 'create', field };
  });
}

/** The settings patch: our overrides laid over whatever is already configured. */
export function planSettings(existingConfig: Record<string, unknown> | null | undefined) {
  const current = (existingConfig?.field_overrides && typeof existingConfig.field_overrides === 'object'
    ? existingConfig.field_overrides : {}) as Record<string, Override>;
  return { config: { field_overrides: { ...current, ...FIELD_OVERRIDES }, lead_form: LEAD_FORM } };
}

// ── applying it through the API ─────────────────────────────────────────────
async function main() {
  const dry = process.argv.includes('--dry-run');
  const api = (process.env.API_URL || 'https://api.kinematicapp.com').replace(/\/$/, '');
  const token = process.env.TOKEN;
  const clientId = process.env.CLIENT_ID;
  if (!token || !clientId) {
    console.error('Set TOKEN (an admin access token) and CLIENT_ID (the agrisynx client id).');
    process.exit(1);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Client-Id': clientId,
    ...(process.env.PROJECT && process.env.PROJECT !== 'default' ? { 'X-Kinematic-Project': process.env.PROJECT }
      : process.env.PROJECT === undefined ? { 'X-Kinematic-Project': 'kinematic' } : {}),
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json?.error || json?.message || text.slice(0, 200)}`);
    return json;
  };

  const existing = await call('GET', '/api/v1/crm/custom-fields?entity=lead&include_inactive=1');
  const list: ExistingField[] = (existing?.data ?? existing ?? []) as ExistingField[];
  for (const step of planFields(list)) {
    console.log(`${dry ? '[dry-run] ' : ''}${step.op} custom field ${step.field.field_key} (${step.field.applies_to})`);
    if (dry) continue;
    if (step.op === 'create') await call('POST', '/api/v1/crm/custom-fields', step.field);
    else await call('PATCH', `/api/v1/crm/custom-fields/${step.id}`, step.field);
  }

  const settings = await call('GET', '/api/v1/crm/settings');
  const row = settings?.data ?? settings;
  const patch = planSettings(row?.config);
  console.log(`${dry ? '[dry-run] ' : ''}update settings: lead_form + ${Object.keys(FIELD_OVERRIDES).length} field overrides`);
  if (!dry) {
    // business_type must be 'both' for the Dealer / Farmers toggle to appear.
    await call('PATCH', '/api/v1/crm/settings', { ...patch, business_type: 'both' });
  }
  console.log(dry ? 'Dry run only — nothing was changed.' : 'Done. Reload the dashboard and the apps.');
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

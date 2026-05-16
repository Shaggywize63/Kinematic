/**
 * Zod validators for CRM endpoints. Single file because schemas are small
 * and shared across multiple controllers.
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const optionalUuid = uuid.nullish();
const isoDate = z.string().datetime({ offset: true }).or(z.string().date()).optional().nullable();

const contactMethod = z.enum(['email','phone','whatsapp','sms']).optional().nullable();
const gender = z.enum(['male','female','other','prefer_not_to_say']).optional().nullable();
const loyaltyTier = z.enum(['bronze','silver','gold','platinum','vip']).optional().nullable();

// HubSpot-style funnel position. Orthogonal to `status` — a lead can be
// `status='working' lifecycle_stage='mql'` (in active outreach + marketing-
// qualified) or `status='qualified' lifecycle_stage='sql'` (in active
// outreach + sales-qualified). Service auto-bumps to 'customer' on convert.
const lifecycleStage = z.enum([
  'subscriber',  // joined newsletter / form fill, not yet a lead
  'lead',        // default — captured but unqualified
  'mql',         // marketing-qualified (engaged with content, fits ICP)
  'sql',         // sales-qualified (sales has accepted, is actively working)
  'customer',    // converted — auto-set by convertLead()
  'evangelist',  // repeat buyer / NPS promoter
]);

// Campaign-attribution fields. Standard Google Analytics UTM params + the
// two adjacent context fields (referrer_url, landing_page) every modern
// lead-source-ROI report wants. Optional everywhere — only filled when the
// inbound vector (web form, ad click, email link) carries them.
const utmFields = {
  utm_source:   z.string().max(200).optional().nullable(),
  utm_medium:   z.string().max(200).optional().nullable(),
  utm_campaign: z.string().max(200).optional().nullable(),
  utm_term:     z.string().max(200).optional().nullable(),
  utm_content:  z.string().max(200).optional().nullable(),
  referrer_url: z.string().max(2048).optional().nullable(),
  landing_page: z.string().max(2048).optional().nullable(),
};

// B2C fields shared by leads + contacts
const b2cBase = {
  is_b2c: z.boolean().optional(),
  date_of_birth: z.string().date().optional().nullable(),
  gender,
  address_line1: z.string().max(200).optional().nullable(),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  state: z.string().max(120).optional().nullable(),
  postal_code: z.string().max(20).optional().nullable(),
  country: z.string().max(80).optional().nullable(),
  preferred_contact_method: contactMethod,
  marketing_consent: z.boolean().optional(),
  whatsapp_consent: z.boolean().optional(),
  interests: z.array(z.string()).optional(),
  // Secondary phone numbers — the primary stays in `phone` (lead) / `mobile`
  // (contact). Stored as a text[] so the UI can manage them as chips.
  alternate_mobiles: z.array(z.string().min(3).max(40)).optional(),
};

export const leadCreateSchema = z.object({
  client_id: optionalUuid,
  first_name: z.string().min(1).max(120).optional().nullable(),
  last_name: z.string().min(1).max(120).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  company: z.string().max(200).optional().nullable(),
  title: z.string().max(120).optional().nullable(),
  source_id: optionalUuid,
  status: z.enum(['new','working','nurturing','qualified','unqualified']).optional(),
  // Funnel position. Defaults to 'lead' server-side via the DB column default
  // so the client doesn't have to set it explicitly on most inbound paths.
  lifecycle_stage: lifecycleStage.optional(),
  owner_id: optionalUuid,
  industry: z.string().max(120).optional().nullable(),
  notes: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  ...utmFields,
  ...b2cBase,
});

export const leadUpdateSchema = leadCreateSchema.partial().extend({
  status: z.enum(['new','working','nurturing','qualified','unqualified','converted','lost']).optional(),
  // Reason captured when a rep moves a lead into 'unqualified' or 'lost'.
  // Service auto-stamps disqualified_at on the first transition (so the
  // schema accepts it from clients but typical callers omit it).
  lost_reason: z.string().max(500).optional().nullable(),
  disqualified_at: isoDate,
});

export const leadConvertSchema = z.object({
  create_deal: z.boolean().default(true),
  deal_name: z.string().max(200).optional(),
  deal_amount: z.number().nonnegative().optional(),
  // Weight-based sizing — passed instead of (or alongside) deal_amount. The
  // service derives amount = volume_kg × (product.price / product.weight_kg).
  deal_volume_kg: z.number().nonnegative().optional(),
  deal_product_id: optionalUuid,
  pipeline_id: optionalUuid,
  stage_id: optionalUuid,
});

// Optional free-text reason supplied when a rep re-opens a previously
// disqualified or converted lead. Kept short (≤500) so it fits in the
// crm_lead_history.new_value jsonb without bloating the audit table.
export const leadReopenSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const contactSchema = z.object({
  account_id: optionalUuid,
  first_name: z.string().max(120).optional().nullable(),
  last_name: z.string().max(120).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  mobile: z.string().max(40).optional().nullable(),
  title: z.string().max(120).optional().nullable(),
  department: z.string().max(120).optional().nullable(),
  linkedin_url: z.string().url().optional().nullable(),
  owner_id: optionalUuid,
  do_not_contact: z.boolean().optional(),
  email_opt_out: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  ...b2cBase,
  // Customer fields (B2C only)
  loyalty_tier: loyaltyTier,
  customer_since: isoDate,
  lifetime_value: z.number().nonnegative().optional(),
  total_orders: z.number().int().nonnegative().optional(),
  last_purchase_at: isoDate,
  referral_source: z.string().max(120).optional().nullable(),
});

export const accountSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(200).optional().nullable(),
  industry: z.string().max(120).optional().nullable(),
  size: z.string().max(40).optional().nullable(),
  annual_revenue: z.number().nonnegative().optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  website: z.string().url().optional().nullable(),
  billing_address: z.record(z.unknown()).optional().nullable(),
  shipping_address: z.record(z.unknown()).optional().nullable(),
  owner_id: optionalUuid,
  territory_id: optionalUuid,
  parent_account_id: optionalUuid,
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const dealSchema = z.object({
  client_id: optionalUuid,
  name: z.string().min(1).max(200),
  pipeline_id: uuid,
  stage_id: uuid,
  account_id: optionalUuid,
  primary_contact_id: optionalUuid,
  lead_id: optionalUuid,
  amount: z.number().nonnegative().default(0),
  currency: z.string().length(3).default('INR'),
  expected_close_date: isoDate,
  probability: z.number().min(0).max(99).optional().nullable(),
  owner_id: optionalUuid,
  source_id: optionalUuid,
  next_step: z.string().max(500).optional().nullable(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const dealUpdateSchema = dealSchema.partial();

export const moveStageSchema = z.object({ stage_id: uuid });
export const winSchema = z.object({ actual_close_date: isoDate, amount: z.number().nonnegative().optional() });
export const loseSchema = z.object({ actual_close_date: isoDate, lost_reason: z.string().max(500).optional() });

export const activitySchema = z.object({
  // Accept any short slug — built-ins (call/meeting/email/note/task/sms/whatsapp)
  // are still defaults, but clients can add custom types via Settings →
  // Activity Types. Shape enforced so the DB stays clean.
  type: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'lowercase letters, digits, _, - only'),
  subject: z.string().max(200).optional().nullable(),
  body: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  direction: z.enum(['inbound','outbound']).optional().nullable(),
  status: z.enum(['open','planned','in_progress','completed','done','cancelled']).default('completed'),
  priority: z.enum(['low','normal','medium','high','urgent']).optional().nullable(),
  due_at: isoDate,
  completed_at: isoDate,
  duration_seconds: z.number().int().nonnegative().optional().nullable(),
  lead_id: optionalUuid,
  contact_id: optionalUuid,
  account_id: optionalUuid,
  deal_id: optionalUuid,
  owner_id: optionalUuid,
  assigned_to: optionalUuid,
  metadata: z.record(z.unknown()).optional(),
  // Single image attached to the activity (e.g. site-visit photo). Front-end
  // uploads via the existing /api/v1/upload pipeline and posts the URL here.
  image_url: z.string().url().max(2048).optional().nullable(),
});

export const taskSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  status: z.enum(['open','in_progress','done','cancelled']).default('open'),
  priority: z.enum(['low','normal','medium','high','urgent']).optional().nullable(),
  due_at: isoDate,
  completed_at: isoDate,
  lead_id: optionalUuid,
  contact_id: optionalUuid,
  account_id: optionalUuid,
  deal_id: optionalUuid,
  owner_id: optionalUuid,
  assigned_to: optionalUuid,
});

export const noteSchema = z.object({
  entity_type: z.enum(['lead','contact','account','deal']),
  entity_id: uuid,
  body: z.string().min(1),
  pinned: z.boolean().optional(),
});

export const pipelineSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional().nullable(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

export const stageSchema = z.object({
  pipeline_id: uuid,
  name: z.string().min(1).max(120),
  position: z.number().int().nonnegative(),
  // Capped at 99 — calling a deal "100% likely" is misleading and we want
  // the funnel chart's drop-off math to never divide by certainty.
  probability: z.number().min(0).max(99).default(50),
  stage_type: z.enum(['open','won','lost']).default('open'),
  color: z.string().optional(),
});

export const reorderStagesSchema = z.object({
  pipeline_id: uuid,
  stages: z.array(z.object({ id: uuid, position: z.number().int().nonnegative() })),
});

export const leadSourceSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['csv','manual','web_form','email','api','referral','event','social','ads']).default('manual'),
  is_active: z.boolean().optional(),
  cost_per_lead: z.number().nonnegative().optional(),
});

export const assignmentRuleSchema = z.object({
  name: z.string().min(1).max(120),
  priority: z.number().int().min(1).max(1000).default(100),
  is_active: z.boolean().optional(),
  criteria: z.record(z.unknown()).default({}),
  assign_to_user_id: optionalUuid,
  assign_to_team_id: optionalUuid,
  round_robin_pool: z.array(uuid).optional().nullable(),
  pipeline_id: optionalUuid,
});

export const territorySchema = z.object({
  name: z.string().min(1).max(120),
  criteria: z.record(z.unknown()).default({}),
  manager_id: optionalUuid,
});

export const emailTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(300),
  body_html: z.string().min(1),
  body_text: z.string().optional().nullable(),
  variables: z.array(z.string()).optional().nullable(),
  category: z.string().max(80).default('general').nullable(),
  is_active: z.boolean().optional(),
});

export const sendEmailSchema = z.object({
  to: z.string().email(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(300),
  body_html: z.string().min(1),
  body_text: z.string().optional(),
  template_id: optionalUuid,
  lead_id: optionalUuid,
  contact_id: optionalUuid,
  deal_id: optionalUuid,
});

export const automationSchema = z.object({
  name: z.string().min(1).max(200),
  trigger_type: z.string().min(1),
  trigger_config: z.record(z.unknown()).default({}),
  conditions: z.array(z.record(z.unknown())).default([]),
  actions: z.array(z.record(z.unknown())).default([]),
  is_active: z.boolean().optional(),
});

export const customFieldSchema = z.object({
  entity_type: z.enum(['lead','contact','account','deal']),
  field_key: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(120),
  field_type: z.enum(['text','number','boolean','date','datetime','select','multiselect','url','email']),
  options: z.array(z.string()).optional().nullable(),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
});

export const importPreviewSchema = z.object({
  job_id: uuid,
  mapping: z.record(z.string()),
});
export const importCommitSchema = z.object({ job_id: uuid });

// Frontend posts `{ thread, goal, tone, lead_id?, deal_id? }`; backend service
// reads `{ incoming_message, intent }`. Accept both names via preprocess so
// callers don't 400 when they use the older field names.
export const draftReplySchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (r.intent === undefined && typeof r.goal === 'string') r.intent = r.goal;
    if (r.incoming_message === undefined && typeof r.thread === 'string') r.incoming_message = r.thread;
  }
  return raw;
}, z.object({
  lead_id: optionalUuid,
  deal_id: optionalUuid,
  contact_id: optionalUuid,
  incoming_message: z.string().optional(),
  intent: z.string().min(1),
  tone: z.enum(['friendly','formal','concise']).default('friendly'),
  template_hint: z.string().optional(),
}));

export const summarizeSchema = z.object({});

// Settings — including new business_type for B2B/B2C
export const settingsUpdateSchema = z.object({
  config: z.record(z.unknown()).optional(),
  business_type: z.enum(['b2b','b2c','both']).optional(),
});

// States & cities management
export const stateSchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().max(10).optional().nullable(),
  country: z.string().max(80).default('India'),
  is_active: z.boolean().optional(),
});

export const citySchema = z.object({
  state_id: uuid,
  name: z.string().min(1).max(120),
  district: z.string().max(120).optional().nullable(),
  is_active: z.boolean().optional(),
});

// ---------- Phase 2: Products + WhatsApp ----------

export const productCategorySchema = z.object({
  name: z.string().min(1).max(160),
  parent_category_id: optionalUuid,
  description: z.string().optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  sort_order: z.number().int().optional(),
});

export const productSchema = z.object({
  category_id: optionalUuid,
  sku: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  unit: z.string().max(40).optional(),
  price: z.number().nonnegative().default(0),
  // Per-unit weight in kilograms. Lets the UI derive price-per-kg / per-tonne
  // for weight-based goods (TMT bars, cement, sand) without forcing every
  // product into the same pricing basis.
  weight_kg: z.number().nonnegative().optional().nullable(),
  currency: z.string().length(3).default('INR'),
  tax_rate_pct: z.number().min(0).max(100).default(0),
  hsn_code: z.string().max(40).optional().nullable(),
  image_url: z.string().url().optional().nullable(),
  is_active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const lineItemSchema = z.object({
  product_id: optionalUuid,
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  sku: z.string().max(120).optional().nullable(),
  unit: z.string().max(40).optional().nullable(),
  quantity: z.number().positive().default(1),
  unit_price: z.number().nonnegative().optional(),
  discount_pct: z.number().min(0).max(100).optional(),
  tax_pct: z.number().min(0).max(100).optional(),
  position: z.number().int().nonnegative().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const whatsappTemplateSchema = z.object({
  meta_template_name: z.string().min(1).max(120),
  category: z.enum(['utility','marketing','authentication']).default('utility'),
  language: z.string().min(2).max(10).default('en'),
  status: z.enum(['pending','approved','rejected']).default('pending'),
  header_text: z.string().max(300).optional().nullable(),
  body_text: z.string().min(1).max(2000),
  footer_text: z.string().max(300).optional().nullable(),
  // Frontend sends `null` to clear these fields — accept that explicitly.
  // Was rejecting saves because z.array(...).optional() doesn't allow null,
  // and the dashboard's TemplateEditModal sends `variables: form.variables || null`.
  variables: z.array(z.string()).optional().nullable(),
  provider_template_id: z.string().max(160).optional().nullable(),
  // Optional media header — image / video / document URL fetched by WhatsApp.
  header_media_type: z.enum(['image','video','document']).optional().nullable(),
  header_media_url:  z.string().url().max(2048).optional().nullable(),
  // Per-language overrides: { hi: { body_text, header_text?, footer_text? }, bn: {...}, ... }
  translations: z.record(z.object({
    body_text:   z.string().max(2000).optional(),
    header_text: z.string().max(300).optional(),
    footer_text: z.string().max(300).optional(),
  })).optional().nullable(),
});

export const sendWhatsappSchema = z.object({
  to: z.string().min(5).max(40),
  body_text: z.string().max(2000).optional(),
  template_id: optionalUuid,
  template_variables: z.record(z.string()).optional(),
  media_url: z.string().url().optional(),
  media_type: z.enum(['image','document','audio','video','sticker']).optional(),
  lead_id: optionalUuid,
  contact_id: optionalUuid,
  deal_id: optionalUuid,
}).refine((b) => Boolean(b.body_text || b.template_id || b.media_url), {
  message: 'One of body_text, template_id, or media_url is required',
  path: ['body_text'],
});

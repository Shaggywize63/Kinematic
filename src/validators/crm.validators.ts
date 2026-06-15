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
  // City is REQUIRED on lead/contact create — the CRM enforces
  // per-user city scope (req.user.assigned_city_names) on every read,
  // and a lead with no city slips past that filter and becomes visible
  // to every user in the org. Force it at the schema level so no
  // creation path (form, integration webhook, KINI tool, bulk import)
  // can land a city-less row.
  city: z.string().min(1, { message: 'City is required' }).max(120),
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
  // Last name is mandatory on create — captured at every form entry
  // point. The .optional().nullable() on leadUpdateSchema (via
  // .partial() below) still lets PATCH skip the field for partial
  // updates, so existing records without last_name don't fail on
  // edit.
  last_name: z.string().min(1, 'Last name is required').max(120),
  email: z.string().email().optional().nullable(),
  // Indian mobile — exactly 10 digits. Tightened from the prior
  // free-form max(40) because reps were pasting in country codes /
  // spaces and the resulting strings didn't roll up cleanly into
  // city / source / dedup reports. Optional / nullable preserved so
  // PATCHes that don't touch phone still work; an explicit empty
  // string is coerced to null upstream in the service.
  phone: z.string().regex(/^\d{10}$/, 'Mobile number must be 10 digits').optional().nullable(),
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
  // Optional profile photo URL — typically a Supabase storage path
  // produced by /upload/photo. Set to null to clear an existing photo.
  photo_url: z.string().url().max(2048).optional().nullable(),
  // Geo coordinates — captured on add via device GPS / manual entry, or
  // backfilled via the bulk coordinate upload. Rendered on the dashboard
  // map. Optional + nullable so non-geo creation paths are unaffected.
  latitude:  z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  // Tata Tiscon affordance: tick a "Also log as Site Visit" checkbox in
  // the create form to atomically spawn a `crm_activities` row of type
  // 'site_visit' tied to the new lead in one round-trip. The backend
  // pops this key before persisting (it isn't a column) and only honours
  // it for clients that have the matching activity type configured.
  _auto_log_site_visit: z.boolean().optional(),
  // Accepted but ignored — the activity subject is now derived from the
  // existing first_visit_date custom field on the lead, so we no longer
  // need a separate flag. Kept in the schema only so older clients still
  // mid-rollout don't 400 on it.
  _site_visit_first: z.boolean().optional(),
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
  // Multi-product deal — overrides the single-product fields above when
  // present. Each line item carries pieces (preferred input), kg, and a
  // computed subtotal. Backend sums subtotals into deal.amount, sums
  // kg into custom_fields.volume_kg, and persists the array verbatim
  // into deal.custom_fields.line_items so the deal detail page can
  // render the breakdown later.
  deal_line_items: z.array(z.object({
    product_id: z.string().uuid(),
    pieces: z.number().nonnegative().optional(),
    volume_kg: z.number().nonnegative().optional(),
    subtotal: z.number().nonnegative().optional(),
  })).max(50).optional(),
  pipeline_id: optionalUuid,
  stage_id: optionalUuid,
});

// Optional free-text reason supplied when a rep re-opens a previously
// disqualified or converted lead. Kept short (≤500) so it fits in the
// crm_lead_history.new_value jsonb without bloating the audit table.
export const leadReopenSchema = z.object({
  reason: z.string().max(500).optional(),
});

// Bulk lat/long backfill for existing leads. Each row matches one lead by
// id (preferred), then email, then phone. Used by the dashboard "upload
// coordinates" tool to geotag old leads in one shot.
export const leadBulkCoordinatesSchema = z.object({
  rows: z.array(
    z.object({
      id: optionalUuid,
      email: z.string().email().optional().nullable(),
      phone: z.string().max(40).optional().nullable(),
      latitude:  z.coerce.number().min(-90).max(90),
      longitude: z.coerce.number().min(-180).max(180),
    }).refine((r) => Boolean(r.id || r.email || r.phone), {
      message: 'Each row needs an id, email, or phone to match a lead',
    }),
  ).min(1).max(10000),
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
  // pipeline_id + stage_id are optional at the API boundary because
  // deals.service.ts:resolveDefaultPipeline() auto-picks the org's
  // default pipeline (and its first stage) when the caller hasn't
  // chosen. Previously these were required uuid and Zod rejected the
  // request before the auto-resolve had a chance to run — every
  // "create deal" with blank pipeline ended in a 400. Make them
  // optional so the service-level fallback can do its job.
  pipeline_id: optionalUuid,
  stage_id: optionalUuid,
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

// Activity inner shape — kept separate from the refined wrapper so
// `.partial()` (used by the PATCH route) still works. ZodEffects from
// `.refine()` doesn't expose `.partial()`, so route handlers reach for
// `activitySchemaBase.partial()` on update.
export const activitySchemaBase = z.object({
  // Accept any short slug — built-ins (call/meeting/email/note/task/sms/whatsapp)
  // are still defaults, but clients can add custom types via Settings →
  // Activity Types. Shape enforced so the DB stays clean.
  type: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'lowercase letters, digits, _, - only'),
  subject: z.string().max(200).optional().nullable(),
  body: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  // Free-text result of the activity (e.g. Connected, No answer, Interested),
  // set from the CRM activity editor. Backed by crm_activities.outcome.
  outcome: z.string().max(500).optional().nullable(),
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

// Create-side schema enforces a linked entity. Activities without a
// parent record (no lead / contact / account / deal) are orphans —
// they never surface in any timeline view and can leak past the
// per-user city-scope filter (city lives on the lead/contact, not the
// activity). Block at the validator.
export const activitySchema = activitySchemaBase.refine(
  (a) => Boolean(a.lead_id || a.contact_id || a.account_id || a.deal_id),
  {
    message: 'Activity must be linked to a lead, contact, account, or deal',
    path: ['lead_id'],
  },
);

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

// Triggers fired by the event-driven engine in automations.service.ts.
// Time-based triggers (e.g. 'lead_stuck_7_days') will be added when the
// cron worker lands.
const automationTriggerType = z.enum([
  'lead_created',
  'lead_status_changed',
  'lead_lifecycle_stage_changed',
  'lead_owner_changed',
  'lead_disqualified',
  'lead_converted',
  'deal_created',
  'deal_stage_changed',
  'deal_won',
  'deal_lost',
]);

const automationActionType = z.enum([
  'create_task',
  'create_activity',
  'update_lead',
  'send_notification',
]);

const automationCondition = z.object({
  // Dotted path into the trigger's context data, e.g. 'lead.score' or
  // 'after.status'. See automations.service.ts AutomationContext.
  field: z.string().min(1),
  op: z.enum(['=','==','!=','>','>=','<','<=','in','contains','exists']),
  value: z.unknown(),
});

export const automationSchema = z.object({
  name: z.string().min(1).max(200),
  client_id: optionalUuid,
  trigger_type: automationTriggerType,
  // Conditions live inside trigger_config to keep the DB schema flat
  // (one action per row, no separate conditions table). The engine
  // reads trigger_config.conditions; everything else under trigger_config
  // is passed through for forward-compat (e.g. future time-based windows).
  trigger_config: z.object({
    conditions: z.array(automationCondition).default([]),
  }).passthrough().default({ conditions: [] }),
  action_type: automationActionType,
  action_config: z.record(z.unknown()).default({}),
  is_active: z.boolean().optional(),
});

export const customFieldSchema = z.object({
  entity_type: z.enum(['lead','contact','account','deal']),
  field_key: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(120),
  // Full set of supported field types. Beyond the originals we now also
  // include `lookup` — a Salesforce-style "linked record" field that
  // points at another table (lead/contact/account/deal/people_directory)
  // and stores the picked row's UUID in custom_fields. Configured via
  // the `target_table` + `lookup_filter` columns; the picker UI is
  // wired in the dashboard's custom-field editor.
  field_type: z.enum([
    'text', 'longtext', 'number', 'currency', 'boolean',
    'date', 'datetime',
    'select', 'multiselect', 'radio',
    'url', 'email', 'phone',
    'image', 'file',
    'lookup',
    // Read-only computed field — value is derived from a `formula`
    // expression that references other custom fields via {field_key}.
    // Supports + - * / parentheses + the small function set
    // IF / MIN / MAX / ROUND. Stored as the expression string in
    // `formula`; the computed value is stamped into `custom_fields`
    // server-side on every read of the parent row.
    'formula',
  ]),
  options: z.array(z.string()).optional().nullable(),
  required: z.boolean().optional(),
  // Hides the field from create / edit forms without deleting stored
  // values. Admin toggles it under CRM Settings → Custom Fields.
  // Backend column added by migration_custom_field_hidden.sql.
  hidden: z.boolean().optional(),
  position: z.number().int().optional(),
  // Org roles that should see this field. Empty/null = all roles (universal).
  // Lets clients give each hierarchy role its own set of custom fields.
  org_role_ids: z.array(z.string().uuid()).optional().nullable(),
  // Lookup-only — which table the picker should search and the optional
  // filter that narrows the rows. Any public table that carries an `org_id`
  // column is a valid target; `list_lookup_tables()` is the source of truth
  // for what the dashboard offers. We just enforce a snake_case identifier
  // shape here so admins can't smuggle SQL / dotted names through the
  // validator. The /lookup/search endpoint is what actually scopes the
  // resulting query to the caller's org + client.
  target_table: z.string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'target_table must be a lowercase snake_case table name')
    .max(63)
    .optional().nullable(),
  // Simple condition list — every clause is ANDed. `field` is a column
  // on the target table; `op` is one of {eq, ne, contains, gte, lte};
  // `value` is the raw value to match. Salesforce-style OR groups and
  // per-type operator universes are intentionally out of scope for v1.
  lookup_filter: z.array(z.object({
    field: z.string().min(1).max(80),
    op: z.enum(['eq', 'ne', 'contains', 'gte', 'lte']),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })).optional().nullable(),
  // Formula expression for field_type='formula'. Sanity-capped to keep
  // pathological inputs from running away in the evaluator.
  formula: z.string().min(1).max(500).optional().nullable(),
});

// Bulk-reorder payload for drag-and-drop on the custom-fields page.
// Frontend sends [{ id, position }] for the new order; backend updates
// each row's position in a single batch. Position is just an int —
// gaps are fine, only relative order matters.
export const customFieldReorderSchema = z.object({
  items: z.array(z.object({
    id: uuid,
    position: z.number().int().min(0),
  })).min(1).max(200),
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

// Purpose-built email TEMPLATE generation (KINI AI Generate in the template
// section). Unlike draftReply this is not lead/deal-centric — just a goal +
// tone + optional audience/language.
export const draftEmailTemplateSchema = z.object({
  goal: z.string().min(1),
  tone: z.enum(['friendly','formal','concise']).default('friendly'),
  audience: z.string().optional(),
  language: z.string().max(8).optional(),
});

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

// People Directory — per-client address book of dealers / influencers /
// referrers that aren't pipelined leads. At least one of first_name,
// last_name, mobile or email must be present so we don't accept an
// entirely empty row (the bulk-import flow skips blanks too). Base object
// is exported separately so PATCH handlers can use `.partial()` on it
// (`refine()` returns ZodEffects, which doesn't expose .partial()).
export const peopleDirectoryBase = z.object({
  first_name: z.string().max(120).optional().nullable(),
  last_name:  z.string().max(120).optional().nullable(),
  mobile:     z.string().max(40).optional().nullable(),
  email:      z.string().email().max(200).optional().nullable(),
  address:    z.string().max(1000).optional().nullable(),
  // Free-text categorisation managed by the admin via the
  // people_directory_types table — common values are Dealer / Engineer /
  // Architect, but the type list is per-tenant so we accept any string
  // the admin has seeded (no enum lock-in here).
  type:       z.string().max(80).optional().nullable(),
  city:       z.string().max(120).optional().nullable(),
  // Tenant-supplied identifier (employee id, dealer code, etc.). Free-form
  // text; tenants like Tata Tiscon need it on every person to roll up
  // their reports. Indexed per (org, client, code) for lookup speed.
  code:       z.string().max(80).optional().nullable(),
});
export const peopleDirectorySchema = peopleDirectoryBase.refine(
  (p) => Boolean(p.first_name?.trim() || p.last_name?.trim() || p.mobile?.trim() || p.email?.trim()),
  { message: 'At least one of first name, last name, mobile or email is required', path: ['first_name'] },
);

// Bulk-import payload: an array of mapped rows the operator confirmed on
// the dashboard mapping screen, plus a flag deciding what to do with
// duplicates (by mobile or email). Server returns counts so the FE can
// display "added X, updated Y, skipped Z".
export const peopleDirectoryBulkImportSchema = z.object({
  rows: z.array(z.object({
    first_name: z.string().max(120).optional().nullable(),
    last_name:  z.string().max(120).optional().nullable(),
    mobile:     z.string().max(40).optional().nullable(),
    email:      z.string().max(200).optional().nullable(),
    address:    z.string().max(1000).optional().nullable(),
    type:       z.string().max(80).optional().nullable(),
    city:       z.string().max(120).optional().nullable(),
    // CSV import sends this as the user-facing "id" column; the
    // mapper renames it to `code` before POSTing here.
    code:       z.string().max(80).optional().nullable(),
  })).min(1).max(5000),
  on_duplicate: z.enum(['skip', 'update']).default('skip'),
});

// Type catalogue managed per (org, client). The admin-facing UI lets
// users add / rename / deactivate / reorder entries. We don't constrain
// the name beyond non-empty + length so localised labels (e.g. Hindi
// transliterations) work without backend changes.
export const peopleDirectoryTypeSchema = z.object({
  name: z.string().min(1).max(80),
  is_active: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

// Activity-subject preset — admin-managed dropdown options on the
// activity compose screen. Same shape as the people-directory type
// schema (name + is_active + position) so the settings UI stays
// uniform across catalogue editors.
export const activitySubjectSchema = z.object({
  name: z.string().min(1).max(120),
  is_active: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

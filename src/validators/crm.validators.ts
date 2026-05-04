/**
 * Zod validators for CRM endpoints. Single file because schemas are small
 * and shared across multiple controllers.
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const optionalUuid = uuid.nullish();
const isoDate = z.string().datetime({ offset: true }).or(z.string().date()).optional().nullable();

export const leadCreateSchema = z.object({
  first_name: z.string().min(1).max(120).optional().nullable(),
  last_name: z.string().min(1).max(120).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  company: z.string().max(200).optional().nullable(),
  title: z.string().max(120).optional().nullable(),
  source_id: optionalUuid,
  status: z.enum(['new','working','nurturing','qualified','unqualified']).optional(),
  owner_id: optionalUuid,
  country: z.string().max(80).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  industry: z.string().max(120).optional().nullable(),
  notes: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const leadUpdateSchema = leadCreateSchema.partial().extend({
  status: z.enum(['new','working','nurturing','qualified','unqualified','converted']).optional(),
});

export const leadConvertSchema = z.object({
  create_deal: z.boolean().default(true),
  deal_name: z.string().max(200).optional(),
  deal_amount: z.number().nonnegative().optional(),
  pipeline_id: optionalUuid,
  stage_id: optionalUuid,
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
  name: z.string().min(1).max(200),
  pipeline_id: uuid,
  stage_id: uuid,
  account_id: optionalUuid,
  primary_contact_id: optionalUuid,
  lead_id: optionalUuid,
  amount: z.number().nonnegative().default(0),
  currency: z.string().length(3).default('INR'),
  expected_close_date: isoDate,
  probability: z.number().min(0).max(100).optional().nullable(),
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
  type: z.enum(['call','meeting','email','note','task','sms']),
  subject: z.string().max(200).optional().nullable(),
  body: z.string().optional().nullable(),
  direction: z.enum(['inbound','outbound']).optional().nullable(),
  status: z.enum(['planned','completed','cancelled']).default('completed'),
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
  probability: z.number().min(0).max(100).default(50),
  stage_type: z.enum(['open','won','lost']).default('open'),
  color: z.string().optional(),
});

export const reorderStagesSchema = z.object({
  pipeline_id: uuid,
  stages: z.array(z.object({ id: uuid, position: z.number().int().nonnegative() })),
});

export const leadSourceSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['csv','manual','web_form','email','api','campaign','referral','event','social','ads']).default('manual'),
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
  variables: z.array(z.string()).optional(),
  category: z.string().max(80).default('general'),
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

export const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().default('email'),
  status: z.enum(['planned','active','paused','completed','cancelled']).default('planned'),
  start_date: isoDate,
  end_date: isoDate,
  budget: z.number().nonnegative().default(0),
  actual_cost: z.number().nonnegative().default(0),
  expected_revenue: z.number().nonnegative().default(0),
  expected_response_rate: z.number().min(0).max(100).default(0),
  description: z.string().optional().nullable(),
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

export const draftReplySchema = z.object({
  lead_id: optionalUuid,
  deal_id: optionalUuid,
  contact_id: optionalUuid,
  incoming_message: z.string().optional(),
  intent: z.string().min(1),
  tone: z.enum(['friendly','formal','concise']).default('friendly'),
  template_hint: z.string().optional(),
});

export const summarizeSchema = z.object({});

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
  variables: z.array(z.string()).optional(),
  provider_template_id: z.string().max(160).optional().nullable(),
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

/**
 * CRM module shared types.
 */

export type LeadStatus = 'new' | 'working' | 'nurturing' | 'qualified' | 'unqualified' | 'converted';
export type StageType = 'open' | 'won' | 'lost';
export type ActivityType = 'call' | 'meeting' | 'email' | 'note' | 'task' | 'sms';
export type ActivityStatus = 'planned' | 'completed' | 'cancelled';
export type EmailStatus = 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed' | 'unsubscribed';
export type WhatsappStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received' | 'replied';
export type WhatsappDirection = 'outbound' | 'inbound';
export type EntityType = 'lead' | 'contact' | 'account' | 'deal';

export interface Pipeline {
  id: string;
  org_id: string;
  name: string;
  description?: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DealStage {
  id: string;
  pipeline_id: string;
  org_id: string;
  name: string;
  position: number;
  probability: number;
  stage_type: StageType;
  color?: string | null;
}

export interface LeadSource {
  id: string;
  org_id: string;
  name: string;
  type: string;
  is_active: boolean;
  cost_per_lead: number;
}

export interface Account {
  id: string;
  org_id: string;
  client_id?: string | null;
  name: string;
  domain?: string | null;
  industry?: string | null;
  size?: string | null;
  annual_revenue?: number | null;
  phone?: string | null;
  website?: string | null;
  billing_address?: Record<string, unknown> | null;
  shipping_address?: Record<string, unknown> | null;
  owner_id?: string | null;
  territory_id?: string | null;
  parent_account_id?: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  ai_summary?: string | null;
  ai_summary_updated_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  org_id: string;
  account_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  title?: string | null;
  department?: string | null;
  linkedin_url?: string | null;
  owner_id?: string | null;
  do_not_contact: boolean;
  email_opt_out: boolean;
  tags: string[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  org_id: string;
  client_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  source_id?: string | null;
  status: LeadStatus;
  owner_id?: string | null;
  score: number;
  score_breakdown: ScoreBreakdown;
  score_updated_at?: string | null;
  last_activity_at?: string | null;
  last_contacted_at?: string | null;
  converted_at?: string | null;
  converted_contact_id?: string | null;
  converted_account_id?: string | null;
  converted_deal_id?: string | null;
  country?: string | null;
  city?: string | null;
  industry?: string | null;
  notes?: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  assignment_rule_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScoreBreakdown {
  base?: number;
  title?: number;
  company_size?: number;
  source?: number;
  engagement?: number;
  recency?: number;
  icp?: number;
  llm_adjustment?: number;
  llm_reasons?: string[];
  llm_confidence?: 'low' | 'med' | 'high';
  total?: number;
  model?: string;
}

export interface Deal {
  id: string;
  org_id: string;
  client_id?: string | null;
  pipeline_id: string;
  stage_id: string;
  name: string;
  account_id?: string | null;
  primary_contact_id?: string | null;
  lead_id?: string | null;
  amount: number;
  currency: string;
  expected_close_date?: string | null;
  actual_close_date?: string | null;
  probability?: number | null;
  win_probability_ai?: number | null;
  win_probability_reasoning?: string | null;
  win_probability_updated_at?: string | null;
  owner_id?: string | null;
  source_id?: string | null;
  lost_reason?: string | null;
  next_step?: string | null;
  next_action_ai?: NextBestAction | null;
  next_action_updated_at?: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NextBestAction {
  action: 'call' | 'email' | 'meeting' | 'send_proposal' | 'nurture' | 'disqualify';
  priority: 'high' | 'med' | 'low';
  reason: string;
  suggested_template_id?: string | null;
  suggested_when: 'now' | 'today' | 'this_week' | 'next_week';
}

export interface Activity {
  id: string;
  org_id: string;
  type: ActivityType;
  subject?: string | null;
  body?: string | null;
  direction?: 'inbound' | 'outbound' | null;
  status: ActivityStatus;
  due_at?: string | null;
  completed_at?: string | null;
  duration_seconds?: number | null;
  lead_id?: string | null;
  contact_id?: string | null;
  account_id?: string | null;
  deal_id?: string | null;
  owner_id?: string | null;
  assigned_to?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  org_id: string;
  entity_type: EntityType;
  entity_id: string;
  body: string;
  pinned: boolean;
  author_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplate {
  id: string;
  org_id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text?: string | null;
  variables: string[];
  category: string;
  is_active: boolean;
}

export interface EmailLog {
  id: string;
  org_id: string;
  template_id?: string | null;
  from_email: string;
  to_email: string;
  cc?: string[] | null;
  bcc?: string[] | null;
  subject: string;
  body_html?: string | null;
  provider_message_id?: string | null;
  provider: string;
  status: EmailStatus;
  lead_id?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
  sent_by?: string | null;
  sent_at?: string | null;
  opened_at?: string | null;
  first_clicked_at?: string | null;
  open_count: number;
  click_count: number;
  tracking_pixel_token?: string | null;
  error?: string | null;
  created_at: string;
}

export interface AssignmentRule {
  id: string;
  org_id: string;
  name: string;
  priority: number;
  is_active: boolean;
  criteria: Record<string, unknown>;
  assign_to_user_id?: string | null;
  assign_to_team_id?: string | null;
  round_robin_pool?: string[] | null;
  pipeline_id?: string | null;
}

export interface Campaign {
  id: string;
  org_id: string;
  name: string;
  type: string;
  status: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';
  start_date?: string | null;
  end_date?: string | null;
  budget: number;
  actual_cost: number;
  expected_revenue: number;
  expected_response_rate: number;
  description?: string | null;
}

export interface ImportJob {
  id: string;
  org_id: string;
  file_name: string;
  total_rows: number;
  processed_rows: number;
  inserted: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
  status: 'pending' | 'mapping' | 'previewing' | 'running' | 'completed' | 'failed';
  mapping: Record<string, string>;
  sample_rows?: Record<string, unknown>[] | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardSummary {
  total_leads: number;
  new_leads_this_week: number;
  qualified_leads: number;
  open_deals: number;
  open_pipeline_value: number;
  weighted_pipeline_value: number;
  closed_won_amount_mtd: number;
  closed_lost_amount_mtd: number;
  win_rate_pct: number;
  avg_sales_cycle_days: number;
  top_owners: Array<{ owner_id: string; name?: string; closed_won: number }>;
  deals_closing_this_week: number;
  hot_leads: number;
}

export interface KiniContext {
  module?: string;
  route?: string;
  entity?: { type?: EntityType; id?: string };
}

// ---------- Phase 2: Products + WhatsApp ----------

export interface ProductCategory {
  id: string;
  org_id: string;
  parent_category_id?: string | null;
  name: string;
  description?: string | null;
  color?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  org_id: string;
  category_id?: string | null;
  sku: string;
  name: string;
  description?: string | null;
  unit: string;
  price: number;
  currency: string;
  tax_rate_pct: number;
  hsn_code?: string | null;
  image_url?: string | null;
  is_active: boolean;
  tags: string[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DealLineItem {
  id: string;
  org_id: string;
  deal_id: string;
  product_id?: string | null;
  name: string;
  description?: string | null;
  sku?: string | null;
  unit: string;
  quantity: number;
  unit_price: number;
  discount_pct: number;
  tax_pct: number;
  line_total: number;
  position: number;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WhatsappTemplate {
  id: string;
  org_id: string;
  meta_template_name: string;
  category: 'utility' | 'marketing' | 'authentication';
  language: string;
  status: 'pending' | 'approved' | 'rejected';
  header_text?: string | null;
  body_text: string;
  footer_text?: string | null;
  variables: string[];
  provider_template_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsappLog {
  id: string;
  org_id: string;
  direction: WhatsappDirection;
  template_id?: string | null;
  from_phone?: string | null;
  to_phone?: string | null;
  body_text?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  template_variables?: Record<string, unknown> | null;
  status: WhatsappStatus;
  provider: string;
  provider_message_id?: string | null;
  error?: string | null;
  lead_id?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  replied_at?: string | null;
  sent_by?: string | null;
  created_at: string;
  updated_at: string;
}

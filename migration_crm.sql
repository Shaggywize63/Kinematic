-- ============================================================
-- KINEMATIC CRM MODULE — FULL SCHEMA MIGRATION
-- Run once against your Supabase project.
-- All tables are tenant-scoped via org_id.
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Settings ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_settings (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL UNIQUE,
  business_type text       NOT NULL DEFAULT 'both' CHECK (business_type IN ('b2b','b2c','both')),
  config       jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_settings_org ON public.crm_settings(org_id);

-- ── Pipelines & Stages ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_pipelines (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  name       text        NOT NULL,
  is_default boolean     NOT NULL DEFAULT false,
  is_active  boolean     NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_crm_pipelines_org ON public.crm_pipelines(org_id);

CREATE TABLE IF NOT EXISTS public.crm_deal_stages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  pipeline_id uuid        NOT NULL REFERENCES public.crm_pipelines(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  position    int         NOT NULL DEFAULT 0,
  stage_type  text        NOT NULL DEFAULT 'open' CHECK (stage_type IN ('open','won','lost')),
  probability int         NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  color       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_stages_pipeline ON public.crm_deal_stages(pipeline_id, position);

-- ── Lead Sources ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_lead_sources (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  name        text        NOT NULL,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- ── Territories ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_territories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  name        text        NOT NULL,
  description text,
  parent_id   uuid        REFERENCES public.crm_territories(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Accounts (companies) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_accounts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid        NOT NULL,
  name              text        NOT NULL,
  domain            text,
  industry          text,
  company_size      text,
  annual_revenue    numeric(18,2),
  website           text,
  phone             text,
  email             text,
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  postal_code       text,
  country           text        DEFAULT 'India',
  territory_id      uuid        REFERENCES public.crm_territories(id),
  parent_account_id uuid        REFERENCES public.crm_accounts(id),
  owner_id          uuid,
  tags              text[]      DEFAULT '{}',
  custom_fields     jsonb       DEFAULT '{}',
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid
);
CREATE INDEX IF NOT EXISTS idx_crm_accounts_org ON public.crm_accounts(org_id) WHERE deleted_at IS NULL;

-- ── Contacts (people) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_contacts (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid        NOT NULL,
  first_name               text,
  last_name                text,
  email                    text,
  phone                    text,
  title                    text,
  department               text,
  account_id               uuid        REFERENCES public.crm_accounts(id),
  owner_id                 uuid,
  do_not_contact           boolean     DEFAULT false,
  email_opt_out            boolean     DEFAULT false,
  marketing_consent        boolean     DEFAULT false,
  whatsapp_consent         boolean     DEFAULT false,
  preferred_contact_method text,
  address_line1            text,
  address_line2            text,
  city                     text,
  state                    text,
  postal_code              text,
  country                  text        DEFAULT 'India',
  date_of_birth            date,
  gender                   text,
  tags                     text[]      DEFAULT '{}',
  custom_fields            jsonb       DEFAULT '{}',
  deleted_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_by               uuid
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_org ON public.crm_contacts(org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_account ON public.crm_contacts(account_id) WHERE deleted_at IS NULL;

-- ── Leads ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_leads (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid        NOT NULL,
  first_name            text,
  last_name             text,
  email                 text,
  phone                 text,
  company               text,
  title                 text,
  industry              text,
  is_b2c                boolean     NOT NULL DEFAULT true,
  status                text        NOT NULL DEFAULT 'new' CHECK (status IN ('new','working','qualified','unqualified','converted')),
  source_id             uuid        REFERENCES public.crm_lead_sources(id),
  owner_id              uuid,
  territory_id          uuid        REFERENCES public.crm_territories(id),
  score                 int         NOT NULL DEFAULT 0,
  score_breakdown       jsonb       DEFAULT '{}',
  score_grade           text        DEFAULT 'D',
  score_updated_at      timestamptz,
  last_activity_at      timestamptz,
  date_of_birth         date,
  gender                text,
  address_line1         text,
  address_line2         text,
  city                  text,
  state                 text,
  postal_code           text,
  country               text        DEFAULT 'India',
  preferred_contact_method text,
  marketing_consent     boolean     DEFAULT false,
  whatsapp_consent      boolean     DEFAULT false,
  is_converted          boolean     NOT NULL DEFAULT false,
  converted_at          timestamptz,
  converted_account_id  uuid        REFERENCES public.crm_accounts(id),
  converted_contact_id  uuid        REFERENCES public.crm_contacts(id),
  converted_deal_id     uuid,
  custom_fields         jsonb       DEFAULT '{}',
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_by            uuid
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_org_status ON public.crm_leads(org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_leads_owner ON public.crm_leads(org_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_leads_score ON public.crm_leads(org_id, score DESC) WHERE deleted_at IS NULL;

-- ── Deals (opportunities) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_deals (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid        NOT NULL,
  name                text        NOT NULL,
  pipeline_id         uuid        REFERENCES public.crm_pipelines(id),
  stage_id            uuid        REFERENCES public.crm_deal_stages(id),
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  amount              numeric(18,2),
  currency            text        NOT NULL DEFAULT 'INR',
  expected_close_date date,
  close_date          date,
  probability         int         DEFAULT 0,
  win_probability_ai  int,
  next_action_ai      jsonb,
  lost_reason         text,
  win_reason          text,
  lead_id             uuid        REFERENCES public.crm_leads(id),
  account_id          uuid        REFERENCES public.crm_accounts(id),
  contact_id          uuid        REFERENCES public.crm_contacts(id),
  owner_id            uuid,
  tags                text[]      DEFAULT '{}',
  custom_fields       jsonb       DEFAULT '{}',
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid
);
CREATE INDEX IF NOT EXISTS idx_crm_deals_org_status ON public.crm_deals(org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_pipeline ON public.crm_deals(org_id, pipeline_id, stage_id) WHERE deleted_at IS NULL;

-- FK from crm_leads.converted_deal_id
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_converted_deal') THEN
    ALTER TABLE public.crm_leads ADD CONSTRAINT fk_lead_converted_deal
      FOREIGN KEY (converted_deal_id) REFERENCES public.crm_deals(id);
  END IF;
END $$;

-- ── Deal History ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_deal_history (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL,
  deal_id         uuid        NOT NULL REFERENCES public.crm_deals(id) ON DELETE CASCADE,
  from_stage_id   uuid,
  to_stage_id     uuid,
  from_status     text,
  to_status       text,
  changed_by      uuid,
  reason          text,
  amount_at_change numeric(18,2),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_deal_history ON public.crm_deal_history(deal_id, created_at DESC);

-- ── Lead Score History ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_lead_scores (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  lead_id    uuid        NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  score      int         NOT NULL,
  grade      text,
  breakdown  jsonb       DEFAULT '{}',
  model      text        DEFAULT 'heuristic',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_scores ON public.crm_lead_scores(lead_id, created_at DESC);

-- ── Deal Line Items ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_product_categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  name        text        NOT NULL,
  description text,
  parent_id   uuid        REFERENCES public.crm_product_categories(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS public.crm_products (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL,
  name          text        NOT NULL,
  code          text,
  description   text,
  category_id   uuid        REFERENCES public.crm_product_categories(id),
  unit_price    numeric(14,2),
  currency      text        DEFAULT 'INR',
  unit          text,
  is_active     boolean     NOT NULL DEFAULT true,
  custom_fields jsonb       DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.crm_deal_line_items (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL,
  deal_id      uuid        NOT NULL REFERENCES public.crm_deals(id) ON DELETE CASCADE,
  product_id   uuid        REFERENCES public.crm_products(id),
  name         text        NOT NULL,
  quantity     numeric(10,3) NOT NULL DEFAULT 1,
  unit_price   numeric(14,2) NOT NULL DEFAULT 0,
  discount_pct numeric(5,2)  DEFAULT 0,
  line_total   numeric(18,2),
  currency     text        DEFAULT 'INR',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_line_items_deal ON public.crm_deal_line_items(deal_id);

-- ── Deal Contacts (M:N) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_deal_contacts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  deal_id    uuid        NOT NULL REFERENCES public.crm_deals(id) ON DELETE CASCADE,
  contact_id uuid        NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  role       text,
  is_primary boolean     DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, contact_id)
);

-- ── Activities (unified: call, email, meeting, task, note, sms, whatsapp) ──
CREATE TABLE IF NOT EXISTS public.crm_activities (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL,
  type            text        NOT NULL DEFAULT 'note' CHECK (type IN ('call','email','meeting','task','note','sms','whatsapp')),
  subject         text        NOT NULL,
  body            text,
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  priority        text        DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  due_at          timestamptz,
  completed_at    timestamptz,
  duration_seconds int,
  linked_to_type  text        CHECK (linked_to_type IN ('lead','contact','deal','account')),
  linked_to_id    uuid,
  lead_id         uuid        REFERENCES public.crm_leads(id),
  contact_id      uuid        REFERENCES public.crm_contacts(id),
  deal_id         uuid        REFERENCES public.crm_deals(id),
  account_id      uuid        REFERENCES public.crm_accounts(id),
  assigned_to     uuid,
  created_by      uuid,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_org_type ON public.crm_activities(org_id, type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_activities_linked ON public.crm_activities(linked_to_type, linked_to_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_activities_due ON public.crm_activities(org_id, due_at) WHERE deleted_at IS NULL AND due_at IS NOT NULL;

-- ── Notes ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_notes (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL,
  content        text        NOT NULL,
  linked_to_type text        CHECK (linked_to_type IN ('lead','contact','deal','account')),
  linked_to_id   uuid,
  lead_id        uuid        REFERENCES public.crm_leads(id),
  contact_id     uuid        REFERENCES public.crm_contacts(id),
  deal_id        uuid        REFERENCES public.crm_deals(id),
  account_id     uuid        REFERENCES public.crm_accounts(id),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_notes_linked ON public.crm_notes(linked_to_type, linked_to_id);

-- ── Assignment Rules ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_assignment_rules (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL,
  name             text        NOT NULL,
  match_field      text        NOT NULL,
  match_op         text        NOT NULL DEFAULT 'equals',
  match_value      text        NOT NULL,
  assignee_user_id uuid,
  territory_id     uuid        REFERENCES public.crm_territories(id),
  is_active        boolean     NOT NULL DEFAULT true,
  position         int         NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── Custom Field Definitions ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_custom_field_defs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  entity     text        NOT NULL CHECK (entity IN ('lead','contact','account','deal')),
  field_key  text        NOT NULL,
  label      text        NOT NULL,
  field_type text        NOT NULL CHECK (field_type IN ('text','number','date','select','multiselect','boolean')),
  options    text[],
  required   boolean     NOT NULL DEFAULT false,
  position   int         NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entity, field_key)
);

-- ── Workflow Automations ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_automations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL,
  name           text        NOT NULL,
  trigger_type   text        NOT NULL,
  trigger_config jsonb       DEFAULT '{}',
  action_type    text        NOT NULL,
  action_config  jsonb       DEFAULT '{}',
  is_active      boolean     NOT NULL DEFAULT true,
  run_count      int         NOT NULL DEFAULT 0,
  last_run_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── Email Templates & Logs ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_email_templates (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  name       text        NOT NULL,
  subject    text        NOT NULL,
  body_html  text,
  body_text  text,
  category   text,
  variables  jsonb       DEFAULT '[]',
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.crm_email_logs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid        NOT NULL,
  template_id          uuid        REFERENCES public.crm_email_templates(id),
  lead_id              uuid        REFERENCES public.crm_leads(id),
  contact_id           uuid        REFERENCES public.crm_contacts(id),
  deal_id              uuid        REFERENCES public.crm_deals(id),
  to_email             text        NOT NULL,
  to_name              text,
  subject              text        NOT NULL,
  body_html            text,
  status               text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','opened','clicked','bounced','failed','unsubscribed')),
  provider_message_id  text,
  sent_at              timestamptz,
  opened_at            timestamptz,
  clicked_at           timestamptz,
  error_message        text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_email_logs_org ON public.crm_email_logs(org_id, created_at DESC);

-- ── WhatsApp Templates & Logs ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_whatsapp_templates (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  name       text        NOT NULL,
  body_text  text        NOT NULL,
  variables  text[]      DEFAULT '{}',
  media_type text,
  is_active  boolean     DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.crm_whatsapp_logs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid        NOT NULL,
  to_number            text        NOT NULL,
  body_text            text,
  template_id          uuid        REFERENCES public.crm_whatsapp_templates(id),
  template_variables   jsonb       DEFAULT '{}',
  media_url            text,
  media_type           text,
  lead_id              uuid        REFERENCES public.crm_leads(id),
  contact_id           uuid        REFERENCES public.crm_contacts(id),
  deal_id              uuid        REFERENCES public.crm_deals(id),
  status               text        NOT NULL DEFAULT 'queued',
  provider_message_id  text,
  sent_at              timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ── Import Jobs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_import_jobs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL,
  entity         text        NOT NULL DEFAULT 'lead',
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','mapping','preview','processing','done','failed')),
  filename       text,
  file_url       text,
  mapping        jsonb       DEFAULT '{}',
  total_rows     int         DEFAULT 0,
  processed_rows int         DEFAULT 0,
  inserted_rows  int         DEFAULT 0,
  skipped_rows   int         DEFAULT 0,
  errors         jsonb       DEFAULT '[]',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── States & Cities (geo lookup) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_states (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  name       text        NOT NULL,
  code       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS public.crm_cities (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL,
  state_id   uuid        NOT NULL REFERENCES public.crm_states(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, state_id, name)
);

-- ── updated_at triggers ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crm_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_settings','crm_pipelines','crm_deal_stages','crm_lead_sources',
    'crm_territories','crm_accounts','crm_contacts','crm_leads','crm_deals',
    'crm_activities','crm_notes','crm_assignment_rules','crm_custom_field_defs',
    'crm_automations','crm_email_templates','crm_email_logs',
    'crm_whatsapp_templates','crm_products','crm_deal_line_items','crm_import_jobs'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I;
       CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;

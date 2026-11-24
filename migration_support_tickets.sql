-- Support tickets (Help & Support in the dashboard, "Raise an issue" on KINI WhatsApp, the support inbox).
-- One queue for every customer, whatever project their data lives in: always stored in the Kinematic project
-- (services/support/supportTickets.service.ts writes here explicitly). Additive and idempotent. Kinematic project only.
CREATE SEQUENCE IF NOT EXISTS public.support_ticket_seq START 5001;

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                text NOT NULL DEFAULT ('KM-' || nextval('public.support_ticket_seq')::text),
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed')),
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  category           text NOT NULL DEFAULT 'other'
                     CHECK (category IN ('how_to', 'bug', 'data', 'billing', 'feature_request', 'other')),
  subject            text NOT NULL,
  description        text NOT NULL,
  channel            text NOT NULL DEFAULT 'dashboard' CHECK (channel IN ('whatsapp', 'dashboard', 'app')),
  project_key        text,
  org_id             uuid,
  org_name           text,
  raised_by_user_id  uuid,
  contact_name       text,
  contact_phone      text,
  contact_email      text,
  resolution_note    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_tickets_ref ON public.support_tickets (ref);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON public.support_tickets (project_key, org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_phone ON public.support_tickets (contact_phone);

CREATE TABLE IF NOT EXISTS public.support_ticket_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('created', 'status', 'comment')),
  author_type  text NOT NULL CHECK (author_type IN ('customer', 'team', 'system')),
  author_name  text,
  from_status  text,
  to_status    text,
  body         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket ON public.support_ticket_events (ticket_id, created_at);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;        -- deny-by-default; service-role bypasses
ALTER TABLE public.support_ticket_events ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';

/**
 * KINI CRM tool registry. Wires CRM data into the existing chatbot
 * via Anthropic tool use (with structured-prompt fallback).
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { sanitisePostgrestSearch } from '../../../utils';
import * as autoResponse from './autoResponse.service';
import * as summarize from './summarize.service';
import * as leadsSvc from '../leads.service';

export interface KiniTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  exec: (org_id: string, client_id: string | null, args: Record<string, unknown>) => Promise<unknown>;
}

export interface KiniToolResult {
  tool: string;
  data: unknown;
  card?: { type: string; data: unknown };
}

// Hard client isolation — when a client is in scope (admin picked one in the
// global header, or a client-level user is logged in), every tool only sees
// that client's rows. With no client picked we leave the query unscoped so
// org admins still get an org-wide view of the chatbot.
//
// Typed as `any` to avoid TS2589 (excessively deep instantiation) from
// Supabase's filter-builder generics — the cast is a no-op at runtime.
function scopeToClient<Q>(q: Q, client_id: string | null): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client_id ? ((q as any).eq('client_id', client_id) as Q) : q;
}

// Hard guard for AI-driven mutations. Reads the target lead and
// throws if it lives under a different client than the actor's
// scope. When the actor has no client_id pinned (org-wide / super
// admin), any client is allowed. Called BEFORE delegating to the
// lead service which only checks org_id.
async function assertLeadInClientScope(org_id: string, client_id: string | null, lead_id: string): Promise<void> {
  if (!client_id) return; // org-wide actor — leadsSvc enforces org boundary
  const { data, error } = await supabaseAdmin
    .from('crm_leads')
    .select('client_id')
    .eq('id', lead_id)
    .eq('org_id', org_id)
    .maybeSingle();
  if (error || !data) throw new Error('Lead not found');
  // Cross-client mutation refused. `client_id` on the lead row can be
  // null (org-wide lead) — we allow that, since it predates the
  // multi-client split. The block fires when the lead is explicitly
  // assigned to a *different* client than the caller.
  if (data.client_id && data.client_id !== client_id) {
    throw new Error('Lead belongs to a different client; cannot mutate from this scope');
  }
}

export const tools: KiniTool[] = [
  {
    name: 'crm_search_leads',
    description: 'Search CRM leads. Filter by status, minimum score, or text query.',
    input_schema: { type: 'object', properties: {
      status: { type: 'string' },
      score_gte: { type: 'number' },
      q: { type: 'string' },
      limit: { type: 'number', default: 10 },
    }},
    exec: async (org_id, client_id, args) => {
      let q = supabaseAdmin.from('crm_leads').select('id, first_name, last_name, email, company, title, status, score, owner_id')
        .eq('org_id', org_id).is('deleted_at', null);
      q = scopeToClient(q, client_id);
      if (args.status) q = q.eq('status', String(args.status));
      if (args.score_gte) q = q.gte('score', Number(args.score_gte));
      if (args.q) {
        // Sanitise — see utils/postgrest.ts for the threat model. The model
        // can also produce hostile filter syntax via tool-use input, not
        // just direct user input.
        const s = sanitisePostgrestSearch(args.q);
        if (s) q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%`);
      }
      const { data } = await q.order('score', { ascending: false }).limit(Math.min(Number(args.limit ?? 10), 50));
      return { card: { type: 'lead_list', data: { leads: data ?? [] } }, data };
    },
  },
  {
    name: 'crm_top_leads_by_score',
    description: 'Top N leads ranked by score.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', default: 10 } } },
    exec: async (org_id, client_id, args) => {
      let q = supabaseAdmin.from('crm_leads')
        .select('id, first_name, last_name, email, company, title, score, owner_id, status')
        .eq('org_id', org_id).is('deleted_at', null).neq('status', 'converted');
      q = scopeToClient(q, client_id);
      const { data } = await q.order('score', { ascending: false }).limit(Math.min(Number(args.limit ?? 10), 50));
      return { card: { type: 'lead_list', data: { leads: data ?? [], title: 'Hottest leads' } }, data };
    },
  },
  {
    name: 'crm_get_lead',
    description: 'Get a single lead by id.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    exec: async (org_id, client_id, args) => {
      let q = supabaseAdmin.from('crm_leads').select('*')
        .eq('org_id', org_id).eq('id', String(args.id));
      q = scopeToClient(q, client_id);
      const { data } = await q.maybeSingle();
      return { data };
    },
  },
  {
    name: 'crm_search_deals',
    description: 'Search deals. Filter by status (open/won/lost), close date before, minimum amount, or owner.',
    input_schema: { type: 'object', properties: {
      stage_type: { type: 'string', enum: ['open','won','lost'] },
      closing_before: { type: 'string' },
      owner_id: { type: 'string' },
      min_amount: { type: 'number' },
      limit: { type: 'number', default: 10 },
    }},
    exec: async (org_id, client_id, args) => {
      let q = supabaseAdmin.from('crm_deals')
        .select('id, name, amount, currency, stage_id, expected_close_date, win_probability_ai, owner_id, account_id, crm_deal_stages!inner(stage_type, name)')
        .eq('org_id', org_id).is('deleted_at', null);
      q = scopeToClient(q, client_id);
      if (args.stage_type) q = q.eq('crm_deal_stages.stage_type', String(args.stage_type));
      if (args.closing_before) q = q.lte('expected_close_date', String(args.closing_before));
      if (args.owner_id) q = q.eq('owner_id', String(args.owner_id));
      if (args.min_amount) q = q.gte('amount', Number(args.min_amount));
      const { data } = await q.order('expected_close_date', { ascending: true })
        .limit(Math.min(Number(args.limit ?? 10), 50));
      return { card: { type: 'deal_list', data: { deals: data ?? [] } }, data };
    },
  },
  {
    name: 'crm_deals_closing',
    description: 'Deals expected to close within a number of days (default 7).',
    input_schema: { type: 'object', properties: { days: { type: 'number', default: 7 } } },
    exec: async (org_id, client_id, args) => {
      const days = Number(args.days ?? 7);
      const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      let q = supabaseAdmin.from('crm_deals')
        .select('id, name, amount, currency, expected_close_date, win_probability_ai, owner_id, account_id, crm_deal_stages!inner(stage_type, name)')
        .eq('org_id', org_id).is('deleted_at', null)
        .eq('crm_deal_stages.stage_type', 'open')
        .lte('expected_close_date', cutoff);
      q = scopeToClient(q, client_id);
      const { data } = await q.order('expected_close_date', { ascending: true }).limit(50);
      return { card: { type: 'deal_list', data: { deals: data ?? [], title: `Deals closing in next ${days} days` } }, data };
    },
  },
  {
    name: 'crm_get_deal',
    description: 'Get a single deal by id.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    exec: async (org_id, client_id, args) => {
      let q = supabaseAdmin.from('crm_deals').select('*')
        .eq('org_id', org_id).eq('id', String(args.id));
      q = scopeToClient(q, client_id);
      const { data } = await q.maybeSingle();
      return { data };
    },
  },
  {
    name: 'crm_summarize_account',
    description: 'Generate an AI summary of a CRM account.',
    input_schema: { type: 'object', required: ['account_id'], properties: { account_id: { type: 'string' } } },
    exec: async (org_id, client_id, args) => {
      // Cross-client guard — confirm the account is in scope before summarising.
      // Without this, a client-A user could summarise a client-B account by ID.
      let g = supabaseAdmin.from('crm_accounts').select('id')
        .eq('org_id', org_id).eq('id', String(args.account_id));
      g = scopeToClient(g, client_id);
      const { data: acc } = await g.maybeSingle();
      if (!acc) return { data: { text: 'Account not found in this scope.' } };
      const text = await summarize.summarizeAccount(org_id, String(args.account_id));
      return { card: { type: 'summary', data: { text, account_id: args.account_id } }, data: { text } };
    },
  },
  {
    name: 'crm_pipeline_summary',
    description: 'Aggregate pipeline value, weighted value, and counts by stage.',
    input_schema: { type: 'object', properties: { pipeline_id: { type: 'string' } } },
    exec: async (org_id, client_id, args) => {
      // Resolve in-scope pipelines first; the materialized view doesn't carry
      // client_id so we filter the source pipeline IDs and pass them in.
      let pq = supabaseAdmin.from('crm_pipelines').select('id').eq('org_id', org_id);
      pq = scopeToClient(pq, client_id);
      if (args.pipeline_id) pq = pq.eq('id', String(args.pipeline_id));
      const { data: pipes } = await pq;
      const ids = (pipes ?? []).map((p) => p.id as string);
      if (ids.length === 0) {
        return { card: { type: 'summary', data: { text: 'No pipelines in scope.' } }, data: { stages: [], total: 0, weighted: 0 } };
      }
      const { data } = await supabaseAdmin.from('crm_mv_pipeline_value')
        .select('*').eq('org_id', org_id).in('pipeline_id', ids);
      const total = (data ?? []).reduce((s, r) => s + Number(r.total_amount || 0), 0);
      const weighted = (data ?? []).reduce((s, r) => s + Number(r.weighted_amount || 0), 0);
      return {
        card: { type: 'summary', data: { text: `Open pipeline: ${total.toLocaleString()} (weighted: ${Math.round(weighted).toLocaleString()}). Stage breakdown attached.` } },
        data: { stages: data, total, weighted },
      };
    },
  },
  {
    name: 'crm_draft_email',
    description: 'Draft an email reply for a lead, contact, or deal. Returns subject/body. Does NOT send.',
    input_schema: { type: 'object', required: ['intent'], properties: {
      lead_id: { type: 'string' }, contact_id: { type: 'string' }, deal_id: { type: 'string' },
      intent: { type: 'string' }, tone: { type: 'string', enum: ['friendly','formal','concise'] },
    }},
    exec: async (org_id, client_id, args) => {
      // Cross-client guard — confirm any referenced entity is in scope before
      // drafting against it. The drafter pulls entity context internally;
      // skip the lookup if nothing checks out so we don't leak info.
      const checkScope = async (table: string, id: string | null) => {
        if (!id) return true;
        let g = supabaseAdmin.from(table).select('id').eq('org_id', org_id).eq('id', id);
        g = scopeToClient(g, client_id);
        const { data } = await g.maybeSingle();
        return Boolean(data);
      };
      const ok = await Promise.all([
        checkScope('crm_leads',    (args.lead_id    as string) ?? null),
        checkScope('crm_contacts', (args.contact_id as string) ?? null),
        checkScope('crm_deals',    (args.deal_id    as string) ?? null),
      ]);
      if (ok.includes(false)) return { data: { error: 'Referenced entity is not in this client scope.' } };
      const draft = await autoResponse.draftReply({
        org_id,
        lead_id: (args.lead_id as string) ?? null,
        contact_id: (args.contact_id as string) ?? null,
        deal_id: (args.deal_id as string) ?? null,
        intent: String(args.intent),
        tone: (args.tone as 'friendly' | 'formal' | 'concise') ?? 'friendly',
      });
      return { card: { type: 'draft_email', data: draft }, data: draft };
    },
  },
  {
    name: 'crm_create_task',
    description: 'Create a task related to a lead/contact/account/deal.',
    input_schema: { type: 'object', required: ['subject','due_at'], properties: {
      subject: { type: 'string' }, due_at: { type: 'string' },
      lead_id: { type: 'string' }, contact_id: { type: 'string' },
      account_id: { type: 'string' }, deal_id: { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      const { data } = await supabaseAdmin.from('crm_activities').insert({
        org_id, client_id, type: 'task',
        subject: String(args.subject), due_at: String(args.due_at),
        status: 'planned',
        lead_id: (args.lead_id as string) ?? null,
        contact_id: (args.contact_id as string) ?? null,
        account_id: (args.account_id as string) ?? null,
        deal_id: (args.deal_id as string) ?? null,
      }).select('*').single();
      return { card: { type: 'summary', data: { text: `Task created: ${args.subject} due ${args.due_at}` } }, data };
    },
  },
  {
    name: 'crm_log_activity',
    description: 'Log a completed call/meeting/note against a related entity.',
    input_schema: { type: 'object', required: ['type'], properties: {
      type: { type: 'string', enum: ['call','meeting','note','sms'] },
      subject: { type: 'string' }, body: { type: 'string' },
      lead_id: { type: 'string' }, contact_id: { type: 'string' },
      account_id: { type: 'string' }, deal_id: { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      const { data } = await supabaseAdmin.from('crm_activities').insert({
        org_id, client_id, type: String(args.type) as 'call'|'meeting'|'note'|'sms',
        subject: (args.subject as string) ?? null, body: (args.body as string) ?? null,
        status: 'completed', completed_at: new Date().toISOString(),
        lead_id: (args.lead_id as string) ?? null, contact_id: (args.contact_id as string) ?? null,
        account_id: (args.account_id as string) ?? null, deal_id: (args.deal_id as string) ?? null,
      }).select('*').single();
      return { data };
    },
  },
  // ── Agentic write tools ────────────────────────────────────────────────
  {
    name: 'crm_create_lead',
    description: 'Create a new CRM lead. Use when the user describes a new prospect ("add John from ACME, john@acme.com"). Returns the created lead with id and initial score.',
    input_schema: { type: 'object', required: ['first_name'], properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      company: { type: 'string' },
      title: { type: 'string' },
      industry: { type: 'string' },
      source_id: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string' },
      is_b2c: { type: 'boolean', description: 'Set true for individual consumer leads, false for business leads.' },
      notes: { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      const lead = await leadsSvc.createLead({
        org_id,
        payload: {
          client_id,
          first_name: (args.first_name as string) ?? null,
          last_name: (args.last_name as string) ?? null,
          email: (args.email as string) ?? null,
          phone: (args.phone as string) ?? null,
          company: (args.company as string) ?? null,
          title: (args.title as string) ?? null,
          industry: (args.industry as string) ?? null,
          source_id: (args.source_id as string) ?? null,
          city: (args.city as string) ?? null,
          country: (args.country as string) ?? null,
          is_b2c: (args.is_b2c as boolean) ?? false,
          notes: (args.notes as string) ?? null,
          status: 'new',
        },
      });
      return { card: { type: 'lead_created', data: lead }, data: lead };
    },
  },
  {
    name: 'crm_update_lead',
    description: 'Update fields on an existing lead by id. Use for status changes, owner reassignment, contact info corrections.',
    input_schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['new','working','nurturing','qualified','unqualified','converted','lost'] },
      owner_id: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      company: { type: 'string' },
      notes: { type: 'string' },
      lost_reason: { type: 'string', description: 'Reason text shown alongside an unqualified/lost transition.' },
    }},
    exec: async (org_id, client_id, args) => {
      const { id, ...rest } = args as Record<string, unknown>;
      // Client-scope re-check. When the actor is client-scoped, a
      // prompt-injected note ("convert all leads") could otherwise
      // steer Claude into mutating leads from a sibling client in the
      // same org. updateLead only enforces org_id; we enforce client
      // here.
      await assertLeadInClientScope(org_id, client_id, String(id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = await leadsSvc.updateLead(org_id, String(id), rest as any);
      return { card: { type: 'lead_updated', data: lead }, data: lead };
    },
  },
  {
    name: 'crm_convert_lead',
    description: 'Convert a qualified lead into a contact (and optionally an account + opportunity deal). Returns the resulting records.',
    input_schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', description: 'Lead id to convert.' },
      create_deal: { type: 'boolean', description: 'If true, also create a deal in the default pipeline.' },
      deal_name: { type: 'string' },
      deal_amount: { type: 'number' },
    }},
    exec: async (org_id, client_id, args) => {
      // Same client-scope guard as crm_update_lead — conversion is a
      // destructive mutation, must respect the client boundary.
      await assertLeadInClientScope(org_id, client_id, String(args.id));
      // Lazy-load the conversion service so we don't introduce a circular dep
      // at module load. Conversion lives next to the lead service.
      const mod: typeof import('../leads.service') & {
        convertLead?: (org_id: string, id: string, opts: { create_deal?: boolean; deal_name?: string; deal_amount?: number }) => Promise<unknown>;
      } = await import('../leads.service');
      let result: unknown;
      if (typeof mod.convertLead === 'function') {
        result = await mod.convertLead(org_id, String(args.id), {
          create_deal: (args.create_deal as boolean) ?? false,
          deal_name: (args.deal_name as string) ?? undefined,
          deal_amount: (args.deal_amount as number) ?? undefined,
        });
      } else {
        // Fallback: flip status + is_converted so downstream funnel reports
        // see the conversion even if the service helper hasn't been wired
        // yet. is_converted is the canonical lifecycle flag — leaving it
        // false here was the original bug.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await leadsSvc.updateLead(org_id, String(args.id), { status: 'converted', is_converted: true } as any);
        let deal: unknown = null;
        if ((args.create_deal as boolean) && args.deal_name) {
          const inserted = await supabaseAdmin.from('crm_deals').insert({
            org_id, name: String(args.deal_name),
            amount: (args.deal_amount as number) ?? null,
            status: 'open',
          }).select('*').single();
          deal = inserted.data;
        }
        result = { converted_lead_id: args.id, deal };
      }
      return { card: { type: 'lead_converted', data: result }, data: result };
    },
  },
  {
    name: 'crm_create_deal',
    description:
      'Create a new deal/opportunity in the default pipeline. Use when the user says "add deal", "create opportunity", etc. Account and contact are optional — look them up first if the user names them, but a deal can be saved without either.',
    input_schema: { type: 'object', required: ['name'], properties: {
      name:                { type: 'string', description: 'Short deal title shown on the kanban card.' },
      account_id:          { type: 'string' },
      primary_contact_id:  { type: 'string' },
      lead_id:             { type: 'string' },
      amount:              { type: 'number', description: 'Deal value in INR. Defaults to 0 if not given.' },
      currency:            { type: 'string', description: 'ISO currency code, defaults to INR.' },
      expected_close_date: { type: 'string', description: 'YYYY-MM-DD' },
      stage_slug:          { type: 'string', description: 'Stage name from the pipeline — e.g. "qualification", "proposal". Defaults to the first open stage.' },
      next_step:           { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      // Resolve pipeline + opening stage for the org. If the agent passed
      // a stage_slug we try to honour it; otherwise we drop into the first
      // open stage by position.
      const { data: pipeline } = await supabaseAdmin.from('crm_pipelines').select('id')
        .eq('org_id', org_id).eq('is_default', true).limit(1).maybeSingle();
      if (!pipeline) {
        return { data: { error: 'No default pipeline configured for this org. Create one in Settings → Pipelines first.' } };
      }
      const stagesQ = supabaseAdmin.from('crm_deal_stages').select('id, name, stage_type, position')
        .eq('org_id', org_id).eq('pipeline_id', pipeline.id).order('position');
      const { data: stages } = await stagesQ;
      const openStages = (stages ?? []).filter(s => s.stage_type === 'open');
      const requestedSlug = args.stage_slug ? String(args.stage_slug).toLowerCase() : null;
      const stage = (requestedSlug ? openStages.find(s => s.name.toLowerCase().includes(requestedSlug)) : null)
        ?? openStages[0]
        ?? (stages ?? [])[0];
      if (!stage) {
        return { data: { error: 'No deal stages configured. Create stages in Settings → Pipelines first.' } };
      }

      const insertRow = {
        org_id, client_id,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        name: String(args.name ?? '').trim() || 'Untitled deal',
        account_id:         (args.account_id as string)         ?? null,
        primary_contact_id: (args.primary_contact_id as string) ?? null,
        lead_id:            (args.lead_id as string)            ?? null,
        amount:             Number(args.amount ?? 0),
        currency:           String(args.currency ?? 'INR').toUpperCase(),
        expected_close_date: (args.expected_close_date as string) ?? null,
        next_step:          (args.next_step as string) ?? null,
        status: 'open',
      };
      const { data: deal, error } = await supabaseAdmin.from('crm_deals').insert(insertRow).select('*').single();
      if (error) return { data: { error: error.message } };
      return { card: { type: 'deal_created', data: deal }, data: deal };
    },
  },
  {
    name: 'crm_create_contact',
    description:
      'Create a new contact (a person — usually attached to a B2B account). Use when the user gives a name + phone/email and says "save", "add contact", or names someone new during a conversation. account_id is optional; pass it if the contact belongs to a known account.',
    input_schema: { type: 'object', properties: {
      first_name:  { type: 'string' },
      last_name:   { type: 'string' },
      email:       { type: 'string' },
      phone:       { type: 'string' },
      mobile:      { type: 'string' },
      title:       { type: 'string', description: 'Job title / designation.' },
      department:  { type: 'string' },
      account_id:  { type: 'string' },
      city:        { type: 'string' },
      state:       { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      const payload = {
        org_id, client_id,
        first_name: (args.first_name as string) || null,
        last_name:  (args.last_name  as string) || null,
        email:      (args.email      as string) || null,
        phone:      (args.phone      as string) || null,
        mobile:     (args.mobile     as string) || null,
        title:      (args.title      as string) || null,
        department: (args.department as string) || null,
        account_id: (args.account_id as string) || null,
        city:       (args.city       as string) || null,
        state:      (args.state      as string) || null,
      };
      if (!payload.first_name && !payload.last_name && !payload.email && !payload.phone) {
        return { data: { error: 'At least one of first_name, last_name, email, or phone is required.' } };
      }
      const { data, error } = await supabaseAdmin.from('crm_contacts').insert(payload).select('*').single();
      if (error) return { data: { error: error.message } };
      return { card: { type: 'contact_created', data }, data };
    },
  },
  {
    name: 'crm_create_account',
    description:
      'Create a new account (a company in B2B mode). Use when the user names a company that doesn\'t exist yet — e.g. "add account Acme Steel". Most fields are optional but at minimum a name is required.',
    input_schema: { type: 'object', required: ['name'], properties: {
      name:           { type: 'string' },
      domain:         { type: 'string', description: 'e.g. acmesteel.com' },
      industry:       { type: 'string' },
      annual_revenue: { type: 'number' },
      phone:          { type: 'string' },
      website:        { type: 'string' },
      territory_id:   { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      const name = String(args.name ?? '').trim();
      if (!name) return { data: { error: 'name is required' } };
      const payload = {
        org_id, client_id, name,
        domain:         (args.domain   as string) || null,
        industry:       (args.industry as string) || null,
        annual_revenue: typeof args.annual_revenue === 'number' ? args.annual_revenue : null,
        phone:          (args.phone    as string) || null,
        website:        (args.website  as string) || null,
        territory_id:   (args.territory_id as string) || null,
      };
      const { data, error } = await supabaseAdmin.from('crm_accounts').insert(payload).select('*').single();
      if (error) {
        // Most likely a duplicate-domain unique-index hit. Try to surface the
        // existing record so the agent can link to it instead of giving up.
        if (error.code === '23505' && payload.domain) {
          const { data: existing } = await supabaseAdmin.from('crm_accounts').select('*')
            .eq('org_id', org_id).eq('domain', payload.domain).is('deleted_at', null).maybeSingle();
          if (existing) return { card: { type: 'account_existing', data: existing }, data: existing };
        }
        return { data: { error: error.message } };
      }
      return { card: { type: 'account_created', data }, data };
    },
  },
];

/** Returns the Anthropic tool-use schema array. */
export function toAnthropicTools() {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

/** Find and execute a tool by name. */
export async function executeTool(org_id: string, client_id: string | null, name: string, args: Record<string, unknown>): Promise<KiniToolResult | null> {
  const tool = tools.find(t => t.name === name);
  if (!tool) return null;
  const result = await tool.exec(org_id, client_id, args);
  if (typeof result === 'object' && result !== null && 'card' in result) {
    const r = result as unknown as { data: unknown; card?: { type: string; data: unknown } };
    return { tool: name, data: r.data, card: r.card };
  }
  return { tool: name, data: result };
}

/**
 * KINI CRM tool registry. Wires CRM data into the existing chatbot
 * via Anthropic tool use (with structured-prompt fallback).
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { sanitisePostgrestSearch } from '../../../utils';
import * as autoResponse from './autoResponse.service';
import * as summarize from './summarize.service';
import * as leadsSvc from '../leads.service';
import * as dealsSvc from '../deals.service';
import * as leaderboardSvc from '../leaderboard.service';
import * as kiniMemory from './kiniMemory.service';
import { sendWhatsapp } from '../whatsapp.service';

/**
 * Per-call context threaded from the chat controller into a tool's exec.
 * Optional so every existing tool (which never reads it) keeps its exact
 * signature; only tools that act on behalf of the current USER — e.g.
 * remember_fact writing per-user memory — read it.
 */
export interface KiniToolContext {
  user_id?: string | null;
}

export interface KiniTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  exec: (org_id: string, client_id: string | null, args: Record<string, unknown>, ctx?: KiniToolContext) => Promise<unknown>;
}

// Shared UUID guard. Mirrors the UUID_RE the v2 controller uses before it
// trusts a client-supplied id — cheap way to turn a malformed id into a
// clean tool error instead of a Postgres "invalid input syntax for type
// uuid" that surfaces as an opaque failure.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

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

// Same hard guard as assertLeadInClientScope, generalised to the other
// mutable CRM entities. Reads the target row's client_id and refuses the
// mutation when it belongs to a *different* client than the client-scoped
// actor. A null client_id on the row (legacy / org-wide) is allowed, and an
// actor with no client pinned (org-wide / super admin) skips the check —
// the underlying service/query still enforces org_id.
async function assertRowInClientScope(
  table: 'crm_deals' | 'crm_contacts' | 'crm_accounts',
  label: string,
  org_id: string,
  client_id: string | null,
  id: string,
): Promise<void> {
  if (!client_id) return;
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('client_id')
    .eq('id', id)
    .eq('org_id', org_id)
    .maybeSingle();
  if (error || !data) throw new Error(`${label} not found`);
  if (data.client_id && data.client_id !== client_id) {
    throw new Error(`${label} belongs to a different client; cannot mutate from this scope`);
  }
}

const assertDealInClientScope = (org_id: string, client_id: string | null, deal_id: string) =>
  assertRowInClientScope('crm_deals', 'Deal', org_id, client_id, deal_id);
const assertContactInClientScope = (org_id: string, client_id: string | null, contact_id: string) =>
  assertRowInClientScope('crm_contacts', 'Contact', org_id, client_id, contact_id);
const assertAccountInClientScope = (org_id: string, client_id: string | null, account_id: string) =>
  assertRowInClientScope('crm_accounts', 'Account', org_id, client_id, account_id);

export const tools: KiniTool[] = [
  {
    name: 'crm_search_leads',
    description: 'Search CRM leads. Filter by status, minimum score, text query, or creation-date range. For "today\'s leads" / "leads added this week" style questions, pass created_from (and optionally created_to) computed from the current IST date — results then include every matching lead with its created_at, so you can list them rather than guessing.',
    input_schema: { type: 'object', properties: {
      status: { type: 'string' },
      score_gte: { type: 'number' },
      q: { type: 'string' },
      created_from: { type: 'string', description: 'ISO date/datetime lower bound on created_at (inclusive), e.g. 2026-08-06 for the start of today IST' },
      created_to: { type: 'string', description: 'ISO date/datetime upper bound on created_at (inclusive)' },
      limit: { type: 'number', default: 10 },
    }},
    exec: async (org_id, client_id, args) => {
      let q = supabaseAdmin.from('crm_leads').select('id, first_name, last_name, email, company, title, status, score, owner_id, created_at')
        .eq('org_id', org_id).is('deleted_at', null);
      q = scopeToClient(q, client_id);
      if (args.status) q = q.eq('status', String(args.status));
      if (args.score_gte) q = q.gte('score', Number(args.score_gte));
      // Creation-date range — accept only well-formed ISO values so hostile /
      // malformed tool input can't 500 the query. A bare date upper bound is
      // widened to end-of-day so created_to=2026-08-06 includes that whole day.
      const isoDate = (v: unknown): string | null => {
        if (typeof v !== 'string') return null;
        const s = v.trim();
        if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s) || Number.isNaN(Date.parse(s))) return null;
        return s;
      };
      const from = isoDate(args.created_from);
      const to = isoDate(args.created_to);
      const dateFiltered = !!(from || to);
      if (from) q = q.gte('created_at', from);
      if (to) q = q.lte('created_at', /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999` : to);
      if (args.q) {
        // Sanitise — see utils/postgrest.ts for the threat model. The model
        // can also produce hostile filter syntax via tool-use input, not
        // just direct user input.
        const s = sanitisePostgrestSearch(args.q);
        if (s) {
          // Match the whole phrase against each searchable column AND each word
          // against the name columns. Names are stored SPLIT (first_name +
          // last_name), so a full-name query like "Amit Batra" matches no single
          // column as one term — without the per-word terms the search silently
          // returned zero results and KINI wrongly reported the lead "not found".
          const terms = [
            `first_name.ilike.%${s}%`,
            `last_name.ilike.%${s}%`,
            `company.ilike.%${s}%`,
            `email.ilike.%${s}%`,
          ];
          for (const w of s.split(/\s+/).filter((word) => word.length >= 2)) {
            terms.push(`first_name.ilike.%${w}%`, `last_name.ilike.%${w}%`);
          }
          q = q.or(Array.from(new Set(terms)).join(','));
        }
      }
      // Date-filtered queries read as a chronology ("today's leads"), so sort
      // newest-first; score stays the default ranking otherwise.
      const { data } = await (dateFiltered
        ? q.order('created_at', { ascending: false })
        : q.order('score', { ascending: false })
      ).limit(Math.min(Number(args.limit ?? 10), 50));
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
      const text = await summarize.summarizeAccount(org_id, client_id, String(args.account_id));
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
        client_id,
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
    name: 'crm_send_whatsapp',
    description: 'ACTUALLY SEND a WhatsApp message to a lead or contact (or an explicit phone number) — not a draft. Identify the recipient by lead_id, contact_id, or a phone in "to", and provide the message text in "body". The message is logged to the CRM WhatsApp thread. Only call this when the user explicitly asks to SEND; otherwise draft the text in your reply and ask them to confirm.',
    input_schema: { type: 'object', required: ['body'], properties: {
      lead_id: { type: 'string' },
      contact_id: { type: 'string' },
      to: { type: 'string', description: 'Explicit phone number (E.164, e.g. +9198…) — use only when no lead_id/contact_id is available.' },
      body: { type: 'string', description: 'The message text to send.' },
    }},
    exec: async (org_id, client_id, args) => {
      const body = String(args.body ?? '').trim();
      if (!body) return { data: { error: 'A message body is required to send a WhatsApp.' } };

      let to = typeof args.to === 'string' ? args.to.trim() : '';
      const leadId = (args.lead_id as string) ?? null;
      const contactId = (args.contact_id as string) ?? null;

      // Resolve the recipient phone + consent from the lead/contact when no
      // explicit number was given. Hard client-scope guard so KINI can never
      // message a record outside the caller's client.
      const resolve = async (table: 'crm_leads' | 'crm_contacts', id: string) => {
        const { data } = await supabaseAdmin.from(table)
          .select('mobile, phone, whatsapp_consent, client_id')
          .eq('id', id).eq('org_id', org_id).maybeSingle();
        return data as { mobile?: string | null; phone?: string | null; whatsapp_consent?: boolean | null; client_id?: string | null } | null;
      };
      let consent: boolean | null | undefined;
      if (!to && (leadId || contactId)) {
        const table = leadId ? 'crm_leads' : 'crm_contacts';
        const r = await resolve(table, (leadId || contactId) as string);
        if (!r) return { data: { error: `${leadId ? 'Lead' : 'Contact'} not found in this scope.` } };
        if (client_id && r.client_id && r.client_id !== client_id) {
          return { data: { error: 'That record belongs to a different client; cannot message from this scope.' } };
        }
        to = (r.mobile || r.phone || '').trim();
        consent = r.whatsapp_consent;
      }

      if (!to) return { data: { error: 'No phone number on file for that recipient — ask the user for a number, or add one to the record first.' } };
      // Respect opt-out. null/undefined = consent not tracked → allowed.
      if (consent === false) {
        return { data: { error: 'This recipient has not opted in to WhatsApp (whatsapp_consent is off). Do not send — ask the user to obtain consent first.' } };
      }

      const { id } = await sendWhatsapp({ org_id, to, body_text: body, lead_id: leadId, contact_id: contactId });
      return { data: { sent: true, to, log_id: id, message: `WhatsApp sent to ${to}.` } };
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
            org_id, client_id, name: String(args.deal_name),
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
  // ── Update tools (client-scope re-guarded, mirror crm_update_lead) ───────
  {
    name: 'crm_update_deal',
    description:
      'Update fields on an existing deal by id — any of stage_id, amount, status (open/won/lost), close_date, owner_id, name. To move a deal by stage NAME, use crm_move_deal_stage instead.',
    input_schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' },
      stage_id: { type: 'string' },
      amount: { type: 'number', description: 'Deal value in INR.' },
      status: { type: 'string', enum: ['open', 'won', 'lost'] },
      close_date: { type: 'string', description: 'Expected close date, YYYY-MM-DD.' },
      owner_id: { type: 'string' },
      name: { type: 'string' },
    }},
    exec: async (org_id, client_id, args, ctx) => {
      const id = String(args.id ?? '');
      if (!isUuid(id)) return { data: { error: 'A valid deal id is required.' } };
      if (args.stage_id !== undefined && !isUuid(String(args.stage_id))) return { data: { error: 'stage_id must be a valid id.' } };
      if (args.owner_id !== undefined && args.owner_id !== null && !isUuid(String(args.owner_id))) return { data: { error: 'owner_id must be a valid id.' } };
      // Client-scope re-check before mutating — identical guard to
      // crm_update_lead. dealsSvc.updateDeal only enforces org_id; a
      // prompt-injected instruction must not steer KINI into editing a
      // sibling client's deal.
      await assertDealInClientScope(org_id, client_id, id);
      const patch: Record<string, unknown> = {};
      if (args.stage_id !== undefined) patch.stage_id = String(args.stage_id);
      if (args.amount !== undefined) patch.amount = Number(args.amount);
      if (args.status !== undefined) patch.status = String(args.status);
      // close_date maps to the deal's expected_close_date column.
      if (args.close_date !== undefined) patch.expected_close_date = String(args.close_date);
      if (args.owner_id !== undefined) patch.owner_id = args.owner_id ? String(args.owner_id) : null;
      if (args.name !== undefined) patch.name = String(args.name);
      if (Object.keys(patch).length === 0) {
        return { data: { error: 'No fields to update. Pass at least one of stage_id, amount, status, close_date, owner_id, name.' } };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deal = await dealsSvc.updateDeal(org_id, id, patch as any, ctx?.user_id ?? undefined);
      return { card: { type: 'deal_updated', data: deal }, data: deal };
    },
  },
  {
    name: 'crm_move_deal_stage',
    description:
      "Move a deal to a different pipeline stage. Pass deal_id plus either stage_id, or a stage_name that is resolved to a stage within the deal's own pipeline (e.g. \"Proposal\", \"Negotiation\").",
    input_schema: { type: 'object', required: ['deal_id'], properties: {
      deal_id: { type: 'string' },
      stage_id: { type: 'string' },
      stage_name: { type: 'string', description: "Stage name to resolve within the deal's pipeline." },
    }},
    exec: async (org_id, client_id, args, ctx) => {
      const deal_id = String(args.deal_id ?? '');
      if (!isUuid(deal_id)) return { data: { error: 'A valid deal_id is required.' } };
      await assertDealInClientScope(org_id, client_id, deal_id);
      let stage_id = isUuid(args.stage_id) ? args.stage_id : '';
      if (!stage_id) {
        const name = typeof args.stage_name === 'string' ? args.stage_name.trim() : '';
        if (!name) return { data: { error: 'Provide stage_id or stage_name.' } };
        // Resolve the stage by name within the deal's OWN pipeline so a
        // same-named stage in a different pipeline can't be selected.
        const { data: dealRow } = await supabaseAdmin.from('crm_deals').select('pipeline_id')
          .eq('org_id', org_id).eq('id', deal_id).maybeSingle();
        if (!dealRow?.pipeline_id) return { data: { error: 'Deal has no pipeline to resolve the stage against.' } };
        const { data: stages } = await supabaseAdmin.from('crm_deal_stages').select('id, name')
          .eq('org_id', org_id).eq('pipeline_id', dealRow.pipeline_id).order('position');
        const lower = name.toLowerCase();
        const match = (stages ?? []).find((s) => String(s.name).toLowerCase() === lower)
          ?? (stages ?? []).find((s) => String(s.name).toLowerCase().includes(lower));
        if (!match) return { data: { error: `No stage matching "${name}" in this deal's pipeline.` } };
        stage_id = match.id as string;
      }
      const deal = await dealsSvc.moveStage(org_id, deal_id, stage_id, ctx?.user_id ?? undefined);
      return { card: { type: 'deal_updated', data: deal }, data: deal };
    },
  },
  {
    name: 'crm_update_contact',
    description:
      'Update a contact by id — any of name (or first_name/last_name), email, phone, mobile, title, account_id.',
    input_schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' },
      name: { type: 'string', description: 'Full name — split into first/last when first_name/last_name are not given.' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      mobile: { type: 'string' },
      title: { type: 'string' },
      account_id: { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      const id = String(args.id ?? '');
      if (!isUuid(id)) return { data: { error: 'A valid contact id is required.' } };
      if (args.account_id !== undefined && args.account_id !== null && !isUuid(String(args.account_id))) {
        return { data: { error: 'account_id must be a valid id.' } };
      }
      await assertContactInClientScope(org_id, client_id, id);
      const patch: Record<string, unknown> = {};
      if (typeof args.first_name === 'string') patch.first_name = args.first_name;
      if (typeof args.last_name === 'string') patch.last_name = args.last_name;
      // Convenience: split a single `name` into first/last when neither part
      // was passed explicitly (contacts are stored split, like leads).
      if (patch.first_name === undefined && patch.last_name === undefined && typeof args.name === 'string' && args.name.trim()) {
        const parts = args.name.trim().split(/\s+/);
        patch.first_name = parts.shift() ?? null;
        patch.last_name = parts.length ? parts.join(' ') : null;
      }
      if (typeof args.email === 'string') patch.email = args.email;
      if (typeof args.phone === 'string') patch.phone = args.phone;
      if (typeof args.mobile === 'string') patch.mobile = args.mobile;
      if (typeof args.title === 'string') patch.title = args.title;
      if (args.account_id !== undefined) patch.account_id = args.account_id ? String(args.account_id) : null;
      if (Object.keys(patch).length === 0) return { data: { error: 'No fields to update.' } };
      patch.updated_at = new Date().toISOString();
      const { data, error } = await supabaseAdmin.from('crm_contacts').update(patch)
        .eq('org_id', org_id).eq('id', id).select('*').single();
      if (error) return { data: { error: error.message } };
      return { card: { type: 'contact_updated', data }, data };
    },
  },
  {
    name: 'crm_update_account',
    description:
      'Update an account (company) by id — any of name, industry, website, owner_id.',
    input_schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      industry: { type: 'string' },
      website: { type: 'string' },
      owner_id: { type: 'string' },
    }},
    exec: async (org_id, client_id, args) => {
      const id = String(args.id ?? '');
      if (!isUuid(id)) return { data: { error: 'A valid account id is required.' } };
      if (args.owner_id !== undefined && args.owner_id !== null && !isUuid(String(args.owner_id))) {
        return { data: { error: 'owner_id must be a valid id.' } };
      }
      await assertAccountInClientScope(org_id, client_id, id);
      const patch: Record<string, unknown> = {};
      if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
      if (typeof args.industry === 'string') patch.industry = args.industry;
      if (typeof args.website === 'string') patch.website = args.website;
      if (args.owner_id !== undefined) patch.owner_id = args.owner_id ? String(args.owner_id) : null;
      if (Object.keys(patch).length === 0) return { data: { error: 'No fields to update.' } };
      patch.updated_at = new Date().toISOString();
      const { data, error } = await supabaseAdmin.from('crm_accounts').update(patch)
        .eq('org_id', org_id).eq('id', id).select('*').single();
      if (error) return { data: { error: error.message } };
      return { card: { type: 'account_updated', data }, data };
    },
  },
  // ── Memory ───────────────────────────────────────────────────────────────
  {
    name: 'remember_fact',
    description:
      'Remember a durable fact about the CURRENT user for future conversations — a stable preference or working context (e.g. key "preferred_currency_format" value "lakhs", or key "territory" value "Pune"). Use for lasting facts the user asks you to remember, not transient chat detail. Both key and value are required.',
    input_schema: { type: 'object', required: ['key', 'value'], properties: {
      key: { type: 'string', description: 'Short, stable key, e.g. "territory".' },
      value: { type: 'string', description: 'The value to remember.' },
    }},
    exec: async (org_id, _client_id, args, ctx) => {
      const user_id = ctx?.user_id ?? null;
      if (!user_id) return { data: { error: 'Cannot identify the current user, so nothing was saved.' } };
      const key = String(args.key ?? '').trim();
      const value = String(args.value ?? '').trim();
      if (!key || !value) return { data: { error: 'Both key and value are required to remember something.' } };
      const entry = await kiniMemory.setMemory(user_id, org_id, key, value, { source: 'kini' });
      if (!entry) return { data: { error: 'Could not save that memory — try a shorter key/value.' } };
      return { card: { type: 'summary', data: { text: `Got it — I'll remember ${entry.key}: ${entry.value}.` } }, data: entry };
    },
  },
  // ── Analytics (read-only aggregates) ─────────────────────────────────────
  {
    name: 'crm_conversion_funnel',
    description:
      'Read-only conversion funnel over the last N days (default 30): lead counts by status, deal counts by open/won/lost, and derived lead-conversion + deal-win rates. Org + client scoped.',
    input_schema: { type: 'object', properties: {
      days: { type: 'number', default: 30, description: 'Look-back window on created_at, in days (default 30, max 365).' },
    }},
    exec: async (org_id, client_id, args) => {
      const days = Math.min(Math.max(Number(args.days ?? 30) || 30, 1), 365);
      const fromIso = new Date(Date.now() - days * 86400000).toISOString();

      // Leads by status — one windowed read tallied in JS. range(0, 99999)
      // lifts PostgREST's 1000-row cap, mirroring analytics.winRate.
      let lq = supabaseAdmin.from('crm_leads').select('status')
        .eq('org_id', org_id).is('deleted_at', null)
        .gte('created_at', fromIso).range(0, 99999);
      lq = scopeToClient(lq, client_id);
      const { data: leadRows } = await lq;
      const leadsByStatus: Record<string, number> = {};
      for (const r of (leadRows ?? []) as Array<{ status?: string | null }>) {
        const s = String(r.status ?? 'unknown');
        leadsByStatus[s] = (leadsByStatus[s] ?? 0) + 1;
      }
      const totalLeads = (leadRows ?? []).length;
      const convertedLeads = leadsByStatus['converted'] ?? 0;

      // Deals by open/won/lost — prefer the joined stage_type, fall back to
      // the deal.status column for legacy rows with no stage (mirrors
      // leaderboard.service).
      let dq = supabaseAdmin.from('crm_deals').select('status, crm_deal_stages(stage_type)')
        .eq('org_id', org_id).is('deleted_at', null)
        .gte('created_at', fromIso).range(0, 99999);
      dq = scopeToClient(dq, client_id);
      const { data: dealRows } = await dq;
      let dealsOpen = 0, dealsWon = 0, dealsLost = 0;
      for (const r of (dealRows ?? []) as Array<{ status?: string | null; crm_deal_stages?: { stage_type?: string | null } | null }>) {
        const st = r.crm_deal_stages?.stage_type ?? r.status ?? 'open';
        if (st === 'won') dealsWon += 1;
        else if (st === 'lost') dealsLost += 1;
        else dealsOpen += 1;
      }
      const totalDeals = dealsOpen + dealsWon + dealsLost;
      const closedDeals = dealsWon + dealsLost;
      const leadConversionRate = totalLeads > 0 ? convertedLeads / totalLeads : 0;
      const dealWinRate = closedDeals > 0 ? dealsWon / closedDeals : 0;

      const data = {
        window_days: days,
        leads: { total: totalLeads, by_status: leadsByStatus, converted: convertedLeads },
        deals: { total: totalDeals, open: dealsOpen, won: dealsWon, lost: dealsLost },
        rates: {
          lead_conversion_rate: Math.round(leadConversionRate * 1000) / 1000,
          deal_win_rate: Math.round(dealWinRate * 1000) / 1000,
        },
      };
      const text = `Last ${days} days — ${totalLeads} leads (${convertedLeads} converted, ${(leadConversionRate * 100).toFixed(1)}%); deals ${dealsWon} won / ${dealsLost} lost / ${dealsOpen} open (win rate ${(dealWinRate * 100).toFixed(1)}%).`;
      return { card: { type: 'summary', data: { text } }, data };
    },
  },
  {
    name: 'crm_rep_leaderboard',
    description:
      'Read-only sales leaderboard: top N owners ranked by deals WON (count + revenue) over a period — mtd / qtd / ytd, or a custom from/to. Org + client scoped.',
    input_schema: { type: 'object', properties: {
      limit: { type: 'number', default: 10, description: 'How many top reps to return (default 10, max 50).' },
      period: { type: 'string', enum: ['mtd', 'qtd', 'ytd', 'custom'], description: "Time window. Defaults to 'mtd'." },
      metric: { type: 'string', enum: ['count', 'revenue'], description: "Rank by won-deal count or won revenue. Defaults to 'count'." },
      from: { type: 'string', description: "YYYY-MM-DD lower bound — required when period='custom'." },
      to: { type: 'string', description: "YYYY-MM-DD upper bound — required when period='custom'." },
    }},
    exec: async (org_id, client_id, args) => {
      const period = (['mtd', 'qtd', 'ytd', 'custom'] as const).includes(args.period as never)
        ? (args.period as 'mtd' | 'qtd' | 'ytd' | 'custom')
        : 'mtd';
      const metric = args.metric === 'revenue' ? 'revenue' : 'count';
      if (period === 'custom' && !(typeof args.from === 'string' && typeof args.to === 'string')) {
        return { data: { error: "period='custom' requires both from and to (YYYY-MM-DD)." } };
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
      const result = await leaderboardSvc.leaderboard(
        org_id,
        { metric, period, from: args.from as string | undefined, to: args.to as string | undefined },
        // Hard client isolation to match scopeToClient used by every other
        // KINI tool: strict-eq when a client is in scope, org-wide otherwise.
        { client_id, strict: client_id != null },
      );
      const rows = result.rows.slice(0, limit);
      return { card: { type: 'leaderboard', data: { ...result, rows } }, data: { ...result, rows } };
    },
  },
];

/** Returns the Anthropic tool-use schema array. */
export function toAnthropicTools() {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

/** Find and execute a tool by name. */
export async function executeTool(org_id: string, client_id: string | null, name: string, args: Record<string, unknown>, ctx?: KiniToolContext): Promise<KiniToolResult | null> {
  const tool = tools.find(t => t.name === name);
  if (!tool) return null;
  try {
    const result = await tool.exec(org_id, client_id, args, ctx);
    if (typeof result === 'object' && result !== null && 'card' in result) {
      const r = result as unknown as { data: unknown; card?: { type: string; data: unknown } };
      return { tool: name, data: r.data, card: r.card };
    }
    return { tool: name, data: result };
  } catch (e) {
    // A single tool throwing (e.g. "Lead not found", a cross-client scope
    // guard, a failed downstream call) must NOT abort the whole KINI turn —
    // that propagates to the chat handler's catch and surfaces as the opaque
    // "I hit an error processing that." Instead, hand the error back to the
    // model as a normal tool result so it can recover: ask a clarifying
    // question, try another tool, or answer in plain text (e.g. still draft
    // the message the user asked for).
    const msg = (e as { message?: string })?.message || 'Tool execution failed';
    return { tool: name, data: { error: msg } };
  }
}

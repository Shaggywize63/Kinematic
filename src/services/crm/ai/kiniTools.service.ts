/**
 * KINI CRM tool registry. Wires CRM data into the existing chatbot
 * via Anthropic tool use (with structured-prompt fallback).
 */
import { supabaseAdmin } from '../../../lib/supabase';
import * as autoResponse from './autoResponse.service';
import * as summarize from './summarize.service';

export interface KiniTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  exec: (org_id: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface KiniToolResult {
  tool: string;
  data: unknown;
  card?: { type: string; data: unknown };
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
    exec: async (org_id, args) => {
      let q = supabaseAdmin.from('crm_leads').select('id, first_name, last_name, email, company, title, status, score, owner_id')
        .eq('org_id', org_id).is('deleted_at', null);
      if (args.status) q = q.eq('status', String(args.status));
      if (args.score_gte) q = q.gte('score', Number(args.score_gte));
      if (args.q) {
        const s = String(args.q);
        q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%`);
      }
      const { data } = await q.order('score', { ascending: false }).limit(Math.min(Number(args.limit ?? 10), 50));
      return { card: { type: 'lead_list', data: { leads: data ?? [] } }, data };
    },
  },
  {
    name: 'crm_top_leads_by_score',
    description: 'Top N leads ranked by score.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', default: 10 } } },
    exec: async (org_id, args) => {
      const { data } = await supabaseAdmin.from('crm_leads')
        .select('id, first_name, last_name, email, company, title, score, owner_id, status')
        .eq('org_id', org_id).is('deleted_at', null).neq('status', 'converted')
        .order('score', { ascending: false }).limit(Math.min(Number(args.limit ?? 10), 50));
      return { card: { type: 'lead_list', data: { leads: data ?? [], title: 'Hottest leads' } }, data };
    },
  },
  {
    name: 'crm_get_lead',
    description: 'Get a single lead by id.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    exec: async (org_id, args) => {
      const { data } = await supabaseAdmin.from('crm_leads').select('*')
        .eq('org_id', org_id).eq('id', String(args.id)).maybeSingle();
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
    exec: async (org_id, args) => {
      let q = supabaseAdmin.from('crm_deals')
        .select('id, name, amount, currency, stage_id, expected_close_date, win_probability_ai, owner_id, account_id, crm_deal_stages!inner(stage_type, name)')
        .eq('org_id', org_id).is('deleted_at', null);
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
    exec: async (org_id, args) => {
      const days = Number(args.days ?? 7);
      const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      const { data } = await supabaseAdmin.from('crm_deals')
        .select('id, name, amount, currency, expected_close_date, win_probability_ai, owner_id, account_id, crm_deal_stages!inner(stage_type, name)')
        .eq('org_id', org_id).is('deleted_at', null)
        .eq('crm_deal_stages.stage_type', 'open')
        .lte('expected_close_date', cutoff)
        .order('expected_close_date', { ascending: true }).limit(50);
      return { card: { type: 'deal_list', data: { deals: data ?? [], title: `Deals closing in next ${days} days` } }, data };
    },
  },
  {
    name: 'crm_get_deal',
    description: 'Get a single deal by id.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    exec: async (org_id, args) => {
      const { data } = await supabaseAdmin.from('crm_deals').select('*')
        .eq('org_id', org_id).eq('id', String(args.id)).maybeSingle();
      return { data };
    },
  },
  {
    name: 'crm_summarize_account',
    description: 'Generate an AI summary of a CRM account.',
    input_schema: { type: 'object', required: ['account_id'], properties: { account_id: { type: 'string' } } },
    exec: async (org_id, args) => {
      const text = await summarize.summarizeAccount(org_id, String(args.account_id));
      return { card: { type: 'summary', data: { text, account_id: args.account_id } }, data: { text } };
    },
  },
  {
    name: 'crm_pipeline_summary',
    description: 'Aggregate pipeline value, weighted value, and counts by stage.',
    input_schema: { type: 'object', properties: { pipeline_id: { type: 'string' } } },
    exec: async (org_id, args) => {
      let q = supabaseAdmin.from('crm_mv_pipeline_value').select('*').eq('org_id', org_id);
      if (args.pipeline_id) q = q.eq('pipeline_id', String(args.pipeline_id));
      const { data } = await q;
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
    exec: async (org_id, args) => {
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
    exec: async (org_id, args) => {
      const { data } = await supabaseAdmin.from('crm_activities').insert({
        org_id, type: 'task', subject: String(args.subject), due_at: String(args.due_at),
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
    exec: async (org_id, args) => {
      const { data } = await supabaseAdmin.from('crm_activities').insert({
        org_id, type: String(args.type) as 'call'|'meeting'|'note'|'sms',
        subject: (args.subject as string) ?? null, body: (args.body as string) ?? null,
        status: 'completed', completed_at: new Date().toISOString(),
        lead_id: (args.lead_id as string) ?? null, contact_id: (args.contact_id as string) ?? null,
        account_id: (args.account_id as string) ?? null, deal_id: (args.deal_id as string) ?? null,
      }).select('*').single();
      return { data };
    },
  },
];

/** Returns the Anthropic tool-use schema array. */
export function toAnthropicTools() {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

/** Find and execute a tool by name. */
export async function executeTool(org_id: string, name: string, args: Record<string, unknown>): Promise<KiniToolResult | null> {
  const tool = tools.find(t => t.name === name);
  if (!tool) return null;
  const result = await tool.exec(org_id, args);
  if (typeof result === 'object' && result !== null && 'card' in result) {
    const r = result as unknown as { data: unknown; card?: { type: string; data: unknown } };
    return { tool: name, data: r.data, card: r.card };
  }
  return { tool: name, data: result };
}
/**
 * Auto-response email drafter. Claude Sonnet. Always returns a draft;
 * never auto-sends.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';

export interface DraftReplyInput {
  org_id: string;
  user_id?: string;
  lead_id?: string | null;
  deal_id?: string | null;
  contact_id?: string | null;
  incoming_message?: string;
  intent: string;
  tone: 'friendly' | 'formal' | 'concise';
  template_hint?: string;
}

export interface DraftReplyOutput {
  subject: string;
  body_text: string;
  body_html: string;
  suggested_send_time: string;
  follow_up_recommendation: string;
}

const SYSTEM_PROMPT = `You are an experienced SDR/AE drafting outbound and reply emails.
Match the requested tone. Be concrete, reference the prospect's role and company. Use ONE clear CTA.
Output JSON ONLY:
{"subject": str, "body_text": str, "body_html": str,
 "suggested_send_time": ISO8601, "follow_up_recommendation": str}.
Never include placeholders like [NAME] — use real values. If info is missing, omit gracefully.`;

export async function draftReply(input: DraftReplyInput): Promise<DraftReplyOutput> {
  const { org_id } = input;
  const ctx: Record<string, unknown> = { intent: input.intent, tone: input.tone };

  if (input.lead_id) {
    const { data } = await supabaseAdmin.from('crm_leads').select('*')
      .eq('org_id', org_id).eq('id', input.lead_id).maybeSingle();
    if (data) ctx.lead = data;
  }
  if (input.contact_id) {
    const { data } = await supabaseAdmin.from('crm_contacts').select('*')
      .eq('org_id', org_id).eq('id', input.contact_id).maybeSingle();
    if (data) ctx.contact = data;
  }
  if (input.deal_id) {
    const { data } = await supabaseAdmin.from('crm_deals').select('*')
      .eq('org_id', org_id).eq('id', input.deal_id).maybeSingle();
    if (data) {
      ctx.deal = data;
      if (data.account_id) {
        const { data: a } = await supabaseAdmin.from('crm_accounts').select('*')
          .eq('id', data.account_id).maybeSingle();
        ctx.account = a;
      }
    }
  }
  if (input.incoming_message) ctx.incoming_message = input.incoming_message;
  if (input.template_hint) ctx.template_hint = input.template_hint;

  const refTable = input.deal_id ? 'crm_activities' : null;
  if (refTable) {
    const { data: recent } = await supabaseAdmin.from('crm_activities')
      .select('type, subject, body, completed_at')
      .eq('org_id', org_id).eq('deal_id', input.deal_id!)
      .order('completed_at', { ascending: false }).limit(5);
    ctx.recent_activities = recent ?? [];
  }

  const response = await aiComplete({
    org_id,
    model: process.env.CRM_AUTO_RESPONSE_MODEL || 'claude-3-5-sonnet-20241022',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(ctx) }],
    max_tokens: 1200,
  });

  const json = JSON.parse(extractJson(response));
  return {
    subject: String(json.subject ?? '').slice(0, 300),
    body_text: String(json.body_text ?? ''),
    body_html: String(json.body_html ?? `<p>${escapeHtml(json.body_text ?? '')}</p>`),
    suggested_send_time: String(json.suggested_send_time ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()),
    follow_up_recommendation: String(json.follow_up_recommendation ?? 'Follow up in 3 business days if no reply.'),
  };
}

function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' } as Record<string, string>)[c]);
}

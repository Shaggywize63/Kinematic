/**
 * WhatsApp send + listLogs + inbound webhook handlers. Mirrors emails.service
 * patterns; uses crm_whatsapp_logs for both directions.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { stubWhatsappProvider } from './providers/stubWhatsapp.provider';
import type { WhatsappProvider } from './providers/whatsappProvider.interface';

const provider: WhatsappProvider = stubWhatsappProvider;

export interface SendWhatsappInput {
  org_id: string;
  user_id?: string;
  to: string;
  body_text?: string;
  template_id?: string | null;
  template_variables?: Record<string, string>;
  media_url?: string;
  media_type?: 'image' | 'document' | 'audio' | 'video' | 'sticker';
  lead_id?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
}

export async function sendWhatsapp(input: SendWhatsappInput) {
  let templateName: string | undefined;
  let templateLang: string | undefined;
  let renderedBody: string | undefined = input.body_text;
  if (input.template_id) {
    const { data: tpl } = await supabaseAdmin.from('crm_whatsapp_templates').select('*')
      .eq('org_id', input.org_id).eq('id', input.template_id).maybeSingle();
    if (tpl) {
      templateName = tpl.meta_template_name;
      templateLang = tpl.language;
      renderedBody = renderBody(tpl.body_text, input.template_variables ?? {});
    }
  }
  const fromPhone = process.env.CRM_WHATSAPP_FROM_PHONE || '+0000000000';

  const { data: log, error } = await supabaseAdmin.from('crm_whatsapp_logs').insert({
    org_id: input.org_id,
    direction: 'outbound',
    template_id: input.template_id ?? null,
    from_phone: fromPhone,
    to_phone: input.to,
    body_text: renderedBody ?? null,
    media_url: input.media_url ?? null,
    media_type: input.media_type ?? null,
    template_variables: input.template_variables ?? null,
    status: 'queued',
    provider: provider.name,
    lead_id: input.lead_id ?? null,
    contact_id: input.contact_id ?? null,
    deal_id: input.deal_id ?? null,
    sent_by: input.user_id ?? null,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // Immediate provider call so dashboards see "sent" without a wait.
  try {
    const result = await provider.send({
      to: input.to,
      body_text: renderedBody,
      template_name: templateName,
      template_language: templateLang,
      template_variables: input.template_variables,
      media_url: input.media_url,
      media_type: input.media_type,
    });
    await supabaseAdmin.from('crm_whatsapp_logs').update({
      status: 'sent',
      provider_message_id: result.message_id ?? null,
      sent_at: new Date().toISOString(),
    }).eq('id', log.id);
  } catch (err) {
    await supabaseAdmin.from('crm_whatsapp_logs').update({
      status: 'failed',
      error: (err as Error).message,
    }).eq('id', log.id);
  }
  return { id: log.id };
}

export async function listLogs(org_id: string, filters: Record<string, unknown> = {}) {
  let q = supabaseAdmin.from('crm_whatsapp_logs').select('*').eq('org_id', org_id);
  if (filters.lead_id) q = q.eq('lead_id', String(filters.lead_id));
  if (filters.contact_id) q = q.eq('contact_id', String(filters.contact_id));
  if (filters.deal_id) q = q.eq('deal_id', String(filters.deal_id));
  if (filters.direction) q = q.eq('direction', String(filters.direction));
  if (filters.status) q = q.eq('status', String(filters.status));
  if (filters.from) q = q.gte('created_at', String(filters.from));
  if (filters.to) q = q.lte('created_at', String(filters.to));
  const limit = Math.min(Number(filters.limit ?? 50), 200);
  const page = Math.max(Number(filters.page ?? 1), 1);
  q = q.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  const { data } = await q;
  return data ?? [];
}

// Webhook entry: inbound message from customer.
export async function recordInbound(payload: {
  org_id: string;
  from_phone: string;
  to_phone?: string;
  body_text?: string;
  media_url?: string;
  media_type?: string;
  provider_message_id?: string;
  in_reply_to?: string;
}) {
  const { data: contact } = await supabaseAdmin.from('crm_contacts').select('id, account_id')
    .eq('org_id', payload.org_id).eq('phone', payload.from_phone).is('deleted_at', null).maybeSingle();

  const status = payload.in_reply_to ? 'replied' : 'received';
  await supabaseAdmin.from('crm_whatsapp_logs').insert({
    org_id: payload.org_id,
    direction: 'inbound',
    from_phone: payload.from_phone,
    to_phone: payload.to_phone ?? null,
    body_text: payload.body_text ?? null,
    media_url: payload.media_url ?? null,
    media_type: payload.media_type ?? null,
    status,
    provider: provider.name,
    provider_message_id: payload.provider_message_id ?? null,
    contact_id: contact?.id ?? null,
    replied_at: payload.in_reply_to ? new Date().toISOString() : null,
  });

  // Mark the original outbound as replied (best-effort).
  if (payload.in_reply_to) {
    await supabaseAdmin.from('crm_whatsapp_logs').update({
      status: 'replied', replied_at: new Date().toISOString(),
    }).eq('org_id', payload.org_id).eq('provider_message_id', payload.in_reply_to);
  }
}

// Webhook entry: status update (delivered/read/failed) for a message we sent.
export async function recordStatusUpdate(payload: {
  org_id: string;
  provider_message_id: string;
  status: 'delivered' | 'read' | 'failed';
  error?: string;
}) {
  const update: Record<string, unknown> = { status: payload.status };
  if (payload.status === 'delivered') update.delivered_at = new Date().toISOString();
  if (payload.status === 'read') update.read_at = new Date().toISOString();
  if (payload.status === 'failed') update.error = payload.error ?? null;
  await supabaseAdmin.from('crm_whatsapp_logs').update(update)
    .eq('org_id', payload.org_id).eq('provider_message_id', payload.provider_message_id);
}

function renderBody(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => vars[String(n)] ?? `{{${n}}}`);
}

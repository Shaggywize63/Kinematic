/**
 * WhatsApp send + listLogs + inbound webhook handlers. Mirrors emails.service
 * patterns; uses crm_whatsapp_logs for both directions.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { resolveWhatsappProvider, fromPhoneFor } from './whatsappConnection.service';
import { applyRecipientStatus, handleInbound } from './broadcast.service';

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
  const provider = await resolveWhatsappProvider(input.org_id);
  const fromPhone = (await fromPhoneFor(input.org_id)) || process.env.CRM_WHATSAPP_FROM_PHONE || '+0000000000';

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

  // Immediate provider call so dashboards see "sent" without a wait. We return
  // the provider_message_id + final status so callers (e.g. broadcast recipient
  // tracking) can correlate later delivery/read webhooks to this message.
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
    return { id: log.id as string, provider_message_id: result.message_id ?? null, status: 'sent' as const, error: null, retryable: false, rate_limited: false, retry_after_sec: undefined as number | undefined };
  } catch (err) {
    const e = err as { message?: string; httpStatus?: number; providerCode?: number; retryAfterSec?: number };
    const message = e?.message ?? 'send error';
    // Classify for the broadcast retry loop: a 429 (or Meta rate/spam codes) is
    // rate-limited; a 429/5xx/network error is transient (worth retrying); any
    // other 4xx (bad number, invalid template, opted-out at Meta) is permanent.
    const rate_limited = e?.httpStatus === 429 || e?.providerCode === 130429 || e?.providerCode === 131048;
    const retryable = rate_limited || e?.httpStatus === undefined || (typeof e?.httpStatus === 'number' && e.httpStatus >= 500);
    await supabaseAdmin.from('crm_whatsapp_logs').update({
      status: 'failed',
      error: message,
    }).eq('id', log.id);
    return { id: log.id as string, provider_message_id: null, status: 'failed' as const, error: message, retryable, rate_limited, retry_after_sec: e?.retryAfterSec };
  }
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
  button_payload?: string;
  media_url?: string;
  media_type?: string;
  provider_message_id?: string;
  in_reply_to?: string;
}) {
  const { data: contact } = await supabaseAdmin.from('crm_contacts').select('id, account_id')
    .eq('org_id', payload.org_id).eq('phone', payload.from_phone).is('deleted_at', null).maybeSingle();

  const status = payload.in_reply_to ? 'replied' : 'received';
  const providerName = (await resolveWhatsappProvider(payload.org_id)).name;
  await supabaseAdmin.from('crm_whatsapp_logs').insert({
    org_id: payload.org_id,
    direction: 'inbound',
    from_phone: payload.from_phone,
    to_phone: payload.to_phone ?? null,
    body_text: payload.body_text ?? null,
    media_url: payload.media_url ?? null,
    media_type: payload.media_type ?? null,
    status,
    provider: providerName,
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

  // Broadcast hooks: STOP/opt-out → withdraw consent; otherwise attribute the
  // reply to the lead's most recent campaign (reply-rate). Best-effort.
  await handleInbound(payload.org_id, payload.from_phone, payload.body_text, payload.button_payload);
}

// Webhook entry: status update (delivered/read/failed) for a message we sent.
export async function recordStatusUpdate(payload: {
  org_id: string;
  provider_message_id: string;
  status: 'delivered' | 'read' | 'failed';
  error?: string;
  pricing?: { category?: string | null; billable?: boolean | null };
}) {
  const update: Record<string, unknown> = { status: payload.status };
  if (payload.status === 'delivered') update.delivered_at = new Date().toISOString();
  if (payload.status === 'read') update.read_at = new Date().toISOString();
  if (payload.status === 'failed') update.error = payload.error ?? null;
  await supabaseAdmin.from('crm_whatsapp_logs').update(update)
    .eq('org_id', payload.org_id).eq('provider_message_id', payload.provider_message_id);

  // Mirror the delivery status onto any broadcast recipient that carries this
  // provider_message_id, and roll up the broadcast's delivered/read/failed counts
  // (+ per-message billing category when Meta includes pricing on the webhook).
  await applyRecipientStatus(payload.org_id, payload.provider_message_id, payload.status, payload.error, payload.pricing);
}

function renderBody(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => vars[String(n)] ?? `{{${n}}}`);
}

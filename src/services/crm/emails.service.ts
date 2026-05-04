/**
 * Email send + tracking. Uses an EmailProvider interface; ships with a stub
 * implementation that only logs to crm_email_logs (no real send).
 */
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { stubProvider } from './providers/stub.provider';
import type { EmailProvider } from './providers/emailProvider.interface';

const provider: EmailProvider = stubProvider;

export interface SendEmailInput {
  org_id: string;
  user_id?: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  body_html: string;
  body_text?: string;
  template_id?: string | null;
  lead_id?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
}

export async function sendEmail(input: SendEmailInput) {
  const trackingToken = crypto.randomBytes(16).toString('hex');
  const trackedHtml = wrapTracking(input.body_html, trackingToken);
  const fromEmail = process.env.CRM_FROM_EMAIL || `noreply@${process.env.CRM_TRACKING_DOMAIN || 'kinematic.app'}`;

  const { data: log, error } = await supabaseAdmin.from('crm_email_logs').insert({
    org_id: input.org_id, template_id: input.template_id ?? null,
    from_email: fromEmail, to_email: input.to, cc: input.cc ?? null, bcc: input.bcc ?? null,
    subject: input.subject, body_html: trackedHtml,
    provider: provider.name, status: 'queued',
    lead_id: input.lead_id ?? null, contact_id: input.contact_id ?? null, deal_id: input.deal_id ?? null,
    sent_by: input.user_id ?? null, tracking_pixel_token: trackingToken,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // pg_cron edge function will pick up `queued` rows; here we also do
  // an immediate provider call so dashboards see "sent" without waiting a minute.
  try {
    const result = await provider.send({
      from: fromEmail, to: input.to, cc: input.cc, bcc: input.bcc,
      subject: input.subject, html: trackedHtml, text: input.body_text,
    });
    await supabaseAdmin.from('crm_email_logs').update({
      status: 'sent', provider_message_id: result.message_id ?? null, sent_at: new Date().toISOString(),
    }).eq('id', log.id);
  } catch (err) {
    await supabaseAdmin.from('crm_email_logs').update({
      status: 'failed', error: (err as Error).message,
    }).eq('id', log.id);
  }
  return { id: log.id, tracking_token: trackingToken };
}

export async function listLogs(org_id: string, filters: Record<string, unknown> = {}) {
  let q = supabaseAdmin.from('crm_email_logs').select('*').eq('org_id', org_id);
  if (filters.lead_id) q = q.eq('lead_id', String(filters.lead_id));
  if (filters.deal_id) q = q.eq('deal_id', String(filters.deal_id));
  if (filters.from) q = q.gte('created_at', String(filters.from));
  if (filters.to) q = q.lte('created_at', String(filters.to));
  const limit = Math.min(Number(filters.limit ?? 50), 200);
  const page = Math.max(Number(filters.page ?? 1), 1);
  q = q.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  const { data } = await q;
  return data ?? [];
}

export async function recordOpen(token: string) {
  const { data } = await supabaseAdmin.from('crm_email_logs').select('id, open_count')
    .eq('tracking_pixel_token', token).maybeSingle();
  if (!data) return;
  await supabaseAdmin.from('crm_email_logs').update({
    status: 'opened',
    opened_at: new Date().toISOString(),
    open_count: (data.open_count ?? 0) + 1,
  }).eq('id', data.id);
}

export async function recordClick(token: string) {
  const { data } = await supabaseAdmin.from('crm_email_logs').select('id, click_count, first_clicked_at')
    .eq('tracking_pixel_token', token).maybeSingle();
  if (!data) return;
  await supabaseAdmin.from('crm_email_logs').update({
    status: 'clicked',
    first_clicked_at: data.first_clicked_at ?? new Date().toISOString(),
    click_count: (data.click_count ?? 0) + 1,
  }).eq('id', data.id);
}

export async function renderTemplate(html: string, vars: Record<string, string | number>): Promise<string> {
  return html.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_, k) => String(vars[k] ?? ''));
}

function wrapTracking(html: string, token: string): string {
  const base = process.env.CRM_TRACKING_BASE_URL || '';
  if (!base) return html;
  // Append open pixel
  const pixel = `<img src="${base}/api/v1/crm/emails/track/open/${token}" width="1" height="1" style="display:none" alt="" />`;
  // Rewrite links
  const rewritten = html.replace(/href=("|')([^"']+)("|')/g, (m, q1, url, q2) =>
    `href=${q1}${base}/api/v1/crm/emails/track/click/${token}?u=${encodeURIComponent(url)}${q2}`);
  return rewritten + pixel;
}

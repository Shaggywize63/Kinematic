/**
 * Email send + tracking. Uses an EmailProvider interface; ships with a stub
 * implementation that only logs to crm_email_logs (no real send).
 */
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { stubProvider } from './providers/stub.provider';
import { resendProvider } from './providers/resend.provider';
import type { EmailProvider } from './providers/emailProvider.interface';

// Provider is picked once at module load via EMAIL_PROVIDER env. Falling
// back to the stub on unknown values keeps dev/test envs running without
// real credentials (stub still records every send into crm_email_logs).
const provider: EmailProvider = (() => {
  switch ((process.env.EMAIL_PROVIDER || '').toLowerCase()) {
    case 'resend': return resendProvider;
    default:       return stubProvider;
  }
})();

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
  /**
   * Skip the bounce + unsubscribe suppression check. Set this on
   * transactional flows where the recipient triggered the email
   * themselves (e.g. sender-address verification, password reset).
   * Default false — every regular send is subject to suppression.
   */
  bypass_suppression?: boolean;
  /**
   * Override the default `from` address. Used by transactional
   * flows (password reset, sender verification) that want to lock
   * the visible sender to a known noreply@ mailbox regardless of
   * what CRM_FROM_EMAIL is set to in the env. Falls back to the
   * env default when omitted.
   */
  from_email?: string;
}

export async function sendEmail(input: SendEmailInput) {
  const trackingToken = crypto.randomBytes(16).toString('hex');
  const trackedHtml = wrapTracking(input.body_html, trackingToken);
  const fromEmail = input.from_email
    || process.env.CRM_FROM_EMAIL
    || `noreply@${process.env.CRM_TRACKING_DOMAIN || 'kinematic.app'}`;
  // Plain-text fallback. We always send one. The template editor only
  // *warns* on save when it's empty (the UI doesn't block), so on the
  // server we derive from the HTML body if the caller didn't supply
  // text. Lots of corporate webmail clients (and most accessibility
  // tooling) downgrade to the text part for previews / quoting.
  const bodyText = (input.body_text && input.body_text.trim())
    ? input.body_text
    : htmlToPlainText(input.body_html);

  // ── 1. Suppression: refuse to send to addresses that have already
  //    bounced or unsubscribed for this org. Reasons:
  //      - hard bounce → repeat sends torch sender reputation; Gmail
  //        starts spam-folding the whole domain after a few of them.
  //      - unsubscribed → CAN-SPAM / GDPR; one click means one click.
  //    We still write a row so the rep sees *why* the send didn't go
  //    out (status='blocked'), and skip the provider call entirely.
  const suppressed = input.bypass_suppression
    ? null
    : await isSuppressed(input.org_id, input.to);
  if (suppressed) {
    const { data: blockedLog, error: blockedErr } = await supabaseAdmin.from('crm_email_logs').insert({
      org_id: input.org_id, template_id: input.template_id ?? null,
      from_email: fromEmail, to_email: input.to, cc: input.cc ?? null, bcc: input.bcc ?? null,
      subject: input.subject, body_html: trackedHtml,
      provider: provider.name,
      // Use the legacy enum value — the CHECK constraint hasn't been
      // widened on every tenant DB yet. 'failed' + an error message
      // is the safest no-DDL way to mark "we intentionally didn't
      // send"; the dashboard logs view shows the reason inline.
      status: 'failed',
      error: `suppressed: ${suppressed}`,
      lead_id: input.lead_id ?? null, contact_id: input.contact_id ?? null, deal_id: input.deal_id ?? null,
      sent_by: input.user_id ?? null, tracking_pixel_token: trackingToken,
    }).select('id').single();
    if (blockedErr) throw new AppError(500, blockedErr.message, 'DB_ERROR');
    return { id: blockedLog.id, tracking_token: trackingToken, suppressed };
  }

  const { data: log, error } = await supabaseAdmin.from('crm_email_logs').insert({
    org_id: input.org_id, template_id: input.template_id ?? null,
    from_email: fromEmail, to_email: input.to, cc: input.cc ?? null, bcc: input.bcc ?? null,
    subject: input.subject, body_html: trackedHtml,
    provider: provider.name, status: 'queued',
    lead_id: input.lead_id ?? null, contact_id: input.contact_id ?? null, deal_id: input.deal_id ?? null,
    sent_by: input.user_id ?? null, tracking_pixel_token: trackingToken,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // ── 2. List-Unsubscribe headers (RFC 2369 + RFC 8058 one-click).
  //    Gmail/Yahoo bulk-sender rules (Feb 2024+) require this for any
  //    sender doing >5k/day. We stamp on every send regardless — it's
  //    free, lifts deliverability, and gives recipients a one-click
  //    out via the inbox UI (no captcha, no extra page).
  //
  //    The mailto: form lets clients still on RFC 2369 unsubscribe by
  //    bouncing a mail to the alias. The URL form is what Gmail's
  //    "Unsubscribe" link in the inbox header actually POSTs to when
  //    `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is present.
  const headers = buildListUnsubscribeHeaders(trackingToken);

  // pg_cron edge function will pick up `queued` rows; here we also do
  // an immediate provider call so dashboards see "sent" without waiting a minute.
  try {
    const result = await provider.send({
      from: fromEmail, to: input.to, cc: input.cc, bcc: input.bcc,
      subject: input.subject, html: trackedHtml, text: bodyText,
      headers,
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

/**
 * Returns a reason string ('bounced' | 'unsubscribed') when the
 * recipient has been suppressed for this org, otherwise null. Two
 * sources of truth:
 *
 *   1. crm_email_logs — any prior row with status='bounced' is a hard
 *      bounce (the bounce webhook only stamps that on hard bounces;
 *      soft bounces stay 'failed').
 *   2. crm_email_unsubscribes — keyed by (org_id, to_email) and
 *      populated by the public /unsubscribe handler.
 *
 * Both queries are best-effort. If either fails (transient DB blip,
 * table missing on an older tenant) we log and fall through to a
 * normal send — better an extra send than a dropped one.
 */
async function isSuppressed(orgId: string, toEmail: string): Promise<string | null> {
  const email = toEmail.trim().toLowerCase();
  if (!email) return null;
  try {
    const { data: unsub } = await supabaseAdmin
      .from('crm_email_unsubscribes')
      .select('id')
      .eq('org_id', orgId)
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (unsub) return 'unsubscribed';
  } catch (e) {
    logger.warn(`[emails] unsubscribe-check failed: ${(e as Error).message}`);
  }
  try {
    const { data: bounce } = await supabaseAdmin
      .from('crm_email_logs')
      .select('id')
      .eq('org_id', orgId)
      .ilike('to_email', email)
      .eq('status', 'bounced')
      .limit(1)
      .maybeSingle();
    if (bounce) return 'bounced';
  } catch (e) {
    logger.warn(`[emails] bounce-check failed: ${(e as Error).message}`);
  }
  return null;
}

/**
 * Build `List-Unsubscribe` (RFC 2369) and `List-Unsubscribe-Post`
 * (RFC 8058) headers. Returns an empty object when no tracking base
 * URL is configured (typical for dev / stub provider), so the
 * provider's send call never carries half-empty headers.
 */
function buildListUnsubscribeHeaders(token: string): Record<string, string> {
  const base = process.env.CRM_TRACKING_BASE_URL || '';
  if (!base) return {};
  const url = `${base.replace(/\/$/, '')}/api/v1/crm/unsubscribe?t=${encodeURIComponent(token)}`;
  // The mailto fallback honours RFC 2369 readers (old Outlook, …).
  // Recipients of mailto unsubs are processed manually today — the
  // alias just needs to land somewhere a human reads.
  const mailto = process.env.CRM_UNSUBSCRIBE_MAILTO || '';
  const value = mailto
    ? `<${url}>, <mailto:${mailto}?subject=unsubscribe>`
    : `<${url}>`;
  return {
    'List-Unsubscribe': value,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Cheap HTML→text used as the plain-text fallback when the caller
 * (or the template) didn't supply one. Not a full HTML parser — that
 * would pull in a heavy dep for a body that only needs to be
 * good-enough for the multipart/alternative text leg. Strips script /
 * style blocks, turns block tags into newlines, collapses whitespace,
 * unescapes the common HTML entities, and trims the result.
 */
export function htmlToPlainText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Record a one-click unsubscribe. Looks up the tracking token in
 * crm_email_logs to find the (org_id, to_email) pair, stamps the log
 * as 'unsubscribed', and upserts crm_email_unsubscribes so future
 * sends to that address are blocked at the top of sendEmail().
 *
 * Returns the suppressed email so the public handler can render a
 * "you've unsubscribed <email>" page. Returns null when the token is
 * unknown — we never leak the existence (or non-existence) of a
 * specific recipient.
 */
export async function recordUnsubscribe(
  token: string,
  source: 'one_click' | 'link' | 'mailto' = 'one_click',
): Promise<string | null> {
  if (!token) return null;
  const { data: log } = await supabaseAdmin
    .from('crm_email_logs')
    .select('id, org_id, to_email')
    .eq('tracking_pixel_token', token)
    .maybeSingle();
  if (!log) return null;

  const email = String(log.to_email || '').trim().toLowerCase();
  if (!email || !log.org_id) return null;

  // Mark the source log row as unsubscribed for the audit trail. We
  // still flip status even if it had progressed to 'opened'/'clicked';
  // the unsubscribe is the latest signal and it's what matters now.
  await supabaseAdmin.from('crm_email_logs').update({ status: 'unsubscribed' }).eq('id', log.id);

  // Upsert into the suppression list. On-conflict (org_id, email)
  // is the unique key — repeat clicks are idempotent.
  const { error: upErr } = await supabaseAdmin
    .from('crm_email_unsubscribes')
    .upsert({ org_id: log.org_id, email, source, source_log_id: log.id }, { onConflict: 'org_id,email' });
  if (upErr) logger.warn(`[emails] unsubscribe upsert failed: ${upErr.message}`);

  return email;
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

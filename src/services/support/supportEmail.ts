/**
 * The emails a customer gets about their support ticket.
 *
 * Sent through the shared `sendEmail` abstraction (services/crm/emails.service → the configured provider,
 * Resend in production), so a support email lands in `crm_email_logs` beside every other outbound email and
 * the dashboard's email-log view shows it.
 *
 * Deliberate choices:
 *
 *  - **Sent as Kinematic, logged under the support org.** The ticket belongs to the customer's own project,
 *    but the email comes from Kinematic, so the caller passes the support org's id and wraps the call in the
 *    Kinematic project (exactly as the WhatsApp path does).
 *  - **Suppression is bypassed.** `sendEmail`'s own docs reserve that for "transactional flows where the
 *    recipient triggered the email themselves", which is precisely a reply on a ticket they opened. Without
 *    it, one old marketing unsubscribe would silently swallow every support answer.
 *  - **Link tracking off.** Rewriting the one link in a support email through a tracking domain buys nothing
 *    and makes the message look like marketing to spam filters.
 *  - **No imported runtime value from supportTickets.service** — only types — so the two modules never form
 *    an import cycle. The caller passes the status label and the support org id in.
 *
 * Times are rendered in IST, because that is the clock every Kinematic customer works to.
 */
import { sendEmail } from '../crm/emails.service';
import { logger } from '../../lib/logger';
import type { Ticket } from './supportTickets.service';

export interface EmailOutcome {
  email: 'sent' | 'skipped' | 'failed';
  note?: string;
}

/** What prompted the email. Drives the subject and the opening line. */
export type SupportEmailKind = 'raised' | 'status' | 'comment';

const FROM = () => process.env.SUPPORT_FROM_EMAIL || 'support@kinematic.app';
const DASHBOARD_FALLBACK = 'https://dashboard.kinematicapp.com';

/**
 * Where "View the ticket" points. Mirrors the guard in auth/passwordReset.service: a stale DASHBOARD_URL
 * left pointing at a dead Railway host would strand every link, so ignore that and anything unparseable.
 */
function dashboardBase(): string {
  const raw = (process.env.DASHBOARD_URL || '').trim().replace(/\/$/, '');
  if (!raw) return DASHBOARD_FALLBACK;
  let host = '';
  try { host = new URL(raw).host; } catch { return DASHBOARD_FALLBACK; }
  if (/\.up\.railway\.app$/i.test(host)) return DASHBOARD_FALLBACK;
  return raw;
}

export const ticketUrl = (t: Pick<Ticket, 'id'>): string =>
  `${dashboardBase()}/dashboard/support?ticket=${encodeURIComponent(t.id)}`;

/** "27 Nov 2026, 6:35 PM IST" — the only clock a Kinematic customer cares about. */
export function istStamp(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  const s = d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return `${s} IST`;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Keep the author's line breaks in HTML without trusting their markup. */
const escMultiline = (v: unknown): string => esc(v).replace(/\r?\n/g, '<br>');

export function subjectFor(kind: SupportEmailKind, t: Ticket, statusLabel: string): string {
  if (kind === 'raised') return `[${t.ref}] We have your request — ${t.subject}`;
  if (kind === 'comment') return `[${t.ref}] Update from Kinematic support — ${t.subject}`;
  return `[${t.ref}] ${statusLabel} — ${t.subject}`;
}

function openingFor(kind: SupportEmailKind, t: Ticket, statusLabel: string): string {
  if (kind === 'raised') {
    return `Thanks for getting in touch. We have logged your request as <strong>${esc(t.ref)}</strong> and our team has been notified.`;
  }
  if (kind === 'comment') return `Our team has replied to your ticket <strong>${esc(t.ref)}</strong>.`;
  switch (t.status) {
    case 'resolved':
      return `Good news — we have marked <strong>${esc(t.ref)}</strong> as resolved.`;
    case 'closed':
      return `Your ticket <strong>${esc(t.ref)}</strong> has been closed.`;
    case 'rejected':
      return `We will not be taking <strong>${esc(t.ref)}</strong> forward for now.`;
    case 'release_pending':
      return `The fix for <strong>${esc(t.ref)}</strong> is ready and ships in our next release.`;
    case 'waiting_on_customer':
      return `We need a little more from you on <strong>${esc(t.ref)}</strong> before we can carry on.`;
    default:
      return `Your ticket <strong>${esc(t.ref)}</strong> is now <strong>${esc(statusLabel)}</strong>.`;
  }
}

/** What the customer can do next, which differs by where the ticket now stands. */
function closingFor(kind: SupportEmailKind, t: Ticket): string {
  if (t.status === 'resolved' || t.status === 'closed') {
    return 'If the problem is still there, reply on the ticket and we will pick it up again. We would also be glad to hear how we did.';
  }
  if (t.status === 'rejected') return 'If this is blocking you, reply on the ticket and tell us why — we will look again.';
  if (t.status === 'waiting_on_customer') return 'Reply on the ticket with the detail and we will carry on.';
  if (kind === 'raised') return 'We will keep you posted here, and you can follow the ticket in your dashboard at any time.';
  return 'You can reply on the ticket if there is anything to add.';
}

const C = {
  ink: '#0A0E1A', body: '#2C3444', mute: '#6B7280', line: '#E5E7EB', wash: '#F6F7F9', accent: '#0A0E1A',
};

function html(kind: SupportEmailKind, t: Ticket, statusLabel: string, message: string | null): string {
  const rows: Array<[string, string]> = [
    ['Ticket', esc(t.ref)],
    ['Status', esc(statusLabel)],
    ['Raised', esc(istStamp(t.created_at))],
  ];
  if (t.area) rows.push(['Area', esc(t.area)]);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.wash};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.wash};padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${C.line};border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td style="padding:20px 24px 0;">
      <div style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:${C.ink};">Kinematic Support</div>
    </td></tr>
    <tr><td style="padding:14px 24px 0;">
      <h1 style="margin:0;font-size:19px;line-height:1.35;font-weight:700;color:${C.ink};">${esc(t.subject)}</h1>
      <p style="margin:12px 0 0;font-size:14.5px;line-height:1.6;color:${C.body};">${openingFor(kind, t, statusLabel)}</p>
    </td></tr>
    ${message ? `<tr><td style="padding:16px 24px 0;">
      <div style="padding:12px 14px;background:${C.wash};border-left:3px solid ${C.accent};border-radius:6px;font-size:14px;line-height:1.6;color:${C.body};">${escMultiline(message)}</div>
    </td></tr>` : ''}
    <tr><td style="padding:18px 24px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:13px;color:${C.body};border:1px solid ${C.line};border-radius:8px;">
        ${rows.map(([k, v], i) => `<tr>
          <td style="padding:9px 12px;color:${C.mute};width:34%;${i ? `border-top:1px solid ${C.line};` : ''}">${k}</td>
          <td style="padding:9px 12px;${i ? `border-top:1px solid ${C.line};` : ''}">${v}</td>
        </tr>`).join('')}
      </table>
    </td></tr>
    <tr><td style="padding:20px 24px 0;">
      <a href="${esc(ticketUrl(t))}" style="display:inline-block;padding:11px 18px;background:${C.accent};color:#FFFFFF;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View the ticket</a>
    </td></tr>
    <tr><td style="padding:16px 24px 22px;">
      <p style="margin:0;font-size:13px;line-height:1.6;color:${C.mute};">${esc(closingFor(kind, t))}</p>
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid ${C.line};background:${C.wash};">
      <p style="margin:0;font-size:11.5px;line-height:1.5;color:${C.mute};">
        You are getting this because you or your team raised ticket ${esc(t.ref)} with Kinematic support.
      </p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function text(kind: SupportEmailKind, t: Ticket, statusLabel: string, message: string | null): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  return [
    `Kinematic Support`,
    ``,
    t.subject,
    ``,
    strip(openingFor(kind, t, statusLabel)),
    ...(message ? ['', message] : []),
    ``,
    `Ticket: ${t.ref}`,
    `Status: ${statusLabel}`,
    `Raised: ${istStamp(t.created_at)}`,
    ``,
    `View the ticket: ${ticketUrl(t)}`,
    ``,
    strip(closingFor(kind, t)),
  ].join('\n');
}

/**
 * Email the customer about their ticket. Never throws: a failed email can't be allowed to undo the status
 * change or the reply that triggered it. The caller must already be inside the support project.
 */
export async function emailCustomer(args: {
  ticket: Ticket;
  kind: SupportEmailKind;
  statusLabel: string;
  /** The team's note or reply, shown as a quote. */
  message: string | null;
  /** The org the send is logged under — the support (Kinematic) org. */
  orgId: string | null;
}): Promise<EmailOutcome> {
  const { ticket: t, kind, statusLabel, message, orgId } = args;
  const to = String(t.contact_email ?? '').trim();
  if (!to || !to.includes('@')) {
    return { email: 'skipped', note: 'No email address on this ticket.' };
  }
  if (!orgId) {
    return { email: 'skipped', note: "Kinematic's support organisation could not be resolved, so no email was sent." };
  }
  try {
    const r = await sendEmail({
      org_id: orgId,
      to,
      subject: subjectFor(kind, t, statusLabel),
      body_html: html(kind, t, statusLabel, message),
      body_text: text(kind, t, statusLabel, message),
      from_email: FROM(),
      // The customer opened this ticket, so this is transactional: an old marketing unsubscribe
      // must not swallow the answer they are waiting for.
      bypass_suppression: true,
      track_links: false,
    });
    const status = (r as { status?: string } | null)?.status;
    if (status && status !== 'sent') {
      return { email: 'failed', note: (r as { error?: string }).error || `Email ${status}` };
    }
    return { email: 'sent' };
  } catch (e: any) {
    logger.warn(`[support] email to customer failed ticket=${t.ref}: ${e?.message || e}`);
    return { email: 'failed', note: e?.message || 'Email send failed' };
  }
}

/**
 * Transactional emailers sent from Client Management:
 *   - Welcome email        — sent when onboarding a client (manual button).
 *   - Payment reminder     — sent against the client's next unpaid invoice.
 *
 * Both render a small, email-safe branded layout (inline styles, a centred
 * ~560px card, light background) and go out through the shared CRM mailer.
 * They're transactional (an operator explicitly triggers each one), so the
 * caller sets bypass_suppression and turns off link tracking so the sign-in /
 * invoice links stay real.
 */
import { sendEmail } from './crm/emails.service';
import { dashboardBase, publicDocUrl } from './finance/share';

const BRAND = 'Kinematic';
const ACCENT = '#2563EB';
const INK = '#0F172A';
const MUTE = '#64748B';
const LINE = '#E2E8F0';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** ₹ with Indian digit grouping; no decimals when whole. */
export function inr(n: number): string {
  const v = Number(n) || 0;
  const whole = Math.round(v * 100) % 100 === 0;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Shared outer layout. `preheader` is the inbox preview snippet. */
function layout(opts: { title: string; preheader: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<span style="display:none!important;opacity:0;color:#F1F5F9;font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#FFFFFF;border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
      <tr><td style="background:${INK};padding:20px 28px;">
        <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:19px;font-weight:700;letter-spacing:-0.3px;color:#FFFFFF;">${BRAND}</span>
      </td></tr>
      <tr><td style="padding:30px 28px 10px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
        ${opts.bodyHtml}
      </td></tr>
      <tr><td style="padding:18px 28px 26px;border-top:1px solid ${LINE};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTE};">You're receiving this because you manage a ${BRAND} account. If this doesn't look right, just reply to this email.</p>
      </td></tr>
    </table>
    <p style="margin:14px 0 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#94A3B8;">© ${new Date().getUTCFullYear()} ${BRAND}</p>
  </td></tr>
</table></body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;"><tr>
    <td style="border-radius:10px;background:${ACCENT};">
      <a href="${esc(href)}" style="display:inline-block;padding:12px 24px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;">${esc(label)}</a>
    </td></tr></table>`;
}

// ── Welcome ──────────────────────────────────────────────────────────────────
export interface WelcomeData {
  clientName: string;
  contactName?: string | null;
  loginUrl?: string;
}

export function renderWelcomeEmail(d: WelcomeData): { subject: string; html: string; text: string } {
  const who = (d.contactName || '').trim() || d.clientName;
  const loginUrl = d.loginUrl || dashboardBase();
  const subject = `Welcome to ${BRAND}, ${d.clientName}`;
  const body = `
    <h1 style="margin:0 0 14px;font-size:22px;font-weight:700;letter-spacing:-0.3px;color:${INK};">Welcome aboard, ${esc(who)} 👋</h1>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#334155;">Your <strong>${esc(d.clientName)}</strong> account on ${BRAND} is ready. Sign in to set up your team, configure your workspace and get your field force moving.</p>
    ${button(loginUrl, 'Sign in to your dashboard')}
    <p style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${INK};">A few things you can do first</p>
    <ul style="margin:0 0 10px;padding-left:20px;font-size:14px;line-height:1.7;color:#334155;">
      <li>Invite your users and assign roles</li>
      <li>Set up attendance, routes and the modules for your plan</li>
      <li>Start capturing leads and activity from the mobile app</li>
    </ul>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.65;color:#334155;">Need a hand getting started? Reply to this email and our team will help.</p>`;
  const text = [
    `Welcome aboard, ${who}`,
    ``,
    `Your ${d.clientName} account on ${BRAND} is ready. Sign in to set up your team and configure your workspace:`,
    loginUrl,
    ``,
    `First steps:`,
    `- Invite your users and assign roles`,
    `- Set up attendance, routes and the modules for your plan`,
    `- Start capturing leads and activity from the mobile app`,
    ``,
    `Need a hand? Just reply to this email.`,
    `— ${BRAND}`,
  ].join('\n');
  return { subject, html: layout({ title: subject, preheader: `Your ${d.clientName} account is ready — sign in to get started.`, bodyHtml: body }), text };
}

// ── Payment reminder ─────────────────────────────────────────────────────────
export interface ReminderInvoice {
  number: string;
  due_date: string | null;
  total: number;
  balance: number;
  share_token?: string | null;
}
export interface ReminderData {
  clientName: string;
  contactName?: string | null;
  invoice: ReminderInvoice;
}

export function renderPaymentReminderEmail(d: ReminderData): { subject: string; html: string; text: string } {
  const who = (d.contactName || '').trim() || d.clientName;
  const inv = d.invoice;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !!inv.due_date && String(inv.due_date).slice(0, 10) < today;
  const dueLine = inv.due_date
    ? `${overdue ? 'was due' : 'is due'} ${fmtDate(inv.due_date)}`
    : 'is due on receipt';
  const payUrl = inv.share_token ? publicDocUrl(inv.share_token) : null;
  const subject = overdue
    ? `Overdue: invoice ${inv.number} for ${d.clientName}`
    : `Payment reminder: invoice ${inv.number}`;

  const rows = [
    ['Invoice', esc(inv.number)],
    ['Amount due', inr(inv.balance)],
    ...(inv.balance !== inv.total ? [['Invoice total', inr(inv.total)]] : []),
    ['Due date', inv.due_date ? fmtDate(inv.due_date) : 'On receipt'],
  ].map(([k, v], i) => `<tr>
      <td style="padding:9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font-size:13px;color:${MUTE};">${k}</td>
      <td style="padding:9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font-size:14px;font-weight:600;color:${INK};text-align:right;">${v}</td>
    </tr>`).join('');

  const body = `
    <h1 style="margin:0 0 14px;font-size:22px;font-weight:700;letter-spacing:-0.3px;color:${INK};">Payment reminder</h1>
    <p style="margin:0 0 6px;font-size:15px;line-height:1.65;color:#334155;">Hi ${esc(who)}, a quick reminder that invoice <strong>${esc(inv.number)}</strong> for <strong>${esc(d.clientName)}</strong> ${dueLine}.</p>
    ${overdue ? `<p style="margin:8px 0 0;font-size:13px;font-weight:600;color:#B91C1C;">This invoice is past due — please arrange payment at your earliest convenience.</p>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;border:1px solid ${LINE};border-radius:10px;padding:4px 16px;">${rows}</table>
    ${payUrl ? button(payUrl, 'View & pay invoice') : ''}
    <p style="margin:16px 0 0;font-size:13px;line-height:1.65;color:${MUTE};">If you've already paid, please ignore this reminder. Questions about the invoice? Just reply to this email.</p>`;

  const text = [
    `Payment reminder`,
    ``,
    `Hi ${who}, invoice ${inv.number} for ${d.clientName} ${dueLine}.`,
    overdue ? `This invoice is past due — please arrange payment at your earliest convenience.` : ``,
    ``,
    `Amount due: ${inr(inv.balance)}${inv.balance !== inv.total ? ` (invoice total ${inr(inv.total)})` : ''}`,
    `Due date: ${inv.due_date ? fmtDate(inv.due_date) : 'On receipt'}`,
    payUrl ? `\nView & pay: ${payUrl}` : ``,
    ``,
    `If you've already paid, please ignore this reminder.`,
    `— ${BRAND}`,
  ].filter((l) => l !== undefined).join('\n');

  return { subject, html: layout({ title: subject, preheader: `Invoice ${inv.number} — ${inr(inv.balance)} ${dueLine}.`, bodyHtml: body }), text };
}

// ── Send wrappers ────────────────────────────────────────────────────────────
const isLive = () => (process.env.EMAIL_PROVIDER || '').toLowerCase() === 'resend';

export async function sendClientWelcome(opts: { orgId: string; userId?: string; to: string; data: WelcomeData }) {
  const { subject, html, text } = renderWelcomeEmail(opts.data);
  const r = await sendEmail({
    org_id: opts.orgId, user_id: opts.userId, to: opts.to, subject,
    body_html: html, body_text: text, bypass_suppression: true, track_links: false,
  });
  return { to: opts.to, subject, live: isLive(), ...r };
}

export async function sendClientPaymentReminder(opts: { orgId: string; userId?: string; to: string; data: ReminderData }) {
  const { subject, html, text } = renderPaymentReminderEmail(opts.data);
  const r = await sendEmail({
    org_id: opts.orgId, user_id: opts.userId, to: opts.to, subject,
    body_html: html, body_text: text, bypass_suppression: true, track_links: false,
  });
  return { to: opts.to, subject, live: isLive(), ...r };
}

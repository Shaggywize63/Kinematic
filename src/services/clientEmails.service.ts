/**
 * Transactional emailers sent from Client Management:
 *   - Welcome email    — onboarding a client (manual button), with setup steps.
 *   - Payment reminder  — against the client's next unpaid invoice.
 *
 * Styled on the Kinematic brand system (see kinematic-dashboard/BRAND.md):
 * stone canvas, Manrope display / Inter body / JetBrains Mono eyebrow, the real
 * logo lockup, and brand red (#D01E2C) as the single accent — "red is a spice,
 * not a sauce". KINI, the robot mascot, narrates (the quirky bit). Images are
 * PNGs served from the dashboard's public folder so they render in every mail
 * client (SVG / data-URIs don't); every image has alt text so a blocked-image
 * inbox still reads cleanly.
 *
 * Both render HTML AND plain text and go through the shared CRM mailer. They're
 * transactional (an operator triggers each), so the caller bypasses suppression
 * and turns off link tracking so the sign-in / invoice links stay real.
 */
import { sendEmail } from './crm/emails.service';
import { dashboardBase, publicDocUrl } from './finance/share';

// ── Brand tokens (BRAND.md) ──────────────────────────────────────────────────
const RED = '#D01E2C';
const INK = '#0A0E1A';
const NAVY = '#0E1A2E';
const STONE = '#FAFAFB';
const PAPER = '#FFFFFF';
const RULE = '#E4E6EB';
const DIM = '#55657D';
const MUTE = '#7A8BA0';
const REDWASH = '#FBE7E9';

const FONT_HEAD = "'Manrope','Segoe UI',Arial,sans-serif";
const FONT_BODY = "'Inter',-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
const FONT_MONO = "'JetBrains Mono','SF Mono',Consolas,monospace";
const FONT_LINK = 'https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap';

const asset = (name: string) => `${dashboardBase()}/email/${name}`;

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

/** Red, bulletproof-ish CTA. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px;"><tr>
    <td align="center" bgcolor="${RED}" style="border-radius:12px;">
      <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT_HEAD};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(label)} &rarr;</a>
    </td></tr></table>`;
}

/** KINI mascot beside a speech bubble — the friendly opener on both emails. */
function kiniHero(bubbleHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;"><tr>
      <td valign="top" width="92" style="padding-right:14px;">
        <img src="${asset('kini.png')}" width="78" height="78" alt="KINI, the Kinematic robot" style="display:block;border:0;outline:none;width:78px;height:78px;">
      </td>
      <td valign="middle">
        <div style="position:relative;background:${STONE};border:1px solid ${RULE};border-radius:4px 14px 14px 14px;padding:12px 16px;font-family:${FONT_BODY};font-size:14.5px;line-height:1.5;color:${INK};">
          ${bubbleHtml}
        </div>
      </td>
    </tr></table>`;
}

/** Full email shell: stone canvas, white card, logo header, eyebrow, body, footer. */
function shell(o: { title: string; preheader: string; eyebrow: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(o.title)}</title>
<link rel="stylesheet" href="${FONT_LINK}"></head>
<body style="margin:0;padding:0;background:${STONE};">
<span style="display:none!important;opacity:0;color:${STONE};font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${STONE};padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${PAPER};border:1px solid ${RULE};border-radius:20px;overflow:hidden;">
      <tr><td style="padding:28px 34px 0;">
        <img src="${asset('kinematic-logo.png')}" height="30" alt="Kinematic" style="display:block;border:0;outline:none;height:30px;width:auto;">
      </td></tr>
      <tr><td style="padding:22px 34px 4px;">
        <div style="font-family:${FONT_MONO};font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:${RED};">${esc(o.eyebrow)}</div>
      </td></tr>
      <tr><td style="padding:4px 34px 8px;">${o.bodyHtml}</td></tr>
      <tr><td style="padding:20px 34px 28px;border-top:1px solid ${RULE};">
        <p style="margin:0;font-family:${FONT_BODY};font-size:12px;line-height:1.6;color:${MUTE};">You're receiving this because you manage a Kinematic account. Replies reach a real human on our team.</p>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-family:${FONT_MONO};font-size:10.5px;letter-spacing:0.5px;color:#9AA7B8;">&copy; ${new Date().getUTCFullYear()} KINEMATIC &middot; SENT BY KINI &#129302;</p>
  </td></tr>
</table></body></html>`;
}

const h1 = (text: string) => `<h1 style="margin:0 0 12px;font-family:${FONT_HEAD};font-size:25px;line-height:1.2;font-weight:800;letter-spacing:-0.5px;color:${INK};">${text}</h1>`;
const p = (html: string) => `<p style="margin:0 0 14px;font-family:${FONT_BODY};font-size:15px;line-height:1.65;font-weight:400;color:#2A3341;">${html}</p>`;

// ── Welcome ──────────────────────────────────────────────────────────────────
export interface WelcomeData {
  clientName: string;
  contactName?: string | null;
  loginUrl?: string;
}

const SETUP_STEPS: Array<{ t: string; d: string }> = [
  { t: 'Claim your account', d: 'Sign in with the email this landed in and set a strong password on first login.' },
  { t: 'Add your field executives', d: 'Invite your team, then assign their roles, beats / routes and supervisors.' },
  { t: 'Switch on what you use', d: 'Attendance, routes, forms and the modules on your plan — flip on only what the team needs.' },
  { t: 'Hand them the app', d: 'Point your executives at the Kinematic mobile app and the check-ins start rolling in.' },
];

export function renderWelcomeEmail(d: WelcomeData): { subject: string; html: string; text: string } {
  const who = (d.contactName || '').trim() || d.clientName;
  const loginUrl = d.loginUrl || dashboardBase();
  const subject = `${d.clientName} is live on Kinematic 🎉`;

  const steps = SETUP_STEPS.map((s, i) => `<tr>
      <td valign="top" width="40" style="padding:0 14px 16px 0;">
        <div style="width:30px;height:30px;line-height:30px;text-align:center;background:${RED};color:#fff;border-radius:50%;font-family:${FONT_HEAD};font-size:14px;font-weight:800;">${i + 1}</div>
      </td>
      <td valign="top" style="padding:0 0 16px;">
        <div style="font-family:${FONT_HEAD};font-size:15px;font-weight:700;color:${INK};">${esc(s.t)}</div>
        <div style="font-family:${FONT_BODY};font-size:13.5px;line-height:1.55;color:${DIM};margin-top:2px;">${esc(s.d)}</div>
      </td>
    </tr>`).join('');

  const body = `
    ${kiniHero(`Hey ${esc(who)} &mdash; I'm <strong>KINI</strong>, your in-app co-pilot. Welcome to the team! I'll be riding shotgun in the corner of every screen. &#128075;`)}
    ${h1(`${esc(d.clientName)} is live. Let's get the team moving.`)}
    ${p('Your workspace is set up and ready to go. Four quick steps &mdash; about ten minutes &mdash; and your field force is up and running.')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 4px;background:${STONE};border:1px solid ${RULE};border-radius:14px;padding:20px 20px 4px;">
      <tr><td style="font-family:${FONT_MONO};font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:${DIM};padding-bottom:16px;">Get rolling in 4 steps</td></tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${steps}</table></td></tr>
    </table>
    ${button(loginUrl, 'Sign in to your dashboard')}
    ${p(`Once your executives check in from the app, live attendance, routes and visits roll straight into your dashboard. Stuck anywhere? Give me a poke &mdash; I'm right there in the corner.`)}
    <p style="margin:18px 0 0;font-family:${FONT_HEAD};font-size:14px;font-weight:700;color:${INK};">&mdash; KINI &amp; the Kinematic team</p>`;

  const text = [
    `${d.clientName} is live on Kinematic`,
    ``,
    `Hey ${who} — I'm KINI, your in-app co-pilot. Welcome to the team!`,
    ``,
    `Your workspace is ready. Get rolling in 4 steps (about ten minutes):`,
    ...SETUP_STEPS.map((s, i) => `  ${i + 1}. ${s.t} — ${s.d}`),
    ``,
    `Sign in to your dashboard: ${loginUrl}`,
    ``,
    `Once your executives check in from the app, live attendance, routes and visits roll into your dashboard. Stuck? Just reply to this email.`,
    `— KINI & the Kinematic team`,
  ].join('\n');

  return { subject, html: shell({ title: subject, preheader: `Welcome aboard — set up ${d.clientName} in 4 quick steps.`, eyebrow: 'Welcome aboard', bodyHtml: body }), text };
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
  const payUrl = inv.share_token ? publicDocUrl(inv.share_token) : null;
  const subject = overdue
    ? `A gentle nudge: invoice ${inv.number} is overdue`
    : `A quick heads-up on invoice ${inv.number}`;

  const rows = [
    ['Invoice', esc(inv.number)],
    ['Amount due', `<span style="color:${RED};font-weight:800;">${inr(inv.balance)}</span>`],
    ...(inv.balance !== inv.total ? [['Invoice total', inr(inv.total)]] : []),
    ['Due date', inv.due_date ? `${fmtDate(inv.due_date)}${overdue ? ` <span style="color:${RED};font-weight:700;">&middot; overdue</span>` : ''}` : 'On receipt'],
  ].map(([k, v], i) => `<tr>
      <td style="padding:10px 0;${i ? `border-top:1px solid ${RULE};` : ''}font-family:${FONT_BODY};font-size:13.5px;color:${DIM};">${k}</td>
      <td style="padding:10px 0;${i ? `border-top:1px solid ${RULE};` : ''}font-family:${FONT_HEAD};font-size:15px;font-weight:700;color:${INK};text-align:right;">${v}</td>
    </tr>`).join('');

  const body = `
    ${kiniHero(`Psst &mdash; <strong>KINI</strong> here with a tiny nudge for ${esc(who)}. &#129534;`)}
    ${h1(overdue ? `Invoice ${esc(inv.number)} slipped a little past due.` : `A quick heads-up on invoice ${esc(inv.number)}.`)}
    ${p(`Just flagging <strong>${esc(d.clientName)}</strong>'s next payment so nothing sneaks up on you.`)}
    ${overdue ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background:${REDWASH};border:1px solid #F2C5CA;border-radius:12px;"><tr><td style="padding:12px 16px;font-family:${FONT_BODY};font-size:13.5px;line-height:1.55;color:#8E1420;">This one's past its due date &mdash; whenever you get a moment to settle it, I'd be ever so grateful. &#128591;</td></tr></table>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 2px;background:${STONE};border:1px solid ${RULE};border-radius:14px;padding:6px 18px;">${rows}</table>
    ${payUrl ? button(payUrl, 'View & pay invoice') : ''}
    ${p(`Already sorted it? Then ignore me and carry on &mdash; you're a star. &#11088; Questions on the invoice? Reply straight to this email and a human will pick it up.`)}
    <p style="margin:18px 0 0;font-family:${FONT_HEAD};font-size:14px;font-weight:700;color:${INK};">&mdash; KINI, keeping the books tidy</p>`;

  const text = [
    overdue ? `A gentle nudge: invoice ${inv.number} is overdue` : `A quick heads-up on invoice ${inv.number}`,
    ``,
    `Psst — KINI here with a tiny nudge for ${who}.`,
    `Just flagging ${d.clientName}'s next payment so nothing sneaks up on you.`,
    overdue ? `\nThis one's past its due date — whenever you get a moment to settle it, I'd be grateful.` : '',
    ``,
    `Invoice:    ${inv.number}`,
    `Amount due: ${inr(inv.balance)}${inv.balance !== inv.total ? ` (invoice total ${inr(inv.total)})` : ''}`,
    `Due date:   ${inv.due_date ? fmtDate(inv.due_date) : 'On receipt'}${overdue ? ' (overdue)' : ''}`,
    payUrl ? `\nView & pay: ${payUrl}` : '',
    ``,
    `Already sorted it? Ignore me and carry on. Questions? Just reply.`,
    `— KINI, keeping the books tidy`,
  ].filter((l) => l !== '').join('\n');

  return { subject, html: shell({ title: subject, preheader: `Invoice ${inv.number} — ${inr(inv.balance)} ${overdue ? 'is overdue' : 'coming up'}.`, eyebrow: overdue ? 'Friendly nudge' : 'Payment reminder', bodyHtml: body }), text };
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

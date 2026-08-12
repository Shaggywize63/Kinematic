/**
 * Email alerts — a pre-composed (template + recipients + sender) send
 * that can fire immediately or be scheduled for later. The actual
 * provider call lives in emails.service.ts; this module owns the
 * scheduling + dispatch loop.
 *
 * dispatchDueAlerts() is invoked by the cron edge function every minute.
 * It picks up alerts where status='scheduled' AND scheduled_at <= now()
 * and sends them to every address in to_emails (one email per recipient
 * so per-rep open/click attribution stays clean in crm_email_logs).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { sendEmail } from './emails.service';

export interface EmailAlertInput {
  org_id: string;
  client_id: string | null;
  created_by: string | null;
  name: string;
  template_id?: string | null;
  from_email: string;                 // must be a verified sender
  from_name?: string | null;
  to_emails: string[];
  cc_emails?: string[] | null;
  bcc_emails?: string[] | null;
  subject_override?: string | null;
  body_override?: string | null;       // raw HTML; overrides template body
  variables?: Record<string, string> | null;
  scheduled_at?: string | null;        // ISO string; null = send now
}

export async function createAlert(input: EmailAlertInput) {
  // Guardrail: confirm the from_email is verified for this org. The FE
  // dropdown already filters; this is the server-side check so a crafted
  // request can't spoof a sender.
  const { data: sender } = await supabaseAdmin
    .from('crm_verified_senders')
    .select('id')
    .eq('org_id', input.org_id)
    .eq('email', input.from_email.toLowerCase())
    .not('verified_at', 'is', null)
    .maybeSingle();
  if (!sender) throw new AppError(400, 'From address is not a verified sender for this org', 'UNVERIFIED_SENDER');

  if (!input.to_emails || input.to_emails.length === 0) {
    throw new AppError(400, 'At least one To address is required', 'VALIDATION');
  }

  const status = input.scheduled_at ? 'scheduled' : 'sending';
  const { data: alert, error } = await supabaseAdmin
    .from('crm_email_alerts')
    .insert({
      org_id: input.org_id, client_id: input.client_id, created_by: input.created_by,
      name: input.name.trim().slice(0, 200) || 'Untitled alert',
      template_id: input.template_id ?? null,
      from_email: input.from_email.toLowerCase(),
      from_name: input.from_name ?? null,
      to_emails: input.to_emails,
      cc_emails: input.cc_emails && input.cc_emails.length > 0 ? input.cc_emails : null,
      bcc_emails: input.bcc_emails && input.bcc_emails.length > 0 ? input.bcc_emails : null,
      subject_override: input.subject_override ?? null,
      body_override: input.body_override ?? null,
      variables: input.variables ?? null,
      scheduled_at: input.scheduled_at ?? null,
      status,
      recipients_total: input.to_emails.length,
    })
    .select('*')
    .single();
  if (error || !alert) throw new AppError(500, error?.message || 'Insert failed', 'DB_ERROR');

  if (!input.scheduled_at) {
    // Fire now (don't await — we return the alert id and let dispatch
    // happen in the background so the FE doesn't hang on slow providers).
    void dispatchAlert((alert as any).id);
  }
  return alert;
}

export async function listAlerts(org_id: string, limit = 100) {
  const { data, error } = await supabaseAdmin
    .from('crm_email_alerts')
    .select('id, name, template_id, from_email, from_name, to_emails, cc_emails, bcc_emails, scheduled_at, status, sent_at, recipients_total, recipients_sent, recipients_failed, created_at, error')
    .eq('org_id', org_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 500));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function getAlert(org_id: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from('crm_email_alerts').select('*').eq('org_id', org_id).eq('id', id).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function cancelAlert(org_id: string, id: string): Promise<void> {
  await supabaseAdmin
    .from('crm_email_alerts')
    .update({ status: 'cancelled' })
    .eq('org_id', org_id).eq('id', id)
    .eq('status', 'scheduled'); // only cancel-able while still scheduled
}

/**
 * Sends one alert to every address in to_emails. CC/BCC are applied to
 * every send for parity with what a human would do in a mail client.
 * Each send is logged in crm_email_logs by emails.service.sendEmail.
 */
export async function dispatchAlert(alertId: string): Promise<void> {
  const { data: alertRow } = await supabaseAdmin
    .from('crm_email_alerts').select('*').eq('id', alertId).maybeSingle();
  if (!alertRow) return;
  const a = alertRow as any;
  if (a.status !== 'scheduled' && a.status !== 'sending') return;

  await supabaseAdmin.from('crm_email_alerts').update({ status: 'sending' }).eq('id', alertId);

  // Resolve template (if any) + apply overrides.
  let subject = a.subject_override || '';
  let bodyHtml = a.body_override || '';
  if (a.template_id && (!subject || !bodyHtml)) {
    const { data: tpl } = await supabaseAdmin
      .from('crm_email_templates')
      .select('subject, body_html, body_text')
      .eq('id', a.template_id).maybeSingle();
    if (tpl) {
      subject = subject || (tpl as any).subject || '';
      bodyHtml = bodyHtml || (tpl as any).body_html || '';
    }
  }
  if (!subject || !bodyHtml) {
    await supabaseAdmin.from('crm_email_alerts').update({
      status: 'failed', error: 'Missing subject or body — set a template or fill in overrides',
    }).eq('id', alertId);
    return;
  }

  const vars: Record<string, string> = a.variables || {};
  subject = renderVars(subject, vars);
  bodyHtml = renderVars(bodyHtml, vars);

  let sent = 0, failed = 0;
  // Send from the alert's CHOSEN verified sender. Previously this call omitted
  // from_email, so every alert fell back to the env default (CRM_FROM_EMAIL =
  // noreply@mail.kinematicapp.com) — an unverified Resend domain that 403s on
  // every send, so nothing reached the inbox. Honour the picked sender (its
  // domain must be verified in Resend); include the display name when present.
  const fromAddr = a.from_email
    ? (a.from_name ? `${a.from_name} <${a.from_email}>` : (a.from_email as string))
    : undefined;
  for (const to of (a.to_emails as string[])) {
    try {
      // sendEmail swallows provider (Resend) errors and RETURNS a status —
      // it does NOT throw on a 403/bounce. The old code ignored the result and
      // counted every recipient as "sent", so the dashboard showed "sent" even
      // when Resend rejected all of them. Count by the real returned status.
      const res = await sendEmail({
        org_id: a.org_id,
        user_id: a.created_by ?? undefined,
        to,
        cc: a.cc_emails ?? undefined,
        bcc: a.bcc_emails ?? undefined,
        subject,
        body_html: bodyHtml,
        template_id: a.template_id ?? null,
        from_email: fromAddr,
      });
      if ((res as { status?: string })?.status === 'sent') sent++;
      else failed++; // provider failure or suppression (blocked) — not delivered
    } catch (err) {
      failed++;
      // Best-effort: don't abort the whole alert if one address bounces.
      // The error gets logged per-recipient in crm_email_logs already.
      void err;
    }
  }

  await supabaseAdmin.from('crm_email_alerts').update({
    status: failed === a.to_emails.length ? 'failed' : 'sent',
    sent_at: new Date().toISOString(),
    recipients_sent: sent,
    recipients_failed: failed,
    error: failed > 0 ? `${failed} address(es) failed; check email logs for details` : null,
  }).eq('id', alertId);

  // Auto-populate the org's saved-recipient book from everyone this alert was
  // addressed to (To + CC + BCC). Feeds the "saved recipients" picker in the
  // compose form so the next alert can add them back with one click. Strictly
  // best-effort: a project missing the table/RPC must never break a send.
  try {
    const everyone = [
      ...(a.to_emails as string[] | null ?? []),
      ...(a.cc_emails as string[] | null ?? []),
      ...(a.bcc_emails as string[] | null ?? []),
    ];
    if (everyone.length > 0) {
      await supabaseAdmin.rpc('crm_record_email_recipients', {
        p_org_id: a.org_id,
        p_client_id: a.client_id ?? null,
        p_emails: everyone,
      });
    }
  } catch (err) {
    void err; // never let recipient bookkeeping fail a dispatched alert
  }
}

/**
 * The org's saved-recipient book — every address a past alert was sent to,
 * newest activity first. Powers the compose form's "saved recipients" picker
 * so reps can re-add people without retyping. Auto-grows via dispatchAlert.
 */
export async function listRecipients(org_id: string, limit = 500) {
  const { data, error } = await supabaseAdmin
    .from('crm_email_recipients')
    .select('email, name, times_sent, last_sent_at')
    .eq('org_id', org_id)
    .order('last_sent_at', { ascending: false, nullsFirst: false })
    .limit(Math.min(limit, 2000));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

/**
 * Cron entry point — dispatches every alert whose scheduled_at has passed.
 * Caps batch size so a backlog can't blow out a single cron tick.
 */
export async function dispatchDueAlerts(limit = 50): Promise<{ scanned: number; dispatched: number }> {
  const { data } = await supabaseAdmin
    .from('crm_email_alerts')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .limit(limit);
  const rows = (data ?? []) as Array<{ id: string }>;
  for (const r of rows) {
    await dispatchAlert(r.id);
  }
  return { scanned: rows.length, dispatched: rows.length };
}

function renderVars(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

/**
 * Recurring-invoice reminders — turns a recurring invoice whose next_invoice_date
 * has arrived into a reminder for the finance admin to RAISE the next invoice.
 * Remind-only: nothing is auto-created.
 *
 * Delivery reuses the existing paths:
 *   - a public.notifications row → the dispatch-pushes cron fans it out to the
 *     in-app bell (web/iOS/Android) + FCM/APNs push, exactly like activity reminders.
 *   - an email to the finance admin (business finance inbox, else the creator),
 *     when recurrence_reminder_email is on.
 *
 * After reminding, next_invoice_date rolls forward to the next future occurrence
 * (so it reminds once per cycle) and recurrence_reminded_at is stamped. Runs under
 * runWithProject per tenant via /cron/finance-invoice-reminders and the in-process
 * daily tick. Self-gating: tenants without the finance tables (Tata) are a silent
 * no-op.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { sendEmail } from '../crm/emails.service';
import { getSettings } from './masters.service';
import { firstFutureFrom, specFromRow } from './recurrence';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const todayIso = () => new Date().toISOString().slice(0, 10);

interface RecurringRow {
  id: string; org_id: string; client_id: string | null; number: string;
  customer_snapshot: { name?: string } | null; created_by: string | null;
  next_invoice_date: string | null; recurrence_reminder_email: boolean | null;
  recurrence_interval: string | null; recurrence_custom_every: number | null; recurrence_custom_unit: string | null;
}

/** A PostgREST error that means the finance tables aren't installed in this project (e.g. Tata). */
const isMissingFinance = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /finance_documents|schema cache|does not exist/i.test(e.message || ''));

export async function dispatchInvoiceRenewalReminders(opts: { limit?: number } = {}): Promise<{ checked: number; created: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const today = todayIso();

  const { data, error } = await supabaseAdmin
    .from('finance_documents')
    .select('id, org_id, client_id, number, customer_snapshot, created_by, next_invoice_date, recurrence_reminder_email, recurrence_interval, recurrence_custom_every, recurrence_custom_unit')
    .eq('doc_type', 'invoice')
    .eq('recurrence_enabled', true)
    .is('deleted_at', null)
    .neq('status', 'void')
    .not('next_invoice_date', 'is', null)
    .lte('next_invoice_date', today)
    .order('next_invoice_date', { ascending: true })
    .limit(limit);

  if (error) {
    if (isMissingFinance(error)) return { checked: 0, created: 0 }; // finance not installed here
    logger.warn(`[finance-reminders] query failed: ${error.message}`);
    return { checked: 0, created: 0 };
  }

  const rows = (data ?? []) as RecurringRow[];
  const stampNow = new Date().toISOString();
  let created = 0;

  for (const inv of rows) {
    const spec = specFromRow(inv);
    // Malformed schedule — park it (null next_invoice_date drops it from the scan) and move on.
    if (!spec || !inv.next_invoice_date) {
      await supabaseAdmin.from('finance_documents')
        .update({ next_invoice_date: null, recurrence_reminded_at: stampNow }).eq('id', inv.id);
      continue;
    }

    const customerName = inv.customer_snapshot?.name || 'a customer';
    const dueDate = inv.next_invoice_date;

    // In-app bell + push (to whoever set the recurring invoice up).
    if (inv.created_by && UUID_RE.test(inv.created_by) && inv.org_id) {
      try {
        await supabaseAdmin.from('notifications').insert({
          org_id: inv.org_id,
          user_id: inv.created_by,
          title: 'Invoice due to be raised',
          body: `The recurring invoice for ${customerName} (last: ${inv.number}) is due to be raised today.`,
          type: 'finance_invoice_due',
          data: { kind: 'finance_invoice_due', invoice_id: inv.id, link: '/dashboard/finance/invoices' },
        });
        created++;
      } catch (e: any) {
        logger.warn(`[finance-reminders] notification insert failed for ${inv.id}: ${e?.message || e}`);
      }
    }

    // Email the finance admin (business finance inbox, else the creator's email).
    if (inv.recurrence_reminder_email !== false) {
      try {
        const settings = await getSettings({ org_id: inv.org_id, client_id: inv.client_id, user_id: '', actor: 'system' });
        let to = (settings?.email || '').trim();
        if (!to && inv.created_by && UUID_RE.test(inv.created_by)) {
          const { data: u } = await supabaseAdmin.from('users').select('email').eq('id', inv.created_by).maybeSingle();
          to = ((u as { email?: string } | null)?.email || '').trim();
        }
        if (to) {
          const business = settings?.business_name || 'Kinematic';
          const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
  <p style="line-height:1.5">This is a reminder to raise the next recurring invoice for <b>${esc(customerName)}</b>.</p>
  <table style="width:100%;border:1px solid #e3e3e3;border-radius:8px;margin:16px 0;border-collapse:collapse">
    <tr><td style="padding:10px 14px;color:#666">Previous invoice</td><td style="padding:10px 14px;text-align:right"><b>${esc(inv.number)}</b></td></tr>
    <tr><td style="padding:10px 14px;color:#666;border-top:1px solid #eee">Due to be raised</td><td style="padding:10px 14px;text-align:right;border-top:1px solid #eee">${esc(dueDate)}</td></tr>
  </table>
  <p style="color:#888;font-size:12px">You're receiving this because this invoice is set to repeat. ${esc(business)}</p></div>`;
          await sendEmail({
            org_id: inv.org_id,
            to,
            subject: `Reminder: raise the recurring invoice for ${customerName}`,
            body_html: html,
            bypass_suppression: true,
            from_email: process.env.FINANCE_FROM_EMAIL || undefined,
          });
        }
      } catch (e: any) {
        logger.warn(`[finance-reminders] email failed for ${inv.id}: ${e?.message || e}`);
      }
    }

    // Roll the schedule forward to the next future occurrence + stamp, so each cycle reminds once.
    const nextDate = firstFutureFrom(inv.next_invoice_date, spec, today);
    await supabaseAdmin.from('finance_documents')
      .update({ next_invoice_date: nextDate, recurrence_reminded_at: stampNow }).eq('id', inv.id);

    // Activity-trail breadcrumb (best-effort).
    try {
      await supabaseAdmin.from('finance_document_events').insert({
        org_id: inv.org_id, document_id: inv.id, event: 'recurrence_reminded',
        detail: { reminded_for: dueDate, next_invoice_date: nextDate }, actor: 'system',
      });
    } catch { /* non-fatal */ }
  }

  return { checked: rows.length, created };
}

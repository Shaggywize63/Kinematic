/**
 * Scheduled report digests — recurring (daily / weekly / monthly) emails that
 * render one of the existing analytics reports and send it to a list of
 * recipients via the same Resend-backed sendEmail path the rest of CRM email
 * uses. Complements the one-shot crm_email_alerts: those fire once at a
 * scheduled_at; these repeat on a cadence and regenerate fresh report data
 * each run.
 *
 * runDueReportDigests() is the cron/in-process entry point. It picks active
 * schedules whose next_run_at has passed, renders + emails each, then rolls
 * next_run_at forward — even on render failure, so a broken schedule can't
 * busy-loop the dispatcher.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { sendEmail } from './emails.service';
import * as analytics from './analytics.service';
import * as analyticsExt from './analytics-extended.service';
import { logger } from '../../lib/logger';

export type Frequency = 'daily' | 'weekly' | 'monthly';

type Range = { from?: string; to?: string } | undefined;

interface ReportDef {
  label: string;
  run: (org_id: string, client_id: string | null, range: Range) => Promise<unknown>;
}

// Curated set of digestible reports. Each reuses an existing analytics service
// fn (org-wide / client-scoped, no per-user scope — a manager digest). The
// renderer below is shape-agnostic so adding a report here is a one-liner.
const REPORTS: Record<string, ReportDef> = {
  summary:    { label: 'CRM summary (KPIs)',      run: (o, c, r) => analytics.dashboardSummary(o, r, c) },
  win_loss:   { label: 'Win / loss by rep',       run: (o, c, r) => analytics.winRate(o, 'rep', r, c) },
  forecast:   { label: 'Pipeline forecast',       run: (o, c, r) => analytics.forecast(o, 'quarter', r, c) },
  pipeline:   { label: 'Pipeline value by stage', run: (o, c)    => analytics.pipelineValue(o, undefined, c) },
  funnel:     { label: 'Lead → deal funnel',      run: (o, c, r) => analytics.funnel(o, 30, r, c) },
  at_risk:    { label: 'Leads at risk',           run: (o, c)    => analyticsExt.leadsAtRisk(o, c, 60, 14) },
  stuck:      { label: 'Stuck leads',             run: (o, c)    => analyticsExt.stuckLeads(o, c) },
  lead_aging: { label: 'Lead aging',              run: (o, c)    => analyticsExt.leadAging(o, c) },
};

/** Report keys + labels for the dashboard builder dropdown. */
export function reportCatalog(): Array<{ key: string; label: string }> {
  return Object.entries(REPORTS).map(([key, d]) => ({ key, label: d.label }));
}

export function isValidReportKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(REPORTS, key);
}

// ── Schedule CRUD ──────────────────────────────────────────────────────────

export interface ReportScheduleInput {
  org_id: string;
  client_id: string | null;
  created_by: string | null;
  name: string;
  report_key: string;
  config?: Record<string, unknown> | null;
  frequency: Frequency;
  send_hour: number;            // 0-23, UTC
  day_of_week?: number | null;  // 0=Sun..6=Sat (weekly)
  day_of_month?: number | null; // 1-28 (monthly)
  to_emails: string[];
  is_active?: boolean;
}

export async function createSchedule(input: ReportScheduleInput) {
  if (!isValidReportKey(input.report_key)) {
    throw new AppError(400, `Unknown report "${input.report_key}"`, 'BAD_REPORT');
  }
  if (!input.to_emails?.length) {
    throw new AppError(400, 'At least one recipient is required', 'VALIDATION');
  }
  const next = computeNextRun(input.frequency, input.send_hour, input.day_of_week ?? null, input.day_of_month ?? null);
  const { data, error } = await supabaseAdmin
    .from('crm_report_schedules')
    .insert({
      org_id: input.org_id,
      client_id: input.client_id,
      created_by: input.created_by,
      name: (input.name || '').trim().slice(0, 200) || 'Untitled digest',
      report_key: input.report_key,
      config: input.config ?? null,
      frequency: input.frequency,
      send_hour: input.send_hour,
      day_of_week: input.day_of_week ?? null,
      day_of_month: input.day_of_month ?? null,
      to_emails: input.to_emails,
      is_active: input.is_active ?? true,
      next_run_at: next,
    })
    .select('*')
    .single();
  if (error || !data) throw new AppError(500, error?.message || 'Insert failed', 'DB_ERROR');
  return data;
}

export async function listSchedules(org_id: string, client_id: string | null) {
  let q = supabaseAdmin
    .from('crm_report_schedules')
    .select('*')
    .eq('org_id', org_id)
    .order('created_at', { ascending: false });
  if (client_id) q = q.eq('client_id', client_id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function updateSchedule(org_id: string, id: string, patch: Partial<ReportScheduleInput>) {
  if (patch.report_key && !isValidReportKey(patch.report_key)) {
    throw new AppError(400, `Unknown report "${patch.report_key}"`, 'BAD_REPORT');
  }
  // Re-fetch so we can recompute next_run_at off the merged cadence fields.
  const { data: existing } = await supabaseAdmin
    .from('crm_report_schedules').select('*').eq('org_id', org_id).eq('id', id).maybeSingle();
  if (!existing) throw new AppError(404, 'Schedule not found', 'NOT_FOUND');
  const e = existing as any;

  const merged = {
    frequency: (patch.frequency ?? e.frequency) as Frequency,
    send_hour: patch.send_hour ?? e.send_hour,
    day_of_week: patch.day_of_week ?? e.day_of_week,
    day_of_month: patch.day_of_month ?? e.day_of_month,
  };

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) update.name = (patch.name || '').trim().slice(0, 200) || 'Untitled digest';
  if (patch.report_key !== undefined) update.report_key = patch.report_key;
  if (patch.config !== undefined) update.config = patch.config;
  if (patch.frequency !== undefined) update.frequency = patch.frequency;
  if (patch.send_hour !== undefined) update.send_hour = patch.send_hour;
  if (patch.day_of_week !== undefined) update.day_of_week = patch.day_of_week;
  if (patch.day_of_month !== undefined) update.day_of_month = patch.day_of_month;
  if (patch.to_emails !== undefined) update.to_emails = patch.to_emails;
  if (patch.is_active !== undefined) update.is_active = patch.is_active;

  // Any cadence change (or re-activation) recomputes the next fire time.
  if (patch.frequency !== undefined || patch.send_hour !== undefined ||
      patch.day_of_week !== undefined || patch.day_of_month !== undefined ||
      patch.is_active === true) {
    update.next_run_at = computeNextRun(merged.frequency, merged.send_hour, merged.day_of_week ?? null, merged.day_of_month ?? null);
  }

  const { data, error } = await supabaseAdmin
    .from('crm_report_schedules').update(update).eq('org_id', org_id).eq('id', id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function deleteSchedule(org_id: string, id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('crm_report_schedules').delete().eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

// ── Render + dispatch ──────────────────────────────────────────────────────

function rangeForFrequency(freq: Frequency): Range {
  const days = freq === 'daily' ? 1 : freq === 'weekly' ? 7 : 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function renderDigest(schedule: any): Promise<{ subject: string; html: string }> {
  const def = REPORTS[schedule.report_key];
  if (!def) throw new AppError(400, `Unknown report "${schedule.report_key}"`, 'BAD_REPORT');
  const data = await def.run(schedule.org_id, schedule.client_id ?? null, rangeForFrequency(schedule.frequency));
  const today = new Date().toISOString().slice(0, 10);
  const title = schedule.name || def.label;
  return { subject: `${title} — ${today}`, html: digestHtml(title, def.label, today, data) };
}

/** Cron / in-process entry — dispatch every active schedule now due. */
export async function runDueReportDigests(limit = 25): Promise<{ checked: number; sent: number }> {
  const nowIso = new Date().toISOString();
  const { data } = await supabaseAdmin
    .from('crm_report_schedules')
    .select('*')
    .eq('is_active', true)
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(limit);
  const rows = (data ?? []) as any[];

  let sent = 0;
  for (const s of rows) {
    try {
      const { subject, html } = await renderDigest(s);
      for (const to of (s.to_emails as string[])) {
        try {
          await sendEmail({ org_id: s.org_id, user_id: s.created_by ?? undefined, to, subject, body_html: html, bypass_suppression: true });
        } catch (err) {
          // Per-recipient failure is logged in crm_email_logs; keep going.
          void err;
        }
      }
      sent++;
    } catch (err: any) {
      logger.warn(`[report-digests] ${s.id} render/send failed: ${err?.message || err}`);
    }
    // Always roll forward so a failing schedule doesn't re-fire every tick.
    const next = computeNextRun(s.frequency, s.send_hour, s.day_of_week ?? null, s.day_of_month ?? null);
    await supabaseAdmin
      .from('crm_report_schedules')
      .update({ last_run_at: nowIso, next_run_at: next })
      .eq('id', s.id);
  }
  return { checked: rows.length, sent };
}

/**
 * Next UTC fire time for a cadence, strictly after `from`. day_of_month is
 * clamped to 1-28 by the validator so we never skip a short month.
 */
export function computeNextRun(
  freq: Frequency,
  hourUtc: number,
  dow: number | null,
  dom: number | null,
  from: Date = new Date()
): string {
  const c = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc, 0, 0, 0));

  if (freq === 'daily') {
    if (c <= from) c.setUTCDate(c.getUTCDate() + 1);
  } else if (freq === 'weekly') {
    const target = dow ?? 1;
    let guard = 0;
    while ((c.getUTCDay() !== target || c <= from) && guard++ < 8) {
      c.setUTCDate(c.getUTCDate() + 1);
    }
  } else {
    const target = Math.min(Math.max(dom ?? 1, 1), 28);
    c.setUTCDate(target);
    if (c <= from) {
      c.setUTCMonth(c.getUTCMonth() + 1);
      c.setUTCDate(target);
    }
  }
  return c.toISOString();
}

// ── HTML rendering (shape-agnostic) ────────────────────────────────────────

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function humanize(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(v);
}

/** Render any analytics return value into an HTML table. */
function toHtmlTable(data: unknown): string {
  const cell = 'padding:8px 12px;border-bottom:1px solid #eceff3;font-size:13px;';
  const th = 'padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #e5e7eb;';

  if (Array.isArray(data)) {
    if (data.length === 0) return '<p style="color:#6b7280;font-size:13px;">No data for this period.</p>';
    if (typeof data[0] !== 'object' || data[0] === null) {
      return `<table style="border-collapse:collapse;width:100%;">${data.map((v) => `<tr><td style="${cell}">${fmtCell(v)}</td></tr>`).join('')}</table>`;
    }
    const cols = Array.from(new Set(data.flatMap((r) => Object.keys(r as object))));
    const head = `<tr>${cols.map((c) => `<th style="${th}">${esc(humanize(c))}</th>`).join('')}</tr>`;
    const body = (data as Array<Record<string, unknown>>)
      .slice(0, 100)
      .map((r) => `<tr>${cols.map((c) => `<td style="${cell}">${fmtCell(r[c])}</td>`).join('')}</tr>`)
      .join('');
    return `<table style="border-collapse:collapse;width:100%;">${head}${body}</table>`;
  }

  if (data && typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (!entries.length) return '<p style="color:#6b7280;font-size:13px;">No data for this period.</p>';
    const body = entries
      .map(([k, v]) => `<tr><td style="${cell}font-weight:600;color:#374151;">${esc(humanize(k))}</td><td style="${cell}">${fmtCell(v)}</td></tr>`)
      .join('');
    return `<table style="border-collapse:collapse;width:100%;">${body}</table>`;
  }

  return `<p style="font-size:13px;">${fmtCell(data)}</p>`;
}

function digestHtml(title: string, reportLabel: string, dateStr: string, data: unknown): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f6f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#6366F1,#8B5CF6);padding:20px 24px;color:#fff;">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Kinematic CRM · Scheduled digest</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;">${esc(title)}</div>
        <div style="font-size:13px;opacity:.9;margin-top:2px;">${esc(reportLabel)} · ${esc(dateStr)}</div>
      </div>
      <div style="padding:18px 24px;">
        ${toHtmlTable(data)}
      </div>
    </div>
    <div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:14px;">
      You're receiving this because a scheduled report digest was set up in Kinematic CRM.
    </div>
  </div></body></html>`;
}

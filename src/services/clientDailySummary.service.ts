/**
 * The 7 pm manager summary on WhatsApp (Client Management → WhatsApp alerts → "Daily summary").
 *
 * Once a day, for every client that switched it on, the same people who get the client's WhatsApp alerts receive one
 * message covering the field team's day:
 *   attendance (present / on leave / absent), planned visits done, orders booked and their value, new leads, the top
 *   three reps by visits, reps who are checked in but have no visits, and check-ins worth a second look (mock GPS,
 *   failed face match, impossible jumps in location, off-route visits).
 *
 * "Today" is the IST day. Figures come from the same loaders as the FFM analytics screens (controllers/analytics/
 * ffm-plus.data.ts). Each figure is best-effort: a section whose data can't be read is left out, never guessed.
 *
 * Exactly one summary per client per day, even with several backend instances: the sender first claims
 * (org_id, summary_date) in client_daily_summary_log, whose unique index makes the second claim fail. Where that table
 * does not exist, nothing is sent (it is created on boot for the Kinematic project by lib/autoMigrate).
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import {
  type FfmScope, loadReps, loadPlans, loadSecurityAlerts, loadSuspectPings, todayIst, addDaysYmd,
} from '../controllers/analytics/ffm-plus.data';
import { collapseStops, type RepLite, type Stop } from '../controllers/analytics/ffm-plus.compute';
import {
  WA_SETTING_KEY, toSettings, sendToRecipients, alertsActive, AlertSettingsError, type SendOutcome,
} from './clientWhatsappAlerts.service';
import { isProjectDisabled } from './notificationPolicy';

const DEFAULT_GEOFENCE_M = 100;
const LIST_MAX = 3;

export interface AttendanceRow {
  user_id: string;
  status: string | null;
  checkin_at: string | null;
  checkin_is_mock?: boolean | null;
  checkin_face_verified?: boolean | null;
}

export interface SummaryInput {
  date: string;
  reps: RepLite[];
  attendance: AttendanceRow[] | null;
  stops: Stop[] | null;
  orders: { count: number; value: number } | null;
  newLeads: number | null;
  /** user_id → teleport pings today. */
  teleports: Map<string, number> | null;
  /** user_id → app-reported mock-location alerts today. */
  mockAlerts: Map<string, number> | null;
}

export interface DailySummary {
  date: string;
  reps: number;
  attendance: { present: number; on_leave: number; absent: number } | null;
  visits: { planned: number; done: number; pct: number; off_route: number } | null;
  orders: { count: number; value: number } | null;
  new_leads: number | null;
  top: Array<{ name: string; visits: number }>;
  no_visits: string[];
  suspicious: string[];
}

const ABSENT = new Set(['absent', 'on_leave']);

/** Pure: turn the day's raw rows into the summary's figures. */
export function computeSummary(i: SummaryInput): DailySummary {
  const repIds = new Set(i.reps.map((r) => r.id));
  const nameOf = new Map(i.reps.map((r) => [r.id, r.name]));
  const present = new Set<string>();
  let onLeave = 0;
  let attendance: DailySummary['attendance'] = null;
  if (i.attendance) {
    for (const a of i.attendance) {
      if (!repIds.has(a.user_id)) continue;
      const st = String(a.status ?? '').toLowerCase();
      if (st === 'on_leave') onLeave++;
      else if (a.checkin_at && !ABSENT.has(st)) present.add(a.user_id);
    }
    attendance = { present: present.size, on_leave: onLeave, absent: Math.max(0, i.reps.length - present.size - onLeave) };
  }

  let visits: DailySummary['visits'] = null;
  const done = new Map<string, number>();
  const planned = new Map<string, number>();
  if (i.stops) {
    const calls = collapseStops(i.stops.filter((s) => s.plan_date === i.date && repIds.has(s.user_id)));
    let doneTotal = 0;
    let offRoute = 0;
    for (const c of calls) {
      planned.set(c.user_id, (planned.get(c.user_id) ?? 0) + 1);
      // The mobile check-in mirror stamps checkin_at without moving status, so either counts as a visit.
      if (c.visited || c.checkin_at) {
        doneTotal++;
        done.set(c.user_id, (done.get(c.user_id) ?? 0) + 1);
        const limit = c.geofence_radius_m ?? DEFAULT_GEOFENCE_M;
        if (c.checkin_distance_m != null && c.checkin_distance_m > limit) offRoute++;
      }
    }
    visits = { planned: calls.length, done: doneTotal, pct: calls.length ? Math.round((doneTotal / calls.length) * 100) : 0, off_route: offRoute };
  }

  const top = [...done.entries()]
    .sort((a, b) => b[1] - a[1] || String(nameOf.get(a[0])).localeCompare(String(nameOf.get(b[0]))))
    .slice(0, LIST_MAX)
    .map(([id, n]) => ({ name: nameOf.get(id) ?? 'Rep', visits: n }));

  // Checked in, had visits planned, and has done none: the people a manager should call.
  const noVisits = i.stops
    ? [...present].filter((id) => (planned.get(id) ?? 0) > 0 && !done.has(id)).map((id) => nameOf.get(id) ?? 'Rep').sort()
    : [];

  const flagged = new Set<string>();
  for (const a of i.attendance ?? []) {
    if (!repIds.has(a.user_id)) continue;
    if (a.checkin_is_mock === true || (a.checkin_at && a.checkin_face_verified === false)) flagged.add(a.user_id);
  }
  for (const [id, n] of i.teleports ?? []) if (n > 0 && repIds.has(id)) flagged.add(id);
  for (const [id, n] of i.mockAlerts ?? []) if (n > 0 && repIds.has(id)) flagged.add(id);

  return {
    date: i.date,
    reps: i.reps.length,
    attendance,
    visits,
    orders: i.orders,
    new_leads: i.newLeads,
    top,
    no_visits: noVisits,
    suspicious: [...flagged].map((id) => nameOf.get(id) ?? 'Rep').sort(),
  };
}

/** ₹45,200 · ₹3.2L · ₹1.4Cr */
export function inr(v: number): string {
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(1).replace(/\.0$/, '')}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1).replace(/\.0$/, '')}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const names = (xs: string[]) => (xs.length > LIST_MAX ? `${xs.slice(0, LIST_MAX).join(', ')} +${xs.length - LIST_MAX} more` : xs.join(', '));

/** True when the day has nothing worth sending (no team, no orders, no leads). */
export const isEmptyDay = (s: DailySummary): boolean => s.reps === 0 && !(s.orders?.count) && !(s.new_leads);

/**
 * The template's two values. WhatsApp template values can't hold line breaks, so the details are one line of
 * "·"-separated parts, most important first.
 */
export function formatSummary(s: DailySummary): { title: string; body: string } {
  const d = new Date(`${s.date}T00:00:00Z`); // a plain calendar day; read back in UTC so the server's zone can't shift it
  const day = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const parts: string[] = [];
  if (s.attendance && s.reps) {
    const extra = [s.attendance.on_leave ? `${s.attendance.on_leave} on leave` : '', s.attendance.absent ? `${s.attendance.absent} absent` : ''].filter(Boolean).join(', ');
    parts.push(`Attendance ${s.attendance.present}/${s.reps} present${extra ? `, ${extra}` : ''}`);
  }
  if (s.visits && s.visits.planned) parts.push(`Visits ${s.visits.done}/${s.visits.planned} done (${s.visits.pct}%)`);
  if (s.orders) parts.push(s.orders.count ? `Orders ${s.orders.count} worth ${inr(s.orders.value)}` : 'No orders');
  if (s.new_leads != null) parts.push(`New leads ${s.new_leads}`);
  if (s.top.length) parts.push(`Top: ${s.top.map((t) => `${t.name} ${t.visits}`).join(', ')}`);
  if (s.no_visits.length) parts.push(`No visits yet: ${names(s.no_visits)}`);
  const check: string[] = [];
  if (s.suspicious.length) check.push(`suspicious check-ins by ${names(s.suspicious)}`);
  if (s.visits?.off_route) check.push(`${s.visits.off_route} off-route visit${s.visits.off_route === 1 ? '' : 's'}`);
  if (check.length) parts.push(`Check: ${check.join(', ')}`);
  return { title: `Daily summary, ${day}`, body: parts.join(' · ') || 'No field activity recorded today' };
}

// ── loading ────────────────────────────────────────────────────────────────────────────────────────────────────

async function soft<T>(label: string, orgId: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    logger.warn(`[daily-summary] ${label} unavailable org=${orgId}: ${e?.message || e}`);
    return null;
  }
}

async function loadAttendanceToday(orgId: string, date: string): Promise<AttendanceRow[]> {
  const withFlags = await supabaseAdmin.from('attendance')
    .select('user_id, status, checkin_at, checkin_is_mock, checkin_face_verified')
    .eq('org_id', orgId).eq('date', date).limit(5000);
  if (!withFlags.error) return (withFlags.data ?? []) as AttendanceRow[];
  // A project without the integrity columns still gets attendance, just no mock / face flags.
  const plain = await supabaseAdmin.from('attendance').select('user_id, status, checkin_at').eq('org_id', orgId).eq('date', date).limit(5000);
  if (plain.error) throw new Error(plain.error.message);
  return (plain.data ?? []) as AttendanceRow[];
}

async function loadOrdersToday(orgId: string, date: string): Promise<{ count: number; value: number }> {
  const { data, error } = await supabaseAdmin.from('orders').select('grand_total')
    .eq('org_id', orgId).not('status', 'in', '(cancelled,draft)')
    .gte('placed_at', `${date}T00:00:00+05:30`).lt('placed_at', `${addDaysYmd(date, 1)}T00:00:00+05:30`).limit(10000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ grand_total: number | string | null }>;
  return { count: rows.length, value: rows.reduce((t, r) => t + (Number(r.grand_total) || 0), 0) };
}

async function countLeadsToday(orgId: string, date: string): Promise<number> {
  const { count, error } = await supabaseAdmin.from('crm_leads').select('id', { count: 'exact', head: true })
    .eq('org_id', orgId).is('deleted_at', null)
    .gte('created_at', `${date}T00:00:00+05:30`).lt('created_at', `${addDaysYmd(date, 1)}T00:00:00+05:30`);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Build one client's summary for an IST day. Runs in the CURRENT project. */
export async function buildDailySummary(orgId: string, date: string = todayIst()): Promise<DailySummary> {
  const scope: FfmScope = { orgId, clientId: null, scopeIds: null };
  const reps = (await soft('reps', orgId, () => loadReps(scope))) ?? [];
  const ids = new Set(reps.map((r) => r.id));
  const [attendance, plans, orders, newLeads, teleports, alerts] = await Promise.all([
    soft('attendance', orgId, () => loadAttendanceToday(orgId, date)),
    soft('visits', orgId, () => loadPlans(scope, ids, date, date)),
    soft('orders', orgId, () => loadOrdersToday(orgId, date)),
    soft('leads', orgId, () => countLeadsToday(orgId, date)),
    soft('teleports', orgId, () => loadSuspectPings(scope, ids, date, date)),
    soft('security alerts', orgId, () => loadSecurityAlerts(scope, ids, date, date)),
  ]);
  const mockAlerts = alerts ? new Map([...alerts].map(([id, c]) => [id, c.mock_location])) : null;
  return computeSummary({ date, reps, attendance, stops: plans?.stops ?? null, orders, newLeads, teleports, mockAlerts });
}

// ── sending ────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Send today's summary now" from the settings screen: today's figures so far, to the saved people. No claim. */
export async function sendSummaryNow(orgId: string): Promise<SendOutcome[]> {
  const { data } = await supabaseAdmin.from('org_settings').select('value').eq('org_id', orgId).eq('key', WA_SETTING_KEY).maybeSingle();
  const s = toSettings((data as { value?: unknown } | null)?.value);
  if (!s.template_id) throw new AlertSettingsError('Save a template first, then send the summary.');
  if (!s.recipients.length) throw new AlertSettingsError('Save at least one person first, then send the summary.');
  const { title, body } = formatSummary(await buildDailySummary(orgId));
  return sendToRecipients(orgId, s, title, body);
}

export interface SummaryRunResult { clients: number; sent: number; skipped_already_sent: number; skipped_empty: number; failed: number }

/**
 * Send today's summary to every client in the current project that has it switched on. Safe to call repeatedly and
 * from several instances: each (client, day) is claimed once in client_daily_summary_log before anything is sent.
 */
export async function runDailySummaries(date: string = todayIst()): Promise<SummaryRunResult> {
  const out: SummaryRunResult = { clients: 0, sent: 0, skipped_already_sent: 0, skipped_empty: 0, failed: 0 };
  if (!alertsActive() || isProjectDisabled()) return out;
  const { data, error } = await supabaseAdmin.from('org_settings').select('org_id, value').eq('key', WA_SETTING_KEY).limit(5000);
  if (error) { logger.warn(`[daily-summary] settings read failed: ${error.message}`); return out; }

  for (const row of (data ?? []) as Array<{ org_id: string; value: unknown }>) {
    const s = toSettings(row.value);
    if (!s.enabled || !s.daily_summary || !s.template_id || !s.recipients.length) continue;
    out.clients++;
    const claim = await supabaseAdmin.from('client_daily_summary_log').insert({ org_id: row.org_id, summary_date: date });
    if (claim.error) {
      // 23505 = another run already sent it today. Anything else (e.g. table missing) also means: don't send.
      if ((claim.error as { code?: string }).code !== '23505') logger.warn(`[daily-summary] claim failed org=${row.org_id}: ${claim.error.message}`);
      out.skipped_already_sent++;
      continue;
    }
    try {
      const summary = await buildDailySummary(row.org_id, date);
      if (isEmptyDay(summary)) { out.skipped_empty++; continue; }
      const { title, body } = formatSummary(summary);
      const res = await sendToRecipients(row.org_id, s, title, body);
      if (res.some((r) => r.status === 'sent')) out.sent++; else out.failed++;
      const failed = res.filter((r) => r.status === 'failed');
      if (failed.length) logger.warn(`[daily-summary] ${failed.length}/${res.length} failed org=${row.org_id}: ${failed[0].error}`);
    } catch (e: any) {
      out.failed++;
      logger.error(`[daily-summary] org=${row.org_id} failed: ${e?.message || e}`);
    }
  }
  return out;
}

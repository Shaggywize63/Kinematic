/**
 * The catalogue of notifications the platform can send — the list every client is offered.
 *
 * Nothing here is sent by itself: a client receives a notification only when its kind is switched on for that
 * client (Client Management → Notifications; stored per org in org_settings `notifications.enabled_kinds`), and
 * by default NOTHING is on. See services/notificationPolicy.ts for how it is applied and docs/NOTIFICATIONS.md
 * for what fires each kind.
 *
 * `kind` is the same discriminator the apps route taps on (lib/notificationRoute.ts `notificationKind`), so one
 * string identifies a notification everywhere: the row, the push payload, the app and this list.
 */

export type NotificationGroup = 'CRM' | 'FieldForce' | 'Distribution' | 'System';

export interface CatalogEntry {
  kind: string;
  label: string;
  group: NotificationGroup;
  description: string;
  /** Other `kind` strings that older writers produce for the same notification. */
  aliases?: string[];
  /** Safety-related: worth switching on for every client that has field staff. Still OFF until switched on. */
  recommended?: boolean;
}

export const NOTIFICATION_CATALOG: CatalogEntry[] = [
  // ── Lead management (CRM) ──────────────────────────────────────────────────────────────────────────────────
  { kind: 'lead_assigned', label: 'Lead assigned to me', group: 'CRM', description: 'A lead is created for, or reassigned to, a rep.' },
  { kind: 'new_lead', label: 'New lead captured', group: 'CRM', description: 'A new lead arrives from a form, import or integration.' },
  { kind: 'lead_pending_approval', label: 'Lead awaiting approval', group: 'CRM', description: 'A captured lead needs a supervisor or admin to approve it.' },
  { kind: 'lead_approval_decided', label: 'Lead approval decision', group: 'CRM', description: 'The lead creator is told the lead was approved or rejected.' },
  { kind: 'lead_from_google_ads', label: 'Google Ads lead', group: 'CRM', description: 'An inbound Google Ads lead was received.' },
  { kind: 'conversation_ready', label: 'Call insights ready', group: 'CRM', description: 'A recorded call finished analysis.' },
  {
    kind: 'crm_lead_stagnant', label: 'Stagnant lead reminders', group: 'CRM',
    description: 'A lead has had no activity for too long (and its escalations).',
    aliases: ['crm_lead_stagnant_escalation', 'crm_lead_escalation'],
  },
  { kind: 'deal_assigned', label: 'Deal assigned to me', group: 'CRM', description: 'A deal is created for, or reassigned to, a rep.' },
  { kind: 'deal_won', label: 'Deal won', group: 'CRM', description: 'A deal moved to a Won stage.' },
  { kind: 'deal_lost', label: 'Deal lost', group: 'CRM', description: 'A deal moved to a Lost stage.' },
  { kind: 'deal_stage_changed', label: 'Deal stage changed', group: 'CRM', description: 'A deal moved to another stage.' },
  { kind: 'crm_deal_closing_soon', label: 'Deal closing soon', group: 'CRM', description: 'A deal is approaching its expected close date.' },
  { kind: 'crm_deal_overdue', label: 'Deal overdue', group: 'CRM', description: 'A deal passed its expected close date.' },
  { kind: 'activity_assigned', label: 'Activity assigned', group: 'CRM', description: 'A call, meeting or task was assigned.' },
  { kind: 'crm_task_overdue', label: 'Activity due / overdue', group: 'CRM', description: 'A scheduled activity is due or overdue.' },
  { kind: 'automation', label: 'Automation notifications', group: 'CRM', description: 'A "send notification" action configured in an automation.' },
  {
    kind: 'crm_home', label: 'Daily home summary', group: 'CRM',
    description: 'The 9 AM summary of new leads, open leads and activities due.',
    aliases: ['daily_briefing'],
  },
  { kind: 'kini_reminder', label: 'KINI reminders', group: 'CRM', description: 'Reminders a user set through the KINI assistant.' },
  { kind: 'kini_cold_deals', label: 'KINI: cold deals', group: 'CRM', description: 'KINI nudge about deals going cold.' },
  { kind: 'kini_no_checkin', label: 'KINI: no check-in today', group: 'CRM', description: 'KINI nudge that a rep has not checked in.' },
  { kind: 'message', label: 'Chat messages', group: 'CRM', description: 'Direct and team chat messages.' },
  { kind: 'mention', label: '@mentions', group: 'CRM', description: 'Someone mentioned a user in a chat or a lead update.' },

  // ── Field force ───────────────────────────────────────────────────────────────────────────────────────────
  { kind: 'sos', label: 'SOS / panic alert', group: 'FieldForce', description: 'A field user raised an SOS.', recommended: true },
  { kind: 'location_off', label: 'Location turned off', group: 'FieldForce', description: 'A rep turned location tracking off or denied it.' },
  { kind: 'missed_visits', label: 'Missed planned visits', group: 'FieldForce', description: 'Outlets on a past beat were never checked into.' },
  { kind: 'route_deviation', label: 'Off-route visit', group: 'FieldForce', description: 'A check-in happened beyond the outlet geofence.' },
  { kind: 'checkout_reminder', label: 'Forgot to check out', group: 'FieldForce', description: 'A shift is still open 10 hours after check-in.' },
  { kind: 'att_reg_request', label: 'Attendance regularization request', group: 'FieldForce', description: 'A rep asked to correct an attendance record.' },
  { kind: 'att_reg_decision', label: 'Attendance regularization decision', group: 'FieldForce', description: 'The request was approved or rejected.' },
  { kind: 'leave_request', label: 'Leave request', group: 'FieldForce', description: 'A leave request is waiting for the approver.' },
  { kind: 'leave_cancelled', label: 'Leave cancelled', group: 'FieldForce', description: 'A leave request was cancelled.' },
  { kind: 'leave_decision', label: 'Leave decision', group: 'FieldForce', description: 'A leave request was approved or rejected.' },
  { kind: 'expense_submitted', label: 'Expense submitted', group: 'FieldForce', description: 'An expense claim is waiting for the approver.' },
  { kind: 'expense_decision', label: 'Expense decision', group: 'FieldForce', description: 'An expense claim was approved or rejected.' },
  { kind: 'expense_escalated', label: 'Expense escalated', group: 'FieldForce', description: 'An expense claim moved up to the next approver.' },
  { kind: 'expense_reimbursed', label: 'Expense reimbursed', group: 'FieldForce', description: 'An expense claim was paid.' },
  { kind: 'expense_cancelled', label: 'Expense cancelled', group: 'FieldForce', description: 'An expense claim was cancelled.' },

  // ── Supply chain / distribution ───────────────────────────────────────────────────────────────────────────
  { kind: 'order_assigned', label: 'Order assigned to me', group: 'Distribution', description: 'An admin created and assigned an order to a field user.', recommended: true },
  { kind: 'low_stock', label: 'Low stock', group: 'Distribution', description: 'SKUs are running low against projected demand.' },
  { kind: 'stock_expiry', label: 'Stock nearing expiry', group: 'Distribution', description: 'A stock batch is inside its expiry alert window.' },

  // ── System ────────────────────────────────────────────────────────────────────────────────────────────────
  { kind: 'broadcast', label: 'Broadcasts', group: 'System', description: 'Questions and announcements sent by an admin.' },
  { kind: 'security_alert', label: 'Security alerts', group: 'System', description: 'Suspicious sign-in and similar account alerts.', recommended: true },
  { kind: 'finance_invoice_due', label: 'Invoice reminders', group: 'System', description: 'An invoice is due or overdue.' },
];

const byKind = new Map<string, CatalogEntry>();
for (const e of NOTIFICATION_CATALOG) {
  byKind.set(e.kind, e);
  for (const a of e.aliases ?? []) byKind.set(a, e);
}

/** Every kind string the catalogue knows, including aliases. */
export const isKnownKind = (kind: string): boolean => byKind.has(kind);

/** The catalogue kind a (possibly aliased) kind belongs to; an unknown kind comes back unchanged. */
export const canonicalKind = (kind: string): string => byKind.get(kind)?.kind ?? kind;

/** The wildcard stored when a client has every notification switched on. */
export const ALL_KINDS = '*';

/** Normalise what a caller wants stored: unique catalogue kinds (aliases folded) or the wildcard. Throws on an unknown kind. */
export function parseEnabledKinds(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('enabled_kinds must be an array');
  const out = new Set<string>();
  for (const raw of input) {
    const k = String(raw ?? '').trim();
    if (!k) continue;
    if (k === ALL_KINDS) return [ALL_KINDS];
    if (!byKind.has(k)) throw new Error(`Unknown notification kind: ${k}`);
    out.add(canonicalKind(k));
  }
  return [...out];
}

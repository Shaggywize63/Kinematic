/**
 * WhatsApp alerts per client (Client Management → WhatsApp alerts).
 *
 * A client can pick a few people (owner, ops head, regional managers) to get the client's important updates on
 * WhatsApp as well as in the app: an SOS, a new lead, a leave or expense waiting for approval, low stock and so on.
 *
 * Stored per org in org_settings `notifications.whatsapp`, on the org that holds the client's users, the same place
 * as the in-app catalogue (services/notificationPolicy.ts):
 *   { enabled, template_id, recipients: [{ name, phone }], kinds: [...], daily_summary }
 *
 * `daily_summary` adds the 7 pm manager summary (services/clientDailySummary.service.ts) to the same people.
 *
 * Delivery piggybacks on the push dispatcher (services/notifications.service.ts): every notification row that is
 * allowed through the in-app policy is offered here, so every writer is covered without being touched. One event
 * often creates a row per manager, so rows are grouped per event and each event is sent once per recipient.
 *
 * Messages go out from the client's own WhatsApp connection (CRM Settings → WhatsApp) using an approved template the
 * client picks, because WhatsApp only lets a business start a conversation with a template. Off by default; nothing
 * is sent for a client until an admin switches it on. Projects with notifications switched off (Tata, by default)
 * send nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase';
import { currentProjectKey } from '../lib/projects';
import { logger } from '../lib/logger';
import { canonicalKind, NOTIFICATION_CATALOG } from '../lib/notificationCatalog';
import { isProjectDisabled, readOrgSettings } from './notificationPolicy';
import { sendWhatsapp } from './crm/whatsapp.service';

export const WA_SETTING_KEY = 'notifications.whatsapp';
export const MAX_RECIPIENTS = 10;
/** Most messages one client gets from one dispatcher run, so a scan that raises 200 alerts can't flood a phone. */
export const MAX_EVENTS_PER_ORG_PER_RUN = 10;
const TTL_MS = 60_000;
const DEDUP_MS = 15 * 60_000;

/**
 * The catalogue kinds that make sense on a manager's WhatsApp: team-level events, not ones addressed to a single rep
 * ("a lead was assigned to you", "your leave was approved").
 */
export const WHATSAPP_KINDS: string[] = [
  'new_lead', 'lead_pending_approval', 'lead_from_google_ads', 'deal_won', 'deal_lost', 'crm_deal_overdue',
  'sos', 'tracking_paused', 'location_off', 'missed_visits', 'route_deviation',
  'att_reg_request', 'leave_request', 'expense_submitted',
  'low_stock', 'stock_expiry',
  'finance_invoice_due',
];
const WA_KIND_SET = new Set(WHATSAPP_KINDS);

/** The template we suggest clients get approved in WhatsApp Manager (Utility, so Meta doesn't rate-limit it). */
export const SUGGESTED_TEMPLATE = {
  name: 'kinematic_alert',
  category: 'UTILITY',
  language: 'en',
  body: 'Kinematic update for your team: {{1}}. Details: {{2}}. Open the Kinematic app to see more and take action.',
};

export interface Recipient { name: string; phone: string }
export interface WhatsappAlertSettings {
  enabled: boolean;
  template_id: string | null;
  recipients: Recipient[];
  kinds: string[];
  /** Also send the end-of-day manager summary (services/clientDailySummary.service.ts). */
  daily_summary: boolean;
}

const EMPTY: WhatsappAlertSettings = { enabled: false, template_id: null, recipients: [], kinds: [], daily_summary: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Digits only, with India's 91 added to a 10-digit number. Null when it can't be a WhatsApp number. */
export function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const full = digits.length === 10 ? `91${digits}` : digits;
  return full.length >= 11 && full.length <= 15 ? full : null;
}

/** Whatever is stored, read back as valid settings (unknown kinds and bad numbers dropped). */
export function toSettings(value: unknown): WhatsappAlertSettings {
  if (!value || typeof value !== 'object') return { ...EMPTY };
  const v = value as Record<string, unknown>;
  const recipients: Recipient[] = [];
  for (const r of Array.isArray(v.recipients) ? v.recipients : []) {
    const phone = normalizePhone((r as Recipient)?.phone);
    if (phone && !recipients.some((x) => x.phone === phone)) recipients.push({ name: String((r as Recipient)?.name ?? '').trim().slice(0, 60), phone });
  }
  const kinds = [...new Set((Array.isArray(v.kinds) ? v.kinds : []).map((k) => canonicalKind(String(k))).filter((k) => WA_KIND_SET.has(k)))];
  const template_id = typeof v.template_id === 'string' && UUID.test(v.template_id) ? v.template_id : null;
  return { enabled: v.enabled === true, template_id, recipients: recipients.slice(0, MAX_RECIPIENTS), kinds, daily_summary: v.daily_summary === true };
}

export class AlertSettingsError extends Error {}

/** Validate what an admin wants saved. Throws AlertSettingsError with a message the UI can show as-is. */
export function parseSettingsInput(input: unknown): WhatsappAlertSettings {
  if (!input || typeof input !== 'object') throw new AlertSettingsError('Send the WhatsApp alert settings as an object.');
  const v = input as Record<string, unknown>;
  if (v.recipients !== undefined && !Array.isArray(v.recipients)) throw new AlertSettingsError('recipients must be a list.');
  if (v.kinds !== undefined && !Array.isArray(v.kinds)) throw new AlertSettingsError('kinds must be a list.');

  const recipients: Recipient[] = [];
  for (const r of (v.recipients as unknown[] | undefined) ?? []) {
    const name = String((r as Recipient)?.name ?? '').trim().slice(0, 60);
    const phone = normalizePhone((r as Recipient)?.phone);
    if (!phone) throw new AlertSettingsError(`"${String((r as Recipient)?.phone ?? '')}" is not a valid WhatsApp number. Use the full number with country code, e.g. 919876543210.`);
    if (!recipients.some((x) => x.phone === phone)) recipients.push({ name, phone });
  }
  if (recipients.length > MAX_RECIPIENTS) throw new AlertSettingsError(`Add at most ${MAX_RECIPIENTS} people.`);

  const kinds = new Set<string>();
  for (const raw of (v.kinds as unknown[] | undefined) ?? []) {
    const k = canonicalKind(String(raw ?? '').trim());
    if (!WA_KIND_SET.has(k)) throw new AlertSettingsError(`"${String(raw)}" can't be sent on WhatsApp.`);
    kinds.add(k);
  }

  let template_id: string | null = null;
  if (v.template_id !== undefined && v.template_id !== null && v.template_id !== '') {
    if (typeof v.template_id !== 'string' || !UUID.test(v.template_id)) throw new AlertSettingsError('template_id is not a valid template.');
    template_id = v.template_id;
  }

  const enabled = v.enabled === true;
  const daily_summary = v.daily_summary === true;
  if (enabled) {
    if (!template_id) throw new AlertSettingsError('Choose an approved WhatsApp template before switching alerts on.');
    if (!recipients.length) throw new AlertSettingsError('Add at least one person to receive alerts before switching them on.');
    if (!kinds.size && !daily_summary) throw new AlertSettingsError('Choose at least one update, or the daily summary, before switching alerts on.');
  }
  return { enabled, template_id, recipients, kinds: [...kinds], daily_summary };
}

// ── Templates ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Highest positional placeholder ({{1}}, {{2}}…) in a template body. */
export const placeholderCount = (body: string | null | undefined): number =>
  [...String(body ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].reduce((n, m) => Math.max(n, Number(m[1])), 0);

/** WhatsApp rejects template values with new lines, tabs or long runs of spaces, and caps their length. */
const flat = (s: string, max: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Map an alert onto the template's placeholders: {{1}} = title, {{2}} = details, any others = "-". */
export function templateVariables(placeholders: number, title: string, body: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (placeholders <= 0) return vars;
  if (placeholders === 1) { vars['1'] = flat(`${title}: ${body}`, 900); return vars; }
  vars['1'] = flat(title, 200) || 'Update';
  vars['2'] = flat(body, 700) || '-';
  for (let i = 3; i <= placeholders; i++) vars[String(i)] = '-';
  return vars;
}

interface TemplateRow { id: string; meta_template_name: string | null; language: string | null; category: string | null; status: string | null; body_text: string | null }

async function listTemplates(orgId: string, client: SupabaseClient): Promise<TemplateRow[]> {
  const { data, error } = await client.from('crm_whatsapp_templates')
    .select('id, meta_template_name, language, category, status, body_text')
    .eq('org_id', orgId).is('deleted_at', null).limit(200);
  if (error) {
    logger.warn(`[wa-alerts] template list failed org=${orgId}: ${error.message}`);
    return [];
  }
  return (data ?? []) as TemplateRow[];
}

const isApproved = (t: TemplateRow) => String(t.status ?? '').toUpperCase() === 'APPROVED';

// ── Management (read / write / test) ───────────────────────────────────────────────────────────────────────────

export interface WhatsappAlertView extends WhatsappAlertSettings {
  project_disabled: boolean;
  connection: { configured: boolean; active: boolean; from_phone: string | null; display_name: string | null };
  templates: Array<{ id: string; name: string; language: string; category: string; status: string; body: string; placeholders: number }>;
  catalog: Array<{ kind: string; label: string; group: string; description: string; enabled: boolean; in_app_enabled: boolean }>;
  suggested_template: typeof SUGGESTED_TEMPLATE;
}

export async function readAlertSettings(orgId: string, client: SupabaseClient = supabaseAdmin, project: string = currentProjectKey()): Promise<WhatsappAlertView> {
  const [{ data: row }, templates, inApp, conn] = await Promise.all([
    client.from('org_settings').select('value').eq('org_id', orgId).eq('key', WA_SETTING_KEY).maybeSingle(),
    listTemplates(orgId, client),
    readOrgSettings(orgId, client, project),
    client.from('crm_whatsapp_connections').select('is_active, from_phone, display_name').eq('org_id', orgId).maybeSingle(),
  ]);
  const s = toSettings((row as { value?: unknown } | null)?.value);
  const c = (conn as { data?: { is_active?: boolean; from_phone?: string | null; display_name?: string | null } | null })?.data ?? null;
  const inAppOn = new Set(inApp.enabled_kinds);
  const byKind = new Map(NOTIFICATION_CATALOG.map((e) => [e.kind, e]));
  return {
    ...s,
    project_disabled: isProjectDisabled(project),
    connection: { configured: !!c, active: !!c?.is_active, from_phone: c?.from_phone ?? null, display_name: c?.display_name ?? null },
    templates: templates.filter(isApproved).map((t) => ({
      id: t.id, name: String(t.meta_template_name ?? ''), language: String(t.language ?? ''), category: String(t.category ?? ''),
      status: String(t.status ?? ''), body: String(t.body_text ?? ''), placeholders: placeholderCount(t.body_text),
    })),
    catalog: WHATSAPP_KINDS.map((kind) => {
      const e = byKind.get(kind)!;
      return {
        kind, label: e.label, group: e.group, description: e.description,
        enabled: s.kinds.includes(kind), in_app_enabled: inApp.all || inAppOn.has(kind),
      };
    }),
    suggested_template: SUGGESTED_TEMPLATE,
  };
}

/** Replace the client's WhatsApp alert settings. Throws AlertSettingsError on bad input. */
export async function writeAlertSettings(orgId: string, input: unknown, updatedBy: string | null, client: SupabaseClient = supabaseAdmin): Promise<WhatsappAlertSettings> {
  const s = parseSettingsInput(input);
  if (s.template_id) {
    const t = (await listTemplates(orgId, client)).find((x) => x.id === s.template_id);
    if (!t) throw new AlertSettingsError('That template was not found for this client. Sync templates in CRM Settings → WhatsApp, then try again.');
    if (!isApproved(t)) throw new AlertSettingsError(`Template "${t.meta_template_name}" is not approved by WhatsApp yet.`);
  }
  await client.from('org_settings').delete().eq('org_id', orgId).eq('key', WA_SETTING_KEY);
  const { error } = await client.from('org_settings').insert({ org_id: orgId, key: WA_SETTING_KEY, value: s, updated_by: updatedBy });
  if (error) throw new Error(error.message);
  cache.delete(ck(orgId));
  return s;
}

export interface SendOutcome { phone: string; name: string; status: 'sent' | 'failed'; error: string | null }

/** Send one alert to every recipient. Runs in the CURRENT project (sendWhatsapp uses the project-scoped client). */
export async function sendToRecipients(orgId: string, s: WhatsappAlertSettings, title: string, body: string): Promise<SendOutcome[]> {
  if (!s.template_id) return [];
  const t = (await listTemplates(orgId, supabaseAdmin)).find((x) => x.id === s.template_id);
  const vars = templateVariables(placeholderCount(t?.body_text), title, body);
  const out: SendOutcome[] = [];
  for (const r of s.recipients) {
    try {
      const res = await sendWhatsapp({ org_id: orgId, to: r.phone, template_id: s.template_id, template_variables: vars });
      out.push({ phone: r.phone, name: r.name, status: res.status, error: res.error });
    } catch (e: any) {
      out.push({ phone: r.phone, name: r.name, status: 'failed', error: e?.message || 'send error' });
    }
  }
  return out;
}

/** "Send a test" from the settings screen: uses the SAVED settings, so it proves what alerts will look like. */
export async function sendTestAlert(orgId: string): Promise<SendOutcome[]> {
  const { data } = await supabaseAdmin.from('org_settings').select('value').eq('org_id', orgId).eq('key', WA_SETTING_KEY).maybeSingle();
  const s = toSettings((data as { value?: unknown } | null)?.value);
  if (!s.template_id) throw new AlertSettingsError('Save a template first, then send a test.');
  if (!s.recipients.length) throw new AlertSettingsError('Save at least one person first, then send a test.');
  return sendToRecipients(orgId, s, 'Test alert', 'WhatsApp alerts are set up. You will get the updates your admin chose here.');
}

// ── Delivery (called by the push dispatcher) ───────────────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; v: WhatsappAlertSettings }>();
const ck = (org: string) => `${currentProjectKey()}:${org}`;
const recentlySent = new Map<string, number>();

/** Test seam. */
export const _resetAlertState = (): void => { cache.clear(); recentlySent.clear(); };

/** On unless CLIENT_WHATSAPP_ALERTS=off; off under tests unless switched on, so unrelated dispatcher tests are untouched. */
export const alertsActive = (): boolean => {
  const v = (process.env.CLIENT_WHATSAPP_ALERTS || '').toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  return process.env.NODE_ENV !== 'test';
};

async function settingsFor(orgIds: string[]): Promise<Map<string, WhatsappAlertSettings>> {
  const out = new Map<string, WhatsappAlertSettings>();
  const now = Date.now();
  const miss: string[] = [];
  for (const id of orgIds) {
    const hit = cache.get(ck(id));
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.v); else miss.push(id);
  }
  if (miss.length) {
    const { data, error } = await supabaseAdmin.from('org_settings').select('org_id, value').eq('key', WA_SETTING_KEY).in('org_id', miss);
    if (error) { logger.warn(`[wa-alerts] settings read failed: ${error.message}`); return out; }
    const found = new Map<string, WhatsappAlertSettings>();
    for (const r of (data ?? []) as Array<{ org_id: string; value: unknown }>) found.set(r.org_id, toSettings(r.value));
    for (const id of miss) {
      const v = found.get(id) ?? { ...EMPTY };
      cache.set(ck(id), { at: now, v });
      out.set(id, v);
    }
  }
  return out;
}

export interface AlertCandidate { orgId: string | null; kind: string; title: string; body: string; data?: unknown }

const ENTITY_KEYS = ['lead_id', 'deal_id', 'order_id', 'sos_id', 'leave_id', 'leave_request_id', 'claim_id', 'expense_id', 'request_id', 'invoice_id', 'user_id', 'outlet_id', 'sku_id'];

/** One key per real-world event, so the per-manager copies of one event collapse into one WhatsApp message. */
export function eventKey(c: AlertCandidate): string {
  const d = (c.data && typeof c.data === 'object' ? c.data : {}) as Record<string, unknown>;
  const ids = ENTITY_KEYS.map((k) => (d[k] ? `${k}=${String(d[k])}` : '')).filter(Boolean).join('&');
  return `${c.orgId}|${canonicalKind(c.kind)}|${ids || `${c.title}|${c.body}`}`;
}

/**
 * Forward allowed notifications to the client's WhatsApp recipients. Best-effort: never throws, so the push
 * dispatcher is never held up by it. Returns how many messages were attempted.
 */
export async function forwardToClientWhatsapp(items: AlertCandidate[]): Promise<number> {
  if (!alertsActive() || isProjectDisabled() || !items.length) return 0;
  try {
    const orgIds = [...new Set(items.map((i) => i.orgId).filter((x): x is string => !!x))];
    if (!orgIds.length) return 0;
    const settings = await settingsFor(orgIds);

    const now = Date.now();
    for (const [k, at] of recentlySent) if (now - at > DEDUP_MS) recentlySent.delete(k);

    const perOrg = new Map<string, number>();
    const events = new Map<string, AlertCandidate>();
    for (const it of items) {
      if (!it.orgId) continue;
      const s = settings.get(it.orgId);
      if (!s?.enabled || !s.template_id || !s.recipients.length || !s.kinds.includes(canonicalKind(it.kind))) continue;
      const key = eventKey(it);
      if (events.has(key) || recentlySent.has(key)) continue;
      const n = perOrg.get(it.orgId) ?? 0;
      if (n >= MAX_EVENTS_PER_ORG_PER_RUN) continue;
      perOrg.set(it.orgId, n + 1);
      events.set(key, it);
    }

    let attempted = 0;
    for (const [key, ev] of events) {
      recentlySent.set(key, now);
      const outcomes = await sendToRecipients(ev.orgId as string, settings.get(ev.orgId as string)!, ev.title, ev.body);
      attempted += outcomes.length;
      const failed = outcomes.filter((o) => o.status === 'failed');
      if (failed.length) logger.warn(`[wa-alerts] ${failed.length}/${outcomes.length} failed org=${ev.orgId} kind=${ev.kind}: ${failed[0].error}`);
    }
    return attempted;
  } catch (e: any) {
    logger.error(`[wa-alerts] forwarding failed: ${e?.message || e}`);
    return 0;
  }
}

/**
 * WhatsApp Broadcast (campaigns) — Phase 1.
 *
 * Segment leads → pick an approved template → consent-gated, PACED send →
 * per-recipient delivery tracking. Built on the per-tenant WhatsApp connection
 * (whatsappConnection.service) and the crm_consents ledger (consent.service).
 *
 * Compliance: every recipient must be opted in for a campaign purpose
 * (whatsapp / marketing) — either the crm_leads whatsapp_consent/marketing_consent
 * boolean OR an active crm_consents row. Any explicit withdrawal/refusal
 * suppresses the lead. Suppressed leads are persisted as `skipped` recipients with
 * a reason, so the send is fully auditable.
 *
 * Pacing: a token-bucket over throttle_per_min anchored on last_batch_at, so
 * throughput converges to the configured per-minute rate no matter how often the
 * processor is driven (dashboard polling + the in-process scheduler both call it).
 *
 * Tables live in the Kinematic project only (Phase 0 not yet provisioned for
 * Tata); every DB call is current-project scoped and the scheduler iterates
 * known projects, so a project without the tables simply no-ops.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { sanitisePostgrestSearch } from '../../utils/postgrest';
import { knownProjectKeys, runWithProject } from '../../lib/projects';
import { sendWhatsapp } from './whatsapp.service';
import { optInPurposes } from './whatsappConnection.service';
import { withdrawConsent } from './consent.service';

const BROADCASTS = 'crm_broadcasts';
const RECIPIENTS = 'crm_broadcast_recipients';
const SETTINGS = 'crm_broadcast_settings';

// Inbound keywords that withdraw consent when a recipient replies (overridable
// per org via crm_broadcast_settings.opt_out_keywords).
const DEFAULT_OPT_OUT = ['stop', 'stop all', 'stopall', 'unsubscribe', 'opt out', 'optout', 'opt-out', 'cancel', 'end', 'quit', 'remove'];

const MAX_AUDIENCE = 50_000;      // hard cap on a single campaign's candidate pull
const HARD_CAP_PER_CALL = 300;    // most messages one processBatch tick will send
const MAX_ACCRUE_MIN = 2;         // cap token accrual after an idle gap / pause (anti-burst)
const DEFAULT_THROTTLE = 30;
const CHUNK = 500;
const MAX_ATTEMPTS = 4;           // total send attempts before a recipient is failed
const STALE_CLAIM_MIN = 5;        // a 'sending' recipient claimed longer ago than this is reaped
const DEFAULT_RATE_HOLD_SEC = 60; // pause length when a 429 arrives with no Retry-After
// Per-process token so a claimed row can be traced to the worker that took it.
const LOCKER = `wf-${process.pid}`;

/** Exponential backoff (minutes) for a transient send failure, capped. */
function retryDelayMs(attempts: number): number {
  return Math.min(30, Math.pow(2, Math.max(1, attempts))) * 60_000;
}

export type SkipReason = 'no_phone' | 'not_opted_in' | 'opted_out' | 'duplicate' | 'frequency_capped';
export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface BroadcastScope { orgId: string; clientId: string | null; userId?: string | null; }

export interface AudienceFilter {
  lead_ids?: string[];        // explicit selection — when present, other filters are ignored
  statuses?: string[];
  cities?: string[];
  states?: string[];
  countries?: string[];
  industries?: string[];
  tags?: string[];            // ANY overlap
  min_score?: number | null;
  search?: string | null;     // name / company / phone
}

export interface VarSource { type: 'field' | 'literal'; key?: string; value?: string; }
export type VariableMap = Record<string, VarSource>; // positional index ("1","2",…) → source

export interface CreateBroadcastInput {
  name: string;
  template_id: string;
  audience: AudienceFilter;
  variable_map?: VariableMap;
  throttle_per_min?: number;
  scheduled_at?: string | null;
}

// Lead columns pulled for gating + variable substitution.
const LEAD_SELECT =
  'id, phone, first_name, last_name, company, city, state, country, status, industry, tags, score, whatsapp_consent, marketing_consent';
const LEAD_VAR_FIELDS = new Set([
  'first_name', 'last_name', 'full_name', 'company', 'city', 'state', 'country', 'phone', 'status', 'industry',
]);

interface LeadRow {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  status: string | null;
  industry: string | null;
  tags: string[] | null;
  score: number | null;
  whatsapp_consent: boolean | null;
  marketing_consent: boolean | null;
}

// ── helpers ──────────────────────────────────────────────────────────────
function digits(phone: string | null | undefined): string {
  return (phone || '').replace(/[^\d]/g, '');
}
function clampThrottle(n: number | undefined): number {
  const v = Number(n ?? DEFAULT_THROTTLE);
  if (!Number.isFinite(v)) return DEFAULT_THROTTLE;
  return Math.min(600, Math.max(1, Math.round(v)));
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function resolveVars(lead: LeadRow, map?: VariableMap | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, src] of Object.entries(map || {})) {
    if (!src) continue;
    if (src.type === 'literal') { out[k] = String(src.value ?? ''); continue; }
    const key = src.key || '';
    if (!LEAD_VAR_FIELDS.has(key)) { out[k] = ''; continue; }
    if (key === 'full_name') out[k] = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
    else out[k] = (lead as unknown as Record<string, unknown>)[key] != null
      ? String((lead as unknown as Record<string, unknown>)[key]) : '';
  }
  return out;
}

// ── compliance settings (frequency cap / quiet hours / opt-out / cost) ─────
export interface BroadcastSettings {
  frequency_cap_max: number | null;
  frequency_cap_window_days: number;
  quiet_hours_start: number | null;   // send-window open hour (local to tz)
  quiet_hours_end: number | null;     // send-window close hour
  quiet_hours_tz: string;
  opt_out_keywords: string[] | null;
  cost_rates: Record<string, Record<string, number>> | null;
}
const EMPTY_SETTINGS: BroadcastSettings = {
  frequency_cap_max: null, frequency_cap_window_days: 7,
  quiet_hours_start: null, quiet_hours_end: null, quiet_hours_tz: 'Asia/Kolkata',
  opt_out_keywords: null, cost_rates: null,
};

/** Resolve settings for a scope: a client-specific row overrides the org default. */
async function loadBroadcastSettings(orgId: string, clientId: string | null): Promise<BroadcastSettings> {
  try {
    let row: any = null;
    if (clientId) {
      const { data } = await supabaseAdmin.from(SETTINGS).select('*').eq('org_id', orgId).eq('client_id', clientId).maybeSingle();
      row = data;
    }
    if (!row) {
      const { data } = await supabaseAdmin.from(SETTINGS).select('*').eq('org_id', orgId).is('client_id', null).maybeSingle();
      row = data;
    }
    if (!row) return EMPTY_SETTINGS;
    return {
      frequency_cap_max: row.frequency_cap_max ?? null,
      frequency_cap_window_days: row.frequency_cap_window_days ?? 7,
      quiet_hours_start: row.quiet_hours_start ?? null,
      quiet_hours_end: row.quiet_hours_end ?? null,
      quiet_hours_tz: row.quiet_hours_tz || 'Asia/Kolkata',
      opt_out_keywords: row.opt_out_keywords ?? null,
      cost_rates: row.cost_rates ?? null,
    };
  } catch { return EMPTY_SETTINGS; } // table absent on an unprovisioned project
}

export async function getBroadcastSettings(scope: BroadcastScope): Promise<BroadcastSettings> {
  return loadBroadcastSettings(scope.orgId, scope.clientId);
}

export async function upsertBroadcastSettings(scope: BroadcastScope, input: Partial<BroadcastSettings>): Promise<BroadcastSettings> {
  const clientId = scope.clientId ?? null;
  let q = supabaseAdmin.from(SETTINGS).select('id').eq('org_id', scope.orgId);
  q = clientId ? q.eq('client_id', clientId) : q.is('client_id', null);
  const { data: existing } = await q.maybeSingle();
  const row: Record<string, unknown> = {
    org_id: scope.orgId, client_id: clientId,
    frequency_cap_max: input.frequency_cap_max ?? null,
    frequency_cap_window_days: input.frequency_cap_window_days ?? 7,
    quiet_hours_start: input.quiet_hours_start ?? null,
    quiet_hours_end: input.quiet_hours_end ?? null,
    quiet_hours_tz: input.quiet_hours_tz || 'Asia/Kolkata',
    opt_out_keywords: input.opt_out_keywords ?? null,
    cost_rates: input.cost_rates ?? null,
    updated_by: scope.userId ?? null,
    updated_at: new Date().toISOString(),
  };
  const w = (existing as { id?: string } | null)?.id
    ? await supabaseAdmin.from(SETTINGS).update(row).eq('id', (existing as { id: string }).id)
    : await supabaseAdmin.from(SETTINGS).insert(row);
  if (w.error) throw new AppError(500, w.error.message, 'DB_ERROR');
  return loadBroadcastSettings(scope.orgId, clientId);
}

/** Opt-out keywords for an org (org-level settings; falls back to built-ins). */
export async function resolveOptOutKeywords(orgId: string): Promise<string[]> {
  const s = await loadBroadcastSettings(orgId, null);
  const list = (s.opt_out_keywords?.length ? s.opt_out_keywords : DEFAULT_OPT_OUT);
  return list.map((k) => k.trim().toLowerCase()).filter(Boolean);
}

/** True when `text` is (or starts with) an opt-out keyword. */
export function isOptOutMessage(text: string | undefined | null, keywords: string[]): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  return keywords.some((k) => t === k || t.startsWith(`${k} `) || t.startsWith(`${k}.`));
}

/** Current hour (0-23) in the given IANA timezone. */
function currentHourInTz(tz: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date());
    return Number(s) % 24;
  } catch { return new Date().getUTCHours(); }
}
/** True when NOW is outside the configured send window (so sends should hold). */
function isQuietHours(s: BroadcastSettings): boolean {
  if (s.quiet_hours_start == null || s.quiet_hours_end == null) return false;
  const h = currentHourInTz(s.quiet_hours_tz);
  const a = s.quiet_hours_start, z = s.quiet_hours_end;
  const inWindow = a <= z ? (h >= a && h < z) : (h >= a || h < z); // wrap past midnight
  return !inWindow;
}

// ── cost model ─────────────────────────────────────────────────────────────
// Per-message rates (WhatsApp moved to per-message pricing for marketing/
// utility/auth). Indicative INR defaults for India — the primary market —
// overridable per org via crm_broadcast_settings.cost_rates. Country is bucketed
// to IN vs. default since lead.country is free-text.
export const COST_CURRENCY = 'INR';
const DEFAULT_COST_RATES: Record<string, Record<string, number>> = {
  marketing: { IN: 0.78, default: 0.40 },
  utility: { IN: 0.16, default: 0.10 },
  authentication: { IN: 0.13, default: 0.10 },
};
function countryKey(country: string | null | undefined): 'IN' | 'default' {
  const c = (country || '').trim();
  return !c || /^(in|ind|india|bharat)$/i.test(c) ? 'IN' : 'default';
}
function rateFor(rates: Record<string, Record<string, number>>, category: string, key: 'IN' | 'default'): number {
  const cat = rates[category] || rates['marketing'] || {};
  return cat[key] ?? cat['default'] ?? 0;
}
function estimateCost(tally: Record<string, number>, category: string, rates?: Record<string, Record<string, number>> | null): number {
  const r = rates || DEFAULT_COST_RATES;
  let sum = 0;
  for (const [k, n] of Object.entries(tally)) sum += n * rateFor(r, category, k as 'IN' | 'default');
  return Math.round(sum * 100) / 100;
}

// ── audience resolution ──────────────────────────────────────────────────
async function queryCandidates(orgId: string, clientId: string | null, filter: AudienceFilter): Promise<LeadRow[]> {
  let q = supabaseAdmin.from('crm_leads').select(LEAD_SELECT).eq('org_id', orgId).is('deleted_at', null);
  if (clientId) q = q.eq('client_id', clientId);

  if (filter.lead_ids?.length) {
    q = q.in('id', filter.lead_ids.slice(0, MAX_AUDIENCE));
  } else {
    if (filter.statuses?.length) q = q.in('status', filter.statuses);
    if (filter.cities?.length) q = q.in('city', filter.cities);
    if (filter.states?.length) q = q.in('state', filter.states);
    if (filter.countries?.length) q = q.in('country', filter.countries);
    if (filter.industries?.length) q = q.in('industry', filter.industries);
    if (typeof filter.min_score === 'number') q = q.gte('score', filter.min_score);
    if (filter.tags?.length) q = q.overlaps('tags', filter.tags);
    if (filter.search) {
      const s = sanitisePostgrestSearch(filter.search);
      if (s) q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%,phone.ilike.%${s}%`);
    }
  }
  const { data, error } = await q.limit(MAX_AUDIENCE);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as unknown as LeadRow[];
}

/** Batch-load the consent ledger for the candidate leads → opted-in / opted-out sets. */
async function consentSets(orgId: string, leadIds: string[], purposes: string[]): Promise<{ optedIn: Set<string>; optedOut: Set<string> }> {
  const optedIn = new Set<string>();
  const optedOut = new Set<string>();
  if (!leadIds.length || !purposes.length) return { optedIn, optedOut };
  for (const ids of chunk(leadIds, 200)) {
    const { data, error } = await supabaseAdmin.from('crm_consents')
      .select('subject_id, consented, withdrawn_at')
      .eq('org_id', orgId).eq('subject_type', 'lead')
      .in('subject_id', ids).in('purpose', purposes);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
    for (const row of (data ?? []) as Array<{ subject_id: string; consented: boolean | null; withdrawn_at: string | null }>) {
      // Any explicit withdrawal or refusal for a campaign purpose suppresses the lead.
      if (row.withdrawn_at || row.consented === false) optedOut.add(row.subject_id);
      else if (row.consented === true) optedIn.add(row.subject_id);
    }
  }
  return { optedIn, optedOut };
}

export interface ResolvedRecipient { lead_id: string; phone: string; variables: Record<string, string>; }
export interface SkippedRecipient { lead_id: string; phone: string | null; skip_reason: SkipReason; }
export interface AudienceResolution {
  eligible: ResolvedRecipient[];
  skipped: SkippedRecipient[];
  counts: { candidates: number; eligible: number; no_phone: number; not_opted_in: number; opted_out: number; duplicate: number; frequency_capped: number };
  sample: Array<{ lead_id: string; name: string; phone: string }>;
  countryTally: Record<string, number>;   // eligible leads bucketed IN / default (cost estimate)
}

/** Leads that have already received >= cap broadcast sends within the window. */
async function frequencyCappedSet(orgId: string, leadIds: string[], cap: number, windowDays: number): Promise<Set<string>> {
  const capped = new Set<string>();
  if (!leadIds.length || !cap) return capped;
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const counts = new Map<string, number>();
  for (const ids of chunk(leadIds, 200)) {
    const { data } = await supabaseAdmin.from(RECIPIENTS).select('lead_id')
      .eq('org_id', orgId).in('lead_id', ids).in('status', ['sent', 'delivered', 'read']).gte('sent_at', windowStart);
    for (const r of (data ?? []) as Array<{ lead_id: string | null }>) {
      if (r.lead_id) counts.set(r.lead_id, (counts.get(r.lead_id) ?? 0) + 1);
    }
  }
  for (const [id, n] of counts) if (n >= cap) capped.add(id);
  return capped;
}

/** Resolve a filter into eligible + suppressed recipients (consent-gated, deduped by phone). */
export async function resolveAudience(orgId: string, clientId: string | null, filter: AudienceFilter, variableMap?: VariableMap | null): Promise<AudienceResolution> {
  const candidates = await queryCandidates(orgId, clientId, filter);
  const purposes = await optInPurposes(orgId);
  const { optedIn, optedOut } = await consentSets(orgId, candidates.map((l) => l.id), purposes);

  let eligible: ResolvedRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  const counts = { candidates: candidates.length, eligible: 0, no_phone: 0, not_opted_in: 0, opted_out: 0, duplicate: 0, frequency_capped: 0 };
  const seen = new Set<string>();

  for (const lead of candidates) {
    const d = digits(lead.phone);
    if (d.length < 8) { skipped.push({ lead_id: lead.id, phone: lead.phone, skip_reason: 'no_phone' }); counts.no_phone++; continue; }
    if (seen.has(d)) { skipped.push({ lead_id: lead.id, phone: lead.phone, skip_reason: 'duplicate' }); counts.duplicate++; continue; }
    seen.add(d);
    if (optedOut.has(lead.id)) { skipped.push({ lead_id: lead.id, phone: lead.phone, skip_reason: 'opted_out' }); counts.opted_out++; continue; }
    const boolOptIn = lead.whatsapp_consent === true || lead.marketing_consent === true;
    if (!boolOptIn && !optedIn.has(lead.id)) { skipped.push({ lead_id: lead.id, phone: lead.phone, skip_reason: 'not_opted_in' }); counts.not_opted_in++; continue; }
    eligible.push({ lead_id: lead.id, phone: lead.phone as string, variables: resolveVars(lead, variableMap) });
  }

  // Frequency cap — suppress leads already messaged too often in the window.
  const settings = await loadBroadcastSettings(orgId, clientId);
  if (settings.frequency_cap_max && settings.frequency_cap_max > 0 && eligible.length) {
    const capped = await frequencyCappedSet(orgId, eligible.map((e) => e.lead_id), settings.frequency_cap_max, settings.frequency_cap_window_days);
    if (capped.size) {
      eligible = eligible.filter((e) => {
        if (capped.has(e.lead_id)) { skipped.push({ lead_id: e.lead_id, phone: e.phone, skip_reason: 'frequency_capped' }); counts.frequency_capped++; return false; }
        return true;
      });
    }
  }
  counts.eligible = eligible.length;

  const countryById = new Map(candidates.map((c) => [c.id, c.country]));
  const countryTally: Record<string, number> = {};
  for (const e of eligible) {
    const k = countryKey(countryById.get(e.lead_id));
    countryTally[k] = (countryTally[k] ?? 0) + 1;
  }
  const sample = eligible.slice(0, 20).map((e) => {
    const l = candidates.find((c) => c.id === e.lead_id);
    return { lead_id: e.lead_id, name: [l?.first_name, l?.last_name].filter(Boolean).join(' ').trim() || '(no name)', phone: e.phone };
  });
  return { eligible, skipped, counts, sample, countryTally };
}

/** Preview an audience without persisting (wizard). Includes a cost estimate when
 *  a template is supplied (rate depends on the template's category). */
export async function previewBroadcast(scope: BroadcastScope, audience: AudienceFilter, variableMap?: VariableMap | null, templateId?: string | null) {
  const r = await resolveAudience(scope.orgId, scope.clientId, audience, variableMap);
  let est_cost: number | null = null;
  let cost_currency: string | null = null;
  if (templateId) {
    const tpl = await loadTemplate(scope.orgId, templateId);
    if (tpl) {
      const settings = await loadBroadcastSettings(scope.orgId, scope.clientId);
      est_cost = estimateCost(r.countryTally, tpl.category, settings.cost_rates);
      cost_currency = COST_CURRENCY;
    }
  }
  return { counts: r.counts, sample: r.sample, est_cost, cost_currency };
}

// ── template lookup ──────────────────────────────────────────────────────
async function loadTemplate(orgId: string, templateId: string): Promise<{ meta_template_name: string; language: string; category: string } | null> {
  const { data } = await supabaseAdmin.from('crm_whatsapp_templates')
    .select('meta_template_name, language, category').eq('org_id', orgId).eq('id', templateId).maybeSingle();
  return (data as { meta_template_name: string; language: string; category: string } | null) ?? null;
}

// ── CRUD / lifecycle ─────────────────────────────────────────────────────
export async function createBroadcast(scope: BroadcastScope, input: CreateBroadcastInput) {
  const tpl = await loadTemplate(scope.orgId, input.template_id);
  if (!tpl) throw new AppError(400, 'Template not found for this org', 'BAD_TEMPLATE');

  const row = {
    org_id: scope.orgId,
    client_id: scope.clientId,
    name: input.name,
    template_id: input.template_id,
    template_meta_name: tpl.meta_template_name,
    template_language: tpl.language,
    variable_map: input.variable_map ?? {},
    audience: input.audience ?? {},
    throttle_per_min: clampThrottle(input.throttle_per_min),
    scheduled_at: input.scheduled_at ?? null,
    status: 'draft' as BroadcastStatus,
    created_by: scope.userId ?? null,
  };
  const { data, error } = await supabaseAdmin.from(BROADCASTS).insert(row).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

async function loadBroadcast(orgId: string, id: string): Promise<any | null> {
  const { data } = await supabaseAdmin.from(BROADCASTS).select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  return data ?? null;
}

export async function getBroadcast(scope: BroadcastScope, id: string) {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  return b;
}

export async function listBroadcasts(scope: BroadcastScope, filters: Record<string, unknown> = {}) {
  let q = supabaseAdmin.from(BROADCASTS).select('*').eq('org_id', scope.orgId);
  if (scope.clientId) q = q.eq('client_id', scope.clientId);
  if (filters.status) q = q.eq('status', String(filters.status));
  const limit = Math.min(Number(filters.limit ?? 50), 200);
  const page = Math.max(Number(filters.page ?? 1), 1);
  q = q.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function listRecipients(scope: BroadcastScope, id: string, filters: Record<string, unknown> = {}) {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  let q = supabaseAdmin.from(RECIPIENTS).select('*').eq('broadcast_id', id).eq('org_id', scope.orgId);
  if (filters.status) q = q.eq('status', String(filters.status));
  const limit = Math.min(Number(filters.limit ?? 100), 500);
  const page = Math.max(Number(filters.page ?? 1), 1);
  q = q.order('status', { ascending: true }).order('id', { ascending: true }).range((page - 1) * limit, page * limit - 1);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

/** Resolve the audience, persist recipients, and start (or schedule) the send. */
export async function launchBroadcast(scope: BroadcastScope, id: string) {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  if (!['draft', 'scheduled', 'failed'].includes(b.status)) {
    throw new AppError(409, `Cannot launch a broadcast that is ${b.status}`, 'BAD_STATE');
  }

  const r = await resolveAudience(b.org_id, b.client_id ?? null, (b.audience ?? {}) as AudienceFilter, (b.variable_map ?? {}) as VariableMap);
  if (!r.eligible.length) throw new AppError(400, 'No eligible (opted-in) recipients for this audience', 'EMPTY_AUDIENCE');

  // Re-launch from draft: clear any prior recipient rows first.
  await supabaseAdmin.from(RECIPIENTS).delete().eq('broadcast_id', id).eq('org_id', scope.orgId);

  const rows = [
    ...r.eligible.map((e) => ({ broadcast_id: id, org_id: b.org_id, lead_id: e.lead_id, phone: e.phone, status: 'queued', variables: e.variables })),
    ...r.skipped.map((s) => ({ broadcast_id: id, org_id: b.org_id, lead_id: s.lead_id, phone: s.phone ?? '', status: 'skipped', skip_reason: s.skip_reason })),
  ];
  for (const c of chunk(rows, CHUNK)) {
    const { error } = await supabaseAdmin.from(RECIPIENTS).insert(c);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
  }

  // Estimate the spend for this send from the eligible country mix + template category.
  const tpl = await loadTemplate(b.org_id, b.template_id);
  const settings = await loadBroadcastSettings(b.org_id, b.client_id ?? null);
  const est_cost = tpl ? estimateCost(r.countryTally, tpl.category, settings.cost_rates) : null;

  const future = b.scheduled_at && Date.parse(b.scheduled_at) > Date.now();
  const patch: Record<string, unknown> = {
    total_recipients: r.eligible.length,
    skipped_count: r.skipped.length,
    sent_count: 0, delivered_count: 0, read_count: 0, failed_count: 0, reply_count: 0,
    est_cost, actual_cost: null,
    completed_at: null,
    status: future ? 'scheduled' : 'sending',
    started_at: future ? null : new Date().toISOString(),
    last_batch_at: null,
    hold_until: null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin.from(BROADCASTS).update(patch).eq('org_id', scope.orgId).eq('id', id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

async function setStatus(orgId: string, id: string, status: BroadcastStatus, extra: Record<string, unknown> = {}) {
  const { data, error } = await supabaseAdmin.from(BROADCASTS)
    .update({ status, updated_at: new Date().toISOString(), ...extra }).eq('org_id', orgId).eq('id', id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function pauseBroadcast(scope: BroadcastScope, id: string) {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  if (!['sending', 'scheduled'].includes(b.status)) throw new AppError(409, `Cannot pause a ${b.status} broadcast`, 'BAD_STATE');
  return setStatus(scope.orgId, id, 'paused');
}

export async function resumeBroadcast(scope: BroadcastScope, id: string) {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  if (b.status !== 'paused') throw new AppError(409, `Cannot resume a ${b.status} broadcast`, 'BAD_STATE');
  // Resume from now — the token bucket accrues from last_batch_at (reset here) so
  // the pause window doesn't produce a burst.
  return setStatus(scope.orgId, id, 'sending', { started_at: b.started_at ?? new Date().toISOString(), last_batch_at: null, hold_until: null });
}

export async function cancelBroadcast(scope: BroadcastScope, id: string) {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  if (['completed', 'cancelled'].includes(b.status)) return b;
  return setStatus(scope.orgId, id, 'cancelled', { completed_at: new Date().toISOString() });
}

// ── counters ─────────────────────────────────────────────────────────────
async function countStatus(orgId: string, broadcastId: string, status: string): Promise<number> {
  const { count } = await supabaseAdmin.from(RECIPIENTS)
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', status);
  return count ?? 0;
}

/** Recompute broadcast aggregates from recipient rows (race-free vs. incrementing). */
async function recomputeCounts(orgId: string, broadcastId: string, currentStatus: BroadcastStatus) {
  const [queued, sending, sent, delivered, read, failed, skipped] = await Promise.all([
    countStatus(orgId, broadcastId, 'queued'),
    countStatus(orgId, broadcastId, 'sending'),
    countStatus(orgId, broadcastId, 'sent'),
    countStatus(orgId, broadcastId, 'delivered'),
    countStatus(orgId, broadcastId, 'read'),
    countStatus(orgId, broadcastId, 'failed'),
    countStatus(orgId, broadcastId, 'skipped'),
  ]);
  const patch: Record<string, unknown> = {
    sent_count: sent + delivered + read,      // "sent or beyond"
    delivered_count: delivered + read,
    read_count: read,
    failed_count: failed,
    skipped_count: skipped,
    updated_at: new Date().toISOString(),
  };
  // Done when nothing is left queued or in-flight and we were actively sending.
  if (queued === 0 && sending === 0 && currentStatus === 'sending') {
    patch.status = 'completed';
    patch.completed_at = new Date().toISOString();
  }
  await supabaseAdmin.from(BROADCASTS).update(patch).eq('org_id', orgId).eq('id', broadcastId);
  return { queued, sending, sent, delivered, read, failed, skipped };
}

// ── the paced processor ──────────────────────────────────────────────────
function tokenBudget(b: any, remaining: number): number {
  const now = Date.now();
  const last = b.last_batch_at ? Date.parse(b.last_batch_at) : (b.started_at ? Date.parse(b.started_at) : now);
  const minutes = Math.min(MAX_ACCRUE_MIN, Math.max(0, (now - last) / 60_000));
  let budget = Math.floor(b.throttle_per_min * minutes);
  if ((b.sent_count ?? 0) === 0 && budget < 1) budget = Math.min(b.throttle_per_min, remaining); // kick-start
  return Math.min(budget, remaining, HARD_CAP_PER_CALL);
}

interface ClaimedRecipient { id: string; phone: string; lead_id: string | null; variables: Record<string, string> | null; attempts: number | null; }

/** Put a set of claimed recipients back on the queue (crash/rate-limit recovery). */
async function requeue(orgId: string, ids: string[], nextRetryAt: string | null) {
  if (!ids.length) return;
  await supabaseAdmin.from(RECIPIENTS).update({
    status: 'queued', claimed_at: null, locked_by: null, next_retry_at: nextRetryAt, updated_at: new Date().toISOString(),
  }).in('id', ids);
}

/** Send the next paced batch for one broadcast. Safe to call repeatedly and concurrently. */
async function runProcessing(b: any): Promise<{ sent: number; failed: number; done: boolean }> {
  const orgId = b.org_id as string;

  // A scheduled broadcast that has come due flips to sending.
  if (b.status === 'scheduled' && b.scheduled_at && Date.parse(b.scheduled_at) <= Date.now()) {
    b = await setStatus(orgId, b.id, 'sending', { started_at: new Date().toISOString(), last_batch_at: null, hold_until: null });
  }
  if (b.status !== 'sending') return { sent: 0, failed: 0, done: ['completed', 'cancelled', 'failed'].includes(b.status) };

  // Rate-limit hold (set from a 429). Wait it out without sending.
  if (b.hold_until && Date.parse(b.hold_until) > Date.now()) return { sent: 0, failed: 0, done: false };

  // Quiet-hours hold — outside the tenant's send window we don't send (the tick
  // just returns; the campaign stays 'sending' and resumes when the window opens).
  const settings = await loadBroadcastSettings(orgId, b.client_id ?? null);
  if (isQuietHours(settings)) return { sent: 0, failed: 0, done: false };

  // Reap stale claims — a 'sending' recipient whose worker died mid-flight goes
  // back on the queue so it isn't stuck forever.
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MIN * 60_000).toISOString();
  await supabaseAdmin.from(RECIPIENTS).update({ status: 'queued', claimed_at: null, locked_by: null, updated_at: new Date().toISOString() })
    .eq('broadcast_id', b.id).eq('org_id', orgId).eq('status', 'sending').lt('claimed_at', staleBefore);

  const remaining = await countStatus(orgId, b.id, 'queued');
  if (remaining === 0) { const rc = await recomputeCounts(orgId, b.id, 'sending'); return { sent: 0, failed: 0, done: rc.sending === 0 }; }

  const take = tokenBudget(b, remaining);
  if (take <= 0) return { sent: 0, failed: 0, done: false };

  // Atomic claim — FOR UPDATE SKIP LOCKED so overlapping ticks never grab the
  // same rows (no double-sends). Only due rows (next_retry_at past) are taken.
  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc('claim_broadcast_recipients', {
    p_broadcast: b.id, p_org: orgId, p_limit: take, p_locked_by: LOCKER,
  });
  if (claimErr) { logger.warn(`[broadcast] claim failed ${b.id}: ${claimErr.message}`); return { sent: 0, failed: 0, done: false }; }
  const recipients = (claimed ?? []) as ClaimedRecipient[];
  if (!recipients.length) { const rc = await recomputeCounts(orgId, b.id, 'sending'); return { sent: 0, failed: 0, done: rc.queued === 0 && rc.sending === 0 }; }

  let sent = 0, failed = 0;
  for (let i = 0; i < recipients.length; i++) {
    const rcpt = recipients[i];
    const attempts = (rcpt.attempts ?? 0) + 1;
    const result = await sendWhatsapp({
      org_id: orgId, user_id: b.created_by ?? undefined, to: rcpt.phone,
      template_id: b.template_id, template_variables: rcpt.variables ?? undefined, lead_id: rcpt.lead_id ?? undefined,
    }).catch((e: any) => ({ status: 'failed' as const, provider_message_id: null, error: e?.message ?? 'send error', retryable: true, rate_limited: false, retry_after_sec: undefined }));

    if (result.status === 'sent') {
      await supabaseAdmin.from(RECIPIENTS).update({
        status: 'sent', provider_message_id: result.provider_message_id ?? null, error: null, failure_kind: null,
        attempts, claimed_at: null, locked_by: null, sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', rcpt.id);
      sent++;
      continue;
    }

    // Rate limited → hold the whole campaign, requeue this + all not-yet-tried
    // rows (no attempt penalty for a throttle), and stop the batch.
    if (result.rate_limited) {
      const holdMs = (result.retry_after_sec ? result.retry_after_sec : DEFAULT_RATE_HOLD_SEC) * 1000;
      const holdIso = new Date(Date.now() + holdMs).toISOString();
      await supabaseAdmin.from(BROADCASTS).update({ hold_until: holdIso, updated_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', b.id);
      await requeue(orgId, recipients.slice(i).map((r) => r.id), holdIso);
      break;
    }

    if (result.retryable && attempts < MAX_ATTEMPTS) {
      // Transient failure with retries left → back on the queue with backoff.
      await supabaseAdmin.from(RECIPIENTS).update({
        status: 'queued', attempts, next_retry_at: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
        error: result.error ?? 'transient failure', failure_kind: 'transient', claimed_at: null, locked_by: null, updated_at: new Date().toISOString(),
      }).eq('id', rcpt.id);
    } else {
      // Permanent, or transient retries exhausted → fail it.
      await supabaseAdmin.from(RECIPIENTS).update({
        status: 'failed', attempts, error: result.error ?? 'send failed',
        failure_kind: result.retryable ? 'transient' : 'permanent', claimed_at: null, locked_by: null, updated_at: new Date().toISOString(),
      }).eq('id', rcpt.id);
      failed++;
    }
  }

  await supabaseAdmin.from(BROADCASTS).update({ last_batch_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', b.id);
  const rc = await recomputeCounts(orgId, b.id, 'sending');
  return { sent, failed, done: rc.queued === 0 && rc.sending === 0 };
}

/** Process a single broadcast (dashboard-driven /process). Returns the updated row. */
export async function processBroadcast(scope: BroadcastScope, id: string) {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  await runProcessing(b);
  return loadBroadcast(scope.orgId, id);
}

/** Scheduler entry (current project): advance every in-flight / due broadcast. */
export async function processDueBroadcasts(): Promise<{ processed: number; sent: number }> {
  let processed = 0, sent = 0;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from(BROADCASTS).select('*')
      .or(`status.eq.sending,and(status.eq.scheduled,scheduled_at.lte.${nowIso})`).limit(100);
    if (error) return { processed, sent }; // table absent / not provisioned → no-op
    for (const b of (data ?? []) as any[]) {
      try { const r = await runProcessing(b); processed++; sent += r.sent; }
      catch (e: any) { logger.warn(`[broadcast] process ${b.id} failed: ${e?.message ?? e}`); }
    }
  } catch { /* project without broadcast tables — no-op */ }
  return { processed, sent };
}

/** Scheduler entry across every known project (broadcast tables may exist in only some). */
export async function processDueBroadcastsAllProjects(): Promise<{ processed: number; sent: number }> {
  let processed = 0, sent = 0;
  for (const key of knownProjectKeys()) {
    try {
      const r = await runWithProject(key, () => processDueBroadcasts());
      processed += r.processed; sent += r.sent;
    } catch (e: any) { logger.warn(`[broadcast] project ${key} sweep failed: ${e?.message ?? e}`); }
  }
  return { processed, sent };
}

export interface WebhookPricing { category?: string | null; billable?: boolean | null }

/** Webhook hook: apply a delivery-status update to a broadcast recipient (by provider message id). */
export async function applyRecipientStatus(orgId: string, providerMessageId: string, status: 'delivered' | 'read' | 'failed', error?: string, pricing?: WebhookPricing): Promise<void> {
  try {
    const { data } = await supabaseAdmin.from(RECIPIENTS).select('id, broadcast_id, status')
      .eq('org_id', orgId).eq('provider_message_id', providerMessageId).maybeSingle();
    const rcpt = data as { id: string; broadcast_id: string; status: string } | null;
    if (!rcpt) return;
    // Never regress read→delivered. Order: sent < delivered < read; failed is terminal-ish.
    const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    // Pricing rides along on delivery webhooks — persist it whenever present.
    if (pricing && (pricing.category != null || pricing.billable != null)) {
      if (pricing.category != null) patch.pricing_category = String(pricing.category).toLowerCase();
      if (pricing.billable != null) patch.billable = !!pricing.billable;
    }
    const advance = status === 'failed' || (rank[status] ?? 0) > (rank[rcpt.status] ?? 0);
    if (advance) {
      patch.status = status;
      patch.error = status === 'failed' ? (error ?? 'delivery failed') : null;
    }
    if (!advance && Object.keys(patch).length === 1) return; // nothing new (older/dup status, no pricing)
    await supabaseAdmin.from(RECIPIENTS).update(patch).eq('id', rcpt.id);
    if (advance) {
      const b = await supabaseAdmin.from(BROADCASTS).select('status').eq('id', rcpt.broadcast_id).maybeSingle();
      await recomputeCounts(orgId, rcpt.broadcast_id, ((b.data as { status?: BroadcastStatus } | null)?.status) ?? 'sending');
    }
  } catch (e: any) {
    logger.warn(`[broadcast] recipient status update failed pmid=${providerMessageId}: ${e?.message ?? e}`);
  }
}

// ── analytics + export ─────────────────────────────────────────────────────
export interface BroadcastAnalytics {
  total_recipients: number;
  sent: number; delivered: number; read: number; failed: number; skipped: number; queued: number; replied: number;
  delivery_rate: number; read_rate: number; reply_rate: number; failure_rate: number;
  skip_reasons: Record<string, number>;
  failure_kinds: Record<string, number>;
  est_cost: number | null; actual_cost: number; cost_currency: string;
}

/** Delivery / read / reply / failure rates + cost for one campaign. */
export async function getAnalytics(scope: BroadcastScope, id: string): Promise<BroadcastAnalytics> {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  const [sent, delivered, read, failed, skipped, queued, sending, billable] = await Promise.all([
    countStatus(scope.orgId, id, 'sent'),
    countStatus(scope.orgId, id, 'delivered'),
    countStatus(scope.orgId, id, 'read'),
    countStatus(scope.orgId, id, 'failed'),
    countStatus(scope.orgId, id, 'skipped'),
    countStatus(scope.orgId, id, 'queued'),
    countStatus(scope.orgId, id, 'sending'),
    supabaseAdmin.from(RECIPIENTS).select('id', { count: 'exact', head: true }).eq('broadcast_id', id).eq('org_id', scope.orgId).eq('billable', true).then((r) => r.count ?? 0),
  ]);
  const sentTotal = sent + delivered + read;        // reached the provider
  const deliveredTotal = delivered + read;
  const [replied] = await Promise.all([
    supabaseAdmin.from(RECIPIENTS).select('id', { count: 'exact', head: true }).eq('broadcast_id', id).eq('org_id', scope.orgId).not('replied_at', 'is', null).then((r) => r.count ?? 0),
  ]);
  const skipReasons = await groupSkips(scope.orgId, id);
  const failKinds = await groupFailureKinds(scope.orgId, id);

  // Actual cost: billable messages × rate when Meta sent pricing; else project
  // from delivered × rate. Category from the template.
  const tpl = await loadTemplate(scope.orgId, b.template_id);
  const settings = await loadBroadcastSettings(scope.orgId, b.client_id ?? null);
  const rate = rateFor(settings.cost_rates || DEFAULT_COST_RATES, tpl?.category || 'marketing', 'IN');
  const actual_cost = Math.round((billable > 0 ? billable * rate : deliveredTotal * rate) * 100) / 100;

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    total_recipients: b.total_recipients ?? sentTotal + failed + queued + sending,
    sent: sentTotal, delivered: deliveredTotal, read, failed, skipped, queued: queued + sending, replied,
    delivery_rate: pct(deliveredTotal, sentTotal),
    read_rate: pct(read, deliveredTotal),
    reply_rate: pct(replied, deliveredTotal),
    failure_rate: pct(failed, sentTotal + failed),
    skip_reasons: skipReasons,
    failure_kinds: failKinds,
    est_cost: b.est_cost ?? null,
    actual_cost,
    cost_currency: COST_CURRENCY,
  };
}

async function groupSkips(orgId: string, id: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const { data } = await supabaseAdmin.from(RECIPIENTS).select('skip_reason').eq('broadcast_id', id).eq('org_id', orgId).eq('status', 'skipped').limit(50000);
  for (const r of (data ?? []) as Array<{ skip_reason: string | null }>) { const k = r.skip_reason || 'other'; out[k] = (out[k] ?? 0) + 1; }
  return out;
}
async function groupFailureKinds(orgId: string, id: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const { data } = await supabaseAdmin.from(RECIPIENTS).select('failure_kind').eq('broadcast_id', id).eq('org_id', orgId).eq('status', 'failed').limit(50000);
  for (const r of (data ?? []) as Array<{ failure_kind: string | null }>) { const k = r.failure_kind || 'unknown'; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

/** Full recipient list as CSV (audit export). */
export async function recipientsCsv(scope: BroadcastScope, id: string): Promise<string> {
  const b = await loadBroadcast(scope.orgId, id);
  if (!b) throw new AppError(404, 'Broadcast not found', 'NOT_FOUND');
  const header = ['phone', 'lead_id', 'status', 'skip_reason', 'failure_kind', 'attempts', 'error', 'provider_message_id', 'sent_at', 'replied_at'];
  const lines = [header.join(',')];
  const PAGE = 1000;
  for (let page = 0; page < 60; page++) { // cap 60k rows
    const { data } = await supabaseAdmin.from(RECIPIENTS).select('phone, lead_id, status, skip_reason, failure_kind, attempts, error, provider_message_id, sent_at, replied_at')
      .eq('broadcast_id', id).eq('org_id', scope.orgId).order('id', { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) lines.push(header.map((h) => csvCell(r[h])).join(','));
    if (rows.length < PAGE) break;
  }
  return lines.join('\n');
}
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Metering: messages actually sent this calendar month for the scope. */
export async function getUsage(scope: BroadcastScope): Promise<{ month: string; sent: number }> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  let q = supabaseAdmin.from(RECIPIENTS).select('id', { count: 'exact', head: true })
    .eq('org_id', scope.orgId).in('status', ['sent', 'delivered', 'read']).gte('sent_at', monthStart);
  // Scope to the client's own broadcasts when a client is selected.
  if (scope.clientId) {
    const { data: ids } = await supabaseAdmin.from(BROADCASTS).select('id').eq('org_id', scope.orgId).eq('client_id', scope.clientId).limit(5000);
    const bids = (ids ?? []).map((r: { id: string }) => r.id);
    if (!bids.length) return { month: monthStart.slice(0, 7), sent: 0 };
    q = q.in('broadcast_id', bids);
  }
  const { count } = await q;
  return { month: monthStart.slice(0, 7), sent: count ?? 0 };
}

/**
 * Webhook hook for an inbound message. Two jobs, both best-effort:
 *  1. Opt-out — if the reply is a STOP/unsubscribe keyword, withdraw the lead's
 *     consent (crm_consents) + clear the booleans, so every future campaign
 *     suppresses them (DPDP right to withdraw).
 *  2. Reply attribution — otherwise, stamp the lead's most recent broadcast
 *     recipient as replied and bump the campaign's reply_count (reply-rate).
 */
export async function handleInbound(orgId: string, fromPhone: string, bodyText?: string | null): Promise<void> {
  try {
    const d = digits(fromPhone);
    if (d.length < 8) return;
    const last10 = d.slice(-10);
    const { data: lead } = await supabaseAdmin.from('crm_leads').select('id')
      .eq('org_id', orgId).is('deleted_at', null).or(`phone.eq.${last10},phone.eq.${d}`).limit(1).maybeSingle();
    const leadId = (lead as { id?: string } | null)?.id ?? null;

    const keywords = await resolveOptOutKeywords(orgId);
    if (isOptOutMessage(bodyText, keywords)) {
      if (leadId) {
        const purposes = await optInPurposes(orgId);
        for (const p of purposes) {
          try { await withdrawConsent({ orgId, clientId: null }, { subjectType: 'lead', subjectId: leadId, purpose: p }); } catch { /* no active row for this purpose */ }
        }
        await supabaseAdmin.from('crm_leads').update({ whatsapp_consent: false, marketing_consent: false }).eq('org_id', orgId).eq('id', leadId);
      }
      logger.info(`[broadcast] opt-out from ${last10} (lead=${leadId ?? 'unknown'})`);
      return;
    }

    if (!leadId) return;
    const { data: rcpt } = await supabaseAdmin.from(RECIPIENTS).select('id, broadcast_id, replied_at')
      .eq('org_id', orgId).eq('lead_id', leadId).in('status', ['sent', 'delivered', 'read'])
      .order('sent_at', { ascending: false }).limit(1).maybeSingle();
    const r = rcpt as { id: string; broadcast_id: string; replied_at: string | null } | null;
    if (r?.id && !r.replied_at) {
      await supabaseAdmin.from(RECIPIENTS).update({ replied_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', r.id);
      const { data: b } = await supabaseAdmin.from(BROADCASTS).select('reply_count').eq('id', r.broadcast_id).maybeSingle();
      await supabaseAdmin.from(BROADCASTS).update({ reply_count: (((b as { reply_count?: number } | null)?.reply_count) ?? 0) + 1, updated_at: new Date().toISOString() }).eq('id', r.broadcast_id);
    }
  } catch (e: any) {
    logger.warn(`[broadcast] handleInbound failed: ${e?.message ?? e}`);
  }
}

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

const BROADCASTS = 'crm_broadcasts';
const RECIPIENTS = 'crm_broadcast_recipients';

const MAX_AUDIENCE = 50_000;      // hard cap on a single campaign's candidate pull
const HARD_CAP_PER_CALL = 300;    // most messages one processBatch tick will send
const MAX_ACCRUE_MIN = 2;         // cap token accrual after an idle gap / pause (anti-burst)
const DEFAULT_THROTTLE = 30;
const CHUNK = 500;

export type SkipReason = 'no_phone' | 'not_opted_in' | 'opted_out' | 'duplicate';
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
  counts: { candidates: number; eligible: number; no_phone: number; not_opted_in: number; opted_out: number; duplicate: number };
  sample: Array<{ lead_id: string; name: string; phone: string }>;
}

/** Resolve a filter into eligible + suppressed recipients (consent-gated, deduped by phone). */
export async function resolveAudience(orgId: string, clientId: string | null, filter: AudienceFilter, variableMap?: VariableMap | null): Promise<AudienceResolution> {
  const candidates = await queryCandidates(orgId, clientId, filter);
  const purposes = await optInPurposes(orgId);
  const { optedIn, optedOut } = await consentSets(orgId, candidates.map((l) => l.id), purposes);

  const eligible: ResolvedRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  const counts = { candidates: candidates.length, eligible: 0, no_phone: 0, not_opted_in: 0, opted_out: 0, duplicate: 0 };
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
  counts.eligible = eligible.length;
  const sample = eligible.slice(0, 20).map((e) => {
    const l = candidates.find((c) => c.id === e.lead_id);
    return { lead_id: e.lead_id, name: [l?.first_name, l?.last_name].filter(Boolean).join(' ').trim() || '(no name)', phone: e.phone };
  });
  return { eligible, skipped, counts, sample };
}

/** Preview an audience without persisting (wizard). */
export async function previewBroadcast(scope: BroadcastScope, audience: AudienceFilter, variableMap?: VariableMap | null) {
  const r = await resolveAudience(scope.orgId, scope.clientId, audience, variableMap);
  return { counts: r.counts, sample: r.sample };
}

// ── template lookup ──────────────────────────────────────────────────────
async function loadTemplate(orgId: string, templateId: string): Promise<{ meta_template_name: string; language: string } | null> {
  const { data } = await supabaseAdmin.from('crm_whatsapp_templates')
    .select('meta_template_name, language').eq('org_id', orgId).eq('id', templateId).maybeSingle();
  return (data as { meta_template_name: string; language: string } | null) ?? null;
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

  const future = b.scheduled_at && Date.parse(b.scheduled_at) > Date.now();
  const patch: Record<string, unknown> = {
    total_recipients: r.eligible.length,
    skipped_count: r.skipped.length,
    sent_count: 0, delivered_count: 0, read_count: 0, failed_count: 0,
    completed_at: null,
    status: future ? 'scheduled' : 'sending',
    started_at: future ? null : new Date().toISOString(),
    last_batch_at: null,
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
  return setStatus(scope.orgId, id, 'sending', { started_at: b.started_at ?? new Date().toISOString(), last_batch_at: null });
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
  const [queued, sent, delivered, read, failed, skipped] = await Promise.all([
    countStatus(orgId, broadcastId, 'queued'),
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
  // Done when nothing is left queued and we were actively sending.
  if (queued === 0 && currentStatus === 'sending') {
    patch.status = 'completed';
    patch.completed_at = new Date().toISOString();
  }
  await supabaseAdmin.from(BROADCASTS).update(patch).eq('org_id', orgId).eq('id', broadcastId);
  return { queued, sent, delivered, read, failed, skipped };
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

/** Send the next paced batch for one broadcast. Safe to call repeatedly / concurrently-ish. */
async function runProcessing(b: any): Promise<{ sent: number; failed: number; done: boolean }> {
  const orgId = b.org_id as string;

  // A scheduled broadcast that has come due flips to sending.
  if (b.status === 'scheduled' && b.scheduled_at && Date.parse(b.scheduled_at) <= Date.now()) {
    b = await setStatus(orgId, b.id, 'sending', { started_at: new Date().toISOString(), last_batch_at: null });
  }
  if (b.status !== 'sending') return { sent: 0, failed: 0, done: ['completed', 'cancelled', 'failed'].includes(b.status) };

  const remaining = await countStatus(orgId, b.id, 'queued');
  if (remaining === 0) { await recomputeCounts(orgId, b.id, 'sending'); return { sent: 0, failed: 0, done: true }; }

  const take = tokenBudget(b, remaining);
  if (take <= 0) return { sent: 0, failed: 0, done: false };

  const { data: batch } = await supabaseAdmin.from(RECIPIENTS).select('*')
    .eq('broadcast_id', b.id).eq('org_id', orgId).eq('status', 'queued')
    .order('id', { ascending: true }).limit(take);
  const recipients = (batch ?? []) as Array<{ id: string; phone: string; lead_id: string | null; variables: Record<string, string> | null }>;
  if (!recipients.length) return { sent: 0, failed: 0, done: false };

  let sent = 0, failed = 0;
  for (const rcpt of recipients) {
    try {
      const result = await sendWhatsapp({
        org_id: orgId,
        user_id: b.created_by ?? undefined,
        to: rcpt.phone,
        template_id: b.template_id,
        template_variables: rcpt.variables ?? undefined,
        lead_id: rcpt.lead_id ?? undefined,
      });
      if (result.status === 'sent') {
        await supabaseAdmin.from(RECIPIENTS).update({
          status: 'sent', provider_message_id: result.provider_message_id ?? null, error: null,
          sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', rcpt.id);
        sent++;
      } else {
        await supabaseAdmin.from(RECIPIENTS).update({
          status: 'failed', error: result.error ?? 'send failed', updated_at: new Date().toISOString(),
        }).eq('id', rcpt.id);
        failed++;
      }
    } catch (e: any) {
      await supabaseAdmin.from(RECIPIENTS).update({
        status: 'failed', error: e?.message ?? 'send error', updated_at: new Date().toISOString(),
      }).eq('id', rcpt.id);
      failed++;
    }
  }

  await supabaseAdmin.from(BROADCASTS).update({ last_batch_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', b.id);
  const rc = await recomputeCounts(orgId, b.id, 'sending');
  return { sent, failed, done: rc.queued === 0 };
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

/** Webhook hook: apply a delivery-status update to a broadcast recipient (by provider message id). */
export async function applyRecipientStatus(orgId: string, providerMessageId: string, status: 'delivered' | 'read' | 'failed', error?: string): Promise<void> {
  try {
    const { data } = await supabaseAdmin.from(RECIPIENTS).select('id, broadcast_id, status')
      .eq('org_id', orgId).eq('provider_message_id', providerMessageId).maybeSingle();
    const rcpt = data as { id: string; broadcast_id: string; status: string } | null;
    if (!rcpt) return;
    // Never regress read→delivered. Order: sent < delivered < read; failed is terminal-ish.
    const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
    if (status !== 'failed' && (rank[status] ?? 0) <= (rank[rcpt.status] ?? 0)) return;
    await supabaseAdmin.from(RECIPIENTS).update({
      status, error: status === 'failed' ? (error ?? 'delivery failed') : null, updated_at: new Date().toISOString(),
    }).eq('id', rcpt.id);
    const b = await supabaseAdmin.from(BROADCASTS).select('status').eq('id', rcpt.broadcast_id).maybeSingle();
    await recomputeCounts(orgId, rcpt.broadcast_id, ((b.data as { status?: BroadcastStatus } | null)?.status) ?? 'sending');
  } catch (e: any) {
    logger.warn(`[broadcast] recipient status update failed pmid=${providerMessageId}: ${e?.message ?? e}`);
  }
}

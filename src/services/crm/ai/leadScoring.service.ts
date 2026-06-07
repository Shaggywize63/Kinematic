/**
 * Lead scoring v2 — unified path with proper B2B / B2C separation,
 * real engagement signals, and a profile-aware LLM rerank prompt.
 *
 * Earlier behaviour (heuristic_v1) had three problems users could see:
 *   1. The breakdown JSON always carried B2B keys ("title", "company_size")
 *      even on B2C leads, just zeroed-out — making the UI look like B2C
 *      leads were being judged on company size and job title.
 *   2. Engagement was derived from a single timestamp (`last_activity_at`)
 *      and never counted WhatsApp / call / meeting / Updates activity, so
 *      a hot B2C lead with 20 inbound WhatsApp messages scored the same as
 *      a cold one with zero engagement.
 *   3. The LLM rerank prompt was hard-coded as "B2B sales lead qualification
 *      expert" — a B2C-specific bias bug independent of the heuristic.
 *
 * v2 fixes all three:
 *   - Breakdown carries ONLY the keys that apply to the chosen profile
 *     (model tag is `heuristic_b2c_v2` or `heuristic_b2b_v2` so analytics
 *     can A/B against v1 entries already in `crm_lead_scores`).
 *   - Engagement is counted from `crm_activities` + `crm_lead_updates`
 *     over the last 30 days. Created leads skip the engagement fetch
 *     (no activities yet); rescored leads always fetch it.
 *   - The rerank prompt switches on profile: B2C reads consumer-intent
 *     signals (reachability, recency, source quality, inbound activity);
 *     B2B reads firmographic + BANT signals.
 *
 * Per-tenant override surface lives at `crm_settings.config.scoring`:
 *   {
 *     "scoring": {
 *       "active_profile": "auto" | "b2c" | "b2b",   // default: auto
 *       "grade_thresholds": { "A": 75, "B": 55, "C": 35 },
 *       "weights": { "b2c": { ... }, "b2b": { ... } }
 *     }
 *   }
 * Missing keys fall through to the defaults below.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { createTtlCache } from '../../../utils/ttlCache';
import { complete as aiComplete } from './aiClient';
import type { Lead, ScoreBreakdown } from '../../../types/crm.types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Icp {
  industries?: string[];
  company_sizes?: string[];
  titles?: string[];
}

export interface EngagementSignals {
  whatsapp_count_30d: number;
  call_count_30d: number;
  meeting_count_30d: number;
  email_count_30d: number;
  updates_count_30d: number;
  bant_signals_in_updates: number;
  days_since_last_touch: number | null;
  // All-time activity volume — rewards leads worked over a longer horizon,
  // not just the trailing 30 days.
  total_activity_count: number;
}

export interface ScoringConfig {
  active_profile?: 'auto' | 'b2c' | 'b2b';
  grade_thresholds?: { A?: number; B?: number; C?: number };
  weights?: {
    b2c?: Record<string, number>;
    b2b?: Record<string, number>;
  };
}

const DEFAULT_THRESHOLDS = { A: 75, B: 55, C: 35 };
const EMPTY_ENGAGEMENT: EngagementSignals = {
  whatsapp_count_30d: 0, call_count_30d: 0, meeting_count_30d: 0,
  email_count_30d: 0, updates_count_30d: 0, bant_signals_in_updates: 0,
  days_since_last_touch: null, total_activity_count: 0,
};

// Words the BANT-detector looks for in update bodies. Generic enough to
// catch the most common phrasings without over-fitting to one tenant.
const BANT_REGEX = /\b(budget|timeline|deadline|decision\s*maker|approver|approval|sign[\s-]?off|procurement|finalis|finaliz|RFP|quotation)\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// ICP cache (unchanged from v1)
// ─────────────────────────────────────────────────────────────────────────────

const icpCache = createTtlCache<Icp>({ defaultTtlMs: 5 * 60_000, maxSize: 500 });

export function invalidateIcpCache(org_id: string, client_id: string | null = null) {
  icpCache.delete(`${org_id}:${client_id ?? 'org'}`);
  if (client_id) icpCache.delete(`${org_id}:org`);
}

export async function getIcp(org_id: string, client_id: string | null = null): Promise<Icp> {
  return icpCache.remember(`${org_id}:${client_id ?? 'org'}`, async () => {
    if (client_id) {
      const { data } = await supabaseAdmin
        .from('crm_settings').select('config')
        .eq('org_id', org_id).eq('client_id', client_id).maybeSingle();
      const icp = ((data?.config as Record<string, unknown>)?.icp as Icp) ?? null;
      if (icp) return icp;
    }
    const { data } = await supabaseAdmin
      .from('crm_settings').select('config')
      .eq('org_id', org_id).is('client_id', null).maybeSingle();
    return ((data?.config as Record<string, unknown>)?.icp as Icp) ?? {};
  });
}

// Settings → scoring config. Prefer the caller's per-client row, fall
// back to the org-default row. Mirrors the (org, client) lookup pattern
// `getIcp` and the settings GET handler use so a client picks up its
// own scoring overrides — and otherwise inherits the org defaults —
// without leaking writes across clients.
async function getScoringConfig(org_id: string, client_id: string | null = null): Promise<ScoringConfig> {
  if (client_id) {
    const own = await supabaseAdmin
      .from('crm_settings').select('config')
      .eq('org_id', org_id).eq('client_id', client_id).maybeSingle();
    const cfg = (own.data?.config as Record<string, unknown> | null | undefined)?.scoring as ScoringConfig | undefined;
    if (cfg) return cfg;
  }
  const { data } = await supabaseAdmin
    .from('crm_settings').select('config')
    .eq('org_id', org_id).is('client_id', null).maybeSingle();
  return ((data?.config as Record<string, unknown>)?.scoring as ScoringConfig) ?? {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Engagement signals
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEngagement(org_id: string, lead_id: string): Promise<EngagementSignals> {
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: acts }, { data: updates }, { count: totalActs }] = await Promise.all([
    supabaseAdmin.from('crm_activities')
      .select('type, completed_at')
      .eq('org_id', org_id).eq('lead_id', lead_id).is('deleted_at', null)
      .gte('completed_at', since30d),
    supabaseAdmin.from('crm_lead_updates')
      .select('body, created_at')
      .eq('org_id', org_id).eq('lead_id', lead_id)
      .gte('created_at', since30d),
    supabaseAdmin.from('crm_activities')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', org_id).eq('lead_id', lead_id).is('deleted_at', null),
  ]);

  const out = { ...EMPTY_ENGAGEMENT };
  out.total_activity_count = totalActs ?? 0;
  let mostRecent: number | null = null;
  for (const a of (acts ?? [])) {
    const t = String(a.type || '').toLowerCase();
    if (t === 'whatsapp') out.whatsapp_count_30d += 1;
    else if (t === 'call') out.call_count_30d += 1;
    else if (t === 'meeting') out.meeting_count_30d += 1;
    else if (t === 'email') out.email_count_30d += 1;
    if (a.completed_at) {
      const tms = new Date(a.completed_at).getTime();
      if (mostRecent === null || tms > mostRecent) mostRecent = tms;
    }
  }
  for (const u of (updates ?? [])) {
    out.updates_count_30d += 1;
    if (BANT_REGEX.test(u.body || '')) out.bant_signals_in_updates += 1;
  }
  out.days_since_last_touch = mostRecent === null
    ? null
    : Math.floor((Date.now() - mostRecent) / 86_400_000);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristics — profile-specific. Breakdown contains ONLY the keys that
// apply to the chosen profile, so the UI no longer surfaces zero-valued
// B2B signals on B2C leads.
// ─────────────────────────────────────────────────────────────────────────────

function tieredScore(value: number, tiers: Array<[number, number]>): number {
  // tiers: [[threshold, points], ...] — first matching tier wins (descending).
  for (const [threshold, points] of tiers) {
    if (value >= threshold) return points;
  }
  return 0;
}

function scoreB2C(
  lead: Partial<Lead>,
  engagement: EngagementSignals,
  weightsOverride: Record<string, number> = {},
): ScoreBreakdown {
  const w = (k: string, def: number) => weightsOverride[k] ?? def;
  const b: ScoreBreakdown = { model: 'heuristic_b2c_v3' } as ScoreBreakdown;
  const L = lead as Record<string, unknown>;

  // ── Reachability — can a rep actually get hold of this person? ──
  if (lead.phone) {
    (b as any).phone_present = w('phone_present', 10);
    if (String(lead.phone).replace(/\D/g, '').length >= 10) (b as any).phone_valid = w('phone_valid', 3);
  }
  if (lead.email) (b as any).email_present = w('email_present', 5);
  if (Array.isArray(L.alternate_mobiles) && (L.alternate_mobiles as unknown[]).length > 0) (b as any).alt_mobiles = w('alt_mobiles', 3);
  // WhatsApp consent intentionally excluded from scoring (per tenant request);
  // marketing consent still contributes a small reachability signal.
  if (L.marketing_consent) (b as any).marketing_consent = w('marketing_consent', 3);

  // ── Profile quality / field verification ──
  if (lead.first_name && lead.last_name) (b as any).full_name = w('full_name', 4);
  if (lead.city || lead.country) (b as any).geo = w('geo', 5);
  // GPS captured on-site → a rep physically met this lead. Strong quality signal.
  const lat = Number(L.latitude), lng = Number(L.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
    (b as any).gps_verified = w('gps_verified', 8);
  }
  if (L.photo_url) (b as any).photo_captured = w('photo_captured', 5);
  if (L.address_line1 || L.postal_code) (b as any).address = w('address', 2);

  // ── Intent / lifecycle progression ──
  const status = String(lead.status || 'new').toLowerCase();
  if (status === 'qualified') (b as any).status = w('status_qualified', 18);
  else if (status === 'working' || status === 'nurturing') (b as any).status = w('status_working', 9);
  const stage = String(L.lifecycle_stage || '').toLowerCase();
  if (['customer', 'opportunity'].includes(stage)) (b as any).lifecycle = w('lifecycle_opportunity', 12);
  else if (['sql', 'mql'].includes(stage)) (b as any).lifecycle = w('lifecycle_qualified', 8);
  else if (stage === 'subscriber') (b as any).lifecycle = w('lifecycle_subscriber', 3);
  if (L.converted_deal_id || status === 'converted') (b as any).converted = w('converted', 15);

  // Product / volume interest — for a materials business, captured monthly
  // volume (MT) is a direct deal-size proxy.
  const cf = (L.custom_fields ?? {}) as Record<string, unknown>;
  const vol = Number(cf.monthly_volume ?? cf.volume_mt ?? cf.volume_kg);
  if (Number.isFinite(vol) && vol > 0) {
    (b as any).volume_interest = tieredScore(vol, [[50, w('volume_high', 12)], [10, w('volume_med', 8)], [1, w('volume_low', 4)]]);
  }
  const interests = L.interests, productIds = L.product_ids;
  if ((Array.isArray(interests) && interests.length > 0) || (Array.isArray(productIds) && productIds.length > 0)) {
    (b as any).product_interest = w('product_interest', 6);
  }
  if (Array.isArray(lead.tags) && lead.tags.length > 0) (b as any).tags = w('tags', 2);

  // ── Engagement (real activity) ──
  const wa = tieredScore(engagement.whatsapp_count_30d, [[3, w('whatsapp_high', 12)], [1, w('whatsapp_low', 6)]]);
  if (wa > 0) (b as any).whatsapp_30d = wa;
  const ca = tieredScore(engagement.call_count_30d, [[3, w('call_high', 10)], [1, w('call_low', 5)]]);
  if (ca > 0) (b as any).calls_30d = ca;
  const mt = tieredScore(engagement.meeting_count_30d, [[2, w('meet_high', 10)], [1, w('meet_low', 6)]]);
  if (mt > 0) (b as any).meetings_30d = mt;
  if (engagement.updates_count_30d > 0) (b as any).updates_30d = w('updates', 5);
  const hist = tieredScore(engagement.total_activity_count, [[5, w('history_high', 6)], [1, w('history_low', 3)]]);
  if (hist > 0) (b as any).activity_history = hist;

  // Recency of last touch.
  if (engagement.days_since_last_touch !== null) {
    if (engagement.days_since_last_touch < 7) (b as any).recent_touch = w('recent_touch_high', 8);
    else if (engagement.days_since_last_touch < 14) (b as any).recent_touch = w('recent_touch_med', 4);
  } else if (lead.last_activity_at) {
    const days = (Date.now() - new Date(lead.last_activity_at).getTime()) / 86_400_000;
    (b as any).recent_touch = Math.max(0, Math.round(w('recent_touch_fallback', 8) - days * 0.3));
  }

  // ── Source / attribution ──
  const utm = String(L.utm_medium || '').toLowerCase();
  const referralLike = String(lead.source_id || '').toLowerCase().includes('referral');
  if (referralLike) (b as any).source_quality = w('source_quality_referral', 10);
  else if (utm === 'cpc' || utm === 'paid' || utm === 'social') (b as any).source_quality = w('source_quality_paid', 6);
  else if (lead.source_id) (b as any).source_quality = w('source_quality_organic', 3);
  if (L.utm_campaign) (b as any).campaign = w('campaign', 2);

  return b;
}

function scoreB2B(
  lead: Partial<Lead>,
  icp: Icp,
  engagement: EngagementSignals,
  weightsOverride: Record<string, number> = {},
): ScoreBreakdown {
  const w = (k: string, def: number) => weightsOverride[k] ?? def;
  const b: ScoreBreakdown = { model: 'heuristic_b2b_v3' } as ScoreBreakdown;
  const L = lead as Record<string, unknown>;

  // ── Firmographics ──
  const t = (lead.title || '').toLowerCase();
  if (/(ceo|cto|cfo|cmo|coo|chief|founder|owner|proprietor)/.test(t)) (b as any).title_seniority = w('title_executive', 18);
  else if (/(vp|vice president|head of)/.test(t)) (b as any).title_seniority = w('title_vp', 13);
  else if (/(director)/.test(t)) (b as any).title_seniority = w('title_director', 9);
  else if (/(manager|lead)/.test(t)) (b as any).title_seniority = w('title_manager', 5);
  else if (t) (b as any).title_seniority = w('title_ic', 2);

  if (lead.company) (b as any).company_present = w('company_present', 7);
  if (icp.industries?.length && lead.industry &&
      icp.industries.some((i) => i.toLowerCase() === (lead.industry || '').toLowerCase())) {
    (b as any).industry_match = w('industry_match', 7);
  }

  // ── Contact completeness / verification ──
  const hasEmail = !!lead.email, hasPhone = !!lead.phone;
  if (hasEmail && hasPhone) (b as any).contact_complete = w('contact_both', 8);
  else if (hasEmail || hasPhone) (b as any).contact_complete = w('contact_one', 4);
  const lat = Number(L.latitude), lng = Number(L.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) (b as any).gps_verified = w('gps_verified', 6);
  if (L.photo_url) (b as any).photo_captured = w('photo_captured', 4);
  if (lead.city || lead.country) (b as any).geo = w('geo', 3);

  // ── Intent / lifecycle ──
  const status = String(lead.status || 'new').toLowerCase();
  if (status === 'qualified') (b as any).status = w('status_qualified', 14);
  else if (status === 'working' || status === 'nurturing') (b as any).status = w('status_working', 7);
  const stage = String(L.lifecycle_stage || '').toLowerCase();
  if (['customer', 'opportunity'].includes(stage)) (b as any).lifecycle = w('lifecycle_opportunity', 10);
  else if (['sql', 'mql'].includes(stage)) (b as any).lifecycle = w('lifecycle_qualified', 6);
  if (L.converted_deal_id || status === 'converted') (b as any).converted = w('converted', 12);
  const cf = (L.custom_fields ?? {}) as Record<string, unknown>;
  const vol = Number(cf.monthly_volume ?? cf.volume_mt ?? cf.volume_kg);
  if (Number.isFinite(vol) && vol > 0) {
    (b as any).volume_interest = tieredScore(vol, [[50, w('volume_high', 10)], [10, w('volume_med', 6)], [1, w('volume_low', 3)]]);
  }

  if (lead.source_id) (b as any).source_quality = w('source_quality', 6);

  // ── Engagement ──
  const mt = tieredScore(engagement.meeting_count_30d, [[3, w('meetings_high', 12)], [1, w('meetings_low', 6)]]);
  if (mt > 0) (b as any).meetings_30d = mt;
  const ca = tieredScore(engagement.call_count_30d, [[3, w('calls_high', 8)], [1, w('calls_low', 4)]]);
  if (ca > 0) (b as any).calls_30d = ca;
  const hist = tieredScore(engagement.total_activity_count, [[5, w('history_high', 6)], [1, w('history_low', 3)]]);
  if (hist > 0) (b as any).activity_history = hist;

  // BANT signals from updates — qualifying conversations the heuristic can't see.
  if (engagement.bant_signals_in_updates > 0) (b as any).bant_signals_in_updates = w('bant_signals', 12);
  else if (engagement.updates_count_30d > 0) (b as any).updates_30d = w('updates_present', 4);

  if (engagement.days_since_last_touch !== null) {
    if (engagement.days_since_last_touch < 7) (b as any).recent_touch = w('recent_touch', 7);
    else if (engagement.days_since_last_touch < 14) (b as any).recent_touch = w('recent_touch_med', 3);
  } else if (lead.last_activity_at) {
    const days = (Date.now() - new Date(lead.last_activity_at).getTime()) / 86_400_000;
    (b as any).recent_touch = Math.max(0, Math.round(w('recent_touch_fallback', 7) - days * 0.25));
  }

  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grade computation
// ─────────────────────────────────────────────────────────────────────────────

export function gradeFromScore(score: number, thresholds: { A?: number; B?: number; C?: number } = {}): 'A' | 'B' | 'C' | 'D' {
  const tA = thresholds.A ?? DEFAULT_THRESHOLDS.A;
  const tB = thresholds.B ?? DEFAULT_THRESHOLDS.B;
  const tC = thresholds.C ?? DEFAULT_THRESHOLDS.C;
  if (score >= tA) return 'A';
  if (score >= tB) return 'B';
  if (score >= tC) return 'C';
  return 'D';
}

function sumBreakdown(b: ScoreBreakdown): number {
  let s = 0;
  for (const [k, v] of Object.entries(b)) {
    if (k === 'model' || k === 'total' || k === 'llm_adjustment' || k === 'llm_confidence' || k === 'llm_reasons') continue;
    if (typeof v === 'number') s += v;
  }
  return Math.max(0, Math.min(100, s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface ComputeScoreOptions {
  // Skip the per-lead engagement fetch. Use for lead creation where the
  // lead just got inserted and there are no activities yet anyway.
  skipEngagement?: boolean;
  // Pre-loaded engagement (e.g. when the caller already pulled them).
  engagement?: EngagementSignals;
  // Pre-loaded ICP — saves a cache hit if the caller already has it.
  icp?: Icp;
  // Pre-loaded scoring config (per-tenant overrides).
  scoringConfig?: ScoringConfig;
}

export async function computeUnifiedScore(
  org_id: string,
  client_id: string | null,
  lead: Partial<Lead>,
  opts: ComputeScoreOptions = {},
): Promise<{
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  breakdown: ScoreBreakdown;
  engagement: EngagementSignals;
  profile: 'b2c' | 'b2b';
}> {
  const icp = opts.icp ?? await getIcp(org_id, client_id);
  const config = opts.scoringConfig ?? await getScoringConfig(org_id, client_id);

  // Profile selection — tenant override beats per-lead is_b2c.
  const force = config.active_profile;
  const profile: 'b2c' | 'b2b' = force === 'b2c' ? 'b2c'
    : force === 'b2b' ? 'b2b'
    : (((lead as any).is_b2c === true) ? 'b2c' : 'b2b');

  // Engagement — skip on creation (no activities yet), fetch otherwise
  // unless the caller pre-loaded them.
  const engagement: EngagementSignals = opts.engagement
    ?? (opts.skipEngagement || !lead.id
      ? { ...EMPTY_ENGAGEMENT }
      : await fetchEngagement(org_id, String(lead.id)));

  const breakdown = profile === 'b2c'
    ? scoreB2C(lead, engagement, config.weights?.b2c ?? {})
    : scoreB2B(lead, icp, engagement, config.weights?.b2b ?? {});

  const score = sumBreakdown(breakdown);
  breakdown.total = score;
  const grade = gradeFromScore(score, config.grade_thresholds);
  return { score, grade, breakdown, engagement, profile };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM rerank — profile-aware system prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_B2B = `You are a B2B sales lead qualification expert. Given a lead profile, heuristic score, and engagement signals, return JSON only:
{"adjustment": int -15..15, "reasons": [string], "confidence": "low"|"med"|"high"}.
Weigh title seniority, company fit with the ICP, recent meetings/calls, and BANT cues mentioned in free-form updates. Stay within ±15 of the heuristic unless a strong signal demands more. Output JSON only, no prose.`;

const SYSTEM_PROMPT_B2C = `You are a consumer-direct (B2C) lead qualification expert. Given a lead profile, heuristic score, and engagement signals, return JSON only:
{"adjustment": int -15..15, "reasons": [string], "confidence": "low"|"med"|"high"}.
For B2C, job title and company size are NOT relevant. Weigh reachability (phone present, recent inbound message), engagement (WhatsApp / call activity in the last 30 days, updates mentioning interest), source quality (referral > paid > organic), and consent flags (marketing, WhatsApp). Stay within ±15 of the heuristic unless a strong signal demands more. Output JSON only, no prose.`;

export async function rerankWithLlmV2(
  org_id: string,
  lead: Partial<Lead>,
  base: { score: number; breakdown: ScoreBreakdown; engagement: EngagementSignals; profile: 'b2c' | 'b2b' },
): Promise<{ score: number; breakdown: ScoreBreakdown }> {
  try {
    const userPayload = {
      profile: base.profile,
      lead: {
        first_name: lead.first_name, last_name: lead.last_name, email: lead.email,
        phone: lead.phone, company: lead.company, title: lead.title, industry: lead.industry,
        country: lead.country, city: lead.city, source_id: lead.source_id,
        is_b2c: (lead as any).is_b2c,
        marketing_consent: (lead as any).marketing_consent,
        whatsapp_consent: (lead as any).whatsapp_consent,
        latest_update: (lead as any).latest_update,
      },
      heuristic_score: base.score,
      heuristic_breakdown: base.breakdown,
      engagement: base.engagement,
      icp: base.profile === 'b2b' ? await getIcp(org_id) : null,
    };
    const response = await aiComplete({
      org_id,
      model: process.env.CRM_LEAD_SCORING_MODEL || 'claude-haiku-4-5-20251001',
      system: base.profile === 'b2c' ? SYSTEM_PROMPT_B2C : SYSTEM_PROMPT_B2B,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 300,
    });
    const parsed = JSON.parse(extractJson(response));
    const adjustment = clamp(Number(parsed.adjustment ?? 0), -15, 15);
    const final = clamp(base.score + adjustment, 0, 100);
    const breakdown: ScoreBreakdown = {
      ...base.breakdown,
      llm_adjustment: adjustment,
      llm_reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5) : [],
      llm_confidence: ['low', 'med', 'high'].includes(parsed.confidence) ? parsed.confidence : 'med',
      total: final,
      model: `${base.breakdown.model}+llm_rerank_v2`,
    };
    return { score: final, breakdown };
  } catch {
    return { score: base.score, breakdown: base.breakdown };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Back-compat — kept so older callers don't break. New code should use
// computeUnifiedScore + rerankWithLlmV2 directly.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use computeUnifiedScore. Kept for back-compat with older callers. */
export function computeHeuristic(
  lead: Partial<Lead>,
  icp: Icp,
): { score: number; breakdown: ScoreBreakdown } {
  // Synchronous shim — engagement is empty, so the score is a "no activity
  // yet" baseline. Callers that need real engagement should switch to
  // computeUnifiedScore.
  const isB2C = (lead as any).is_b2c === true;
  const breakdown = isB2C
    ? scoreB2C(lead, EMPTY_ENGAGEMENT, {})
    : scoreB2B(lead, icp, EMPTY_ENGAGEMENT, {});
  const score = sumBreakdown(breakdown);
  breakdown.total = score;
  return { score, breakdown };
}

/** @deprecated Use rerankWithLlmV2. */
export async function rerankWithLlm(
  org_id: string,
  lead: Partial<Lead>,
  base: { score: number; breakdown: ScoreBreakdown },
): Promise<{ score: number; breakdown: ScoreBreakdown }> {
  const profile: 'b2c' | 'b2b' = ((lead as any).is_b2c === true) ? 'b2c' : 'b2b';
  return rerankWithLlmV2(org_id, lead, { ...base, engagement: EMPTY_ENGAGEMENT, profile });
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}

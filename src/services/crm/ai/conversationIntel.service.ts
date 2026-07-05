/**
 * Conversation Intelligence — a rep records a customer conversation on a lead;
 * we transcribe it (Sarvam Saarika, diarized), analyze it with Claude (Sonnet 5),
 * and store structured insights on the lead. Consent is mandatory (DPDP).
 *
 * Pipeline (states on conversation_recordings.status):
 *   recorded  -> createRecording()  (row + signed upload URL returned to client)
 *   uploaded  -> markUploaded()     (client PUT the audio, then calls this)
 *   transcribing / analyzing        (processAsync, fire-and-forget)
 *   complete | failed
 *
 * Tenant-agnostic: everything is org_id + client_id scoped. Gated to a client
 * via the `crm_conversation_intel` module (requireModuleAccess on the route).
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { AppError } from '../../../utils';
import { logger } from '../../../lib/logger';
import { AIService } from '../../ai.service';
import { transcribe, sarvamConfigured, type DiarizedSegment } from '../../integrations/sarvam';

export interface Actor { id: string; org_id: string; client_id?: string | null; role?: string | null }

const BUCKET = process.env.SUPABASE_CONVERSATION_BUCKET || 'conversation-audio';
const MODEL = process.env.CONVERSATION_INTEL_MODEL || 'claude-sonnet-5';
const PLAYBACK_TTL = 60 * 60; // 1h signed URL for playback / Sarvam ingest

const ADMIN_ROLES = ['admin', 'super_admin', 'main_admin', 'org_admin', 'sub_admin', 'client'];
const isManager = (r?: string | null) => ADMIN_ROLES.includes((r ?? '').toLowerCase());

async function notify(org_id: string, user_id: string | null, title: string, body: string, data: Record<string, string>) {
  if (!user_id) return;
  try { await supabaseAdmin.from('notifications').insert({ org_id, user_id, title, body, type: 'crm_conversation', data }); }
  catch (e: any) { logger.warn(`[conv-intel] notify failed: ${e?.message || e}`); }
}

function audioPath(org_id: string, lead_id: string, ext: string): string {
  const safe = (ext || 'm4a').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'm4a';
  const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  return `org/${org_id}/conversations/${lead_id}/${id}.${safe}`;
}

/**
 * Step 1 — create the recording row (consent required) and hand back a signed
 * upload URL the client PUTs the audio to.
 */
export async function createRecording(actor: Actor, lead_id: string, body: {
  consent?: boolean; consent_method?: string; duration_seconds?: number; ext?: string; language?: string;
}) {
  if (!body.consent) throw new AppError(400, 'Recording consent is required', 'CONSENT_REQUIRED');

  // Confirm the lead belongs to this org (and client, if scoped).
  const { data: lead } = await supabaseAdmin.from('crm_leads').select('id, client_id').eq('org_id', actor.org_id).eq('id', lead_id).maybeSingle();
  if (!lead) throw new AppError(404, 'Lead not found', 'NOT_FOUND');

  const path = audioPath(actor.org_id, lead_id, body.ext || 'm4a');
  const { data: signed, error: sErr } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (sErr) throw new AppError(500, `Upload URL failed: ${sErr.message}`, 'STORAGE');

  const { data, error } = await supabaseAdmin.from('conversation_recordings').insert({
    org_id: actor.org_id, client_id: actor.client_id ?? (lead as any).client_id ?? null,
    lead_id, user_id: actor.id,
    consent_captured: true, consent_method: body.consent_method || 'in_app', consent_at: new Date().toISOString(),
    audio_path: path, duration_seconds: body.duration_seconds ?? null, language: body.language ?? null,
    status: 'recorded',
  }).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB');

  return { id: (data as any).id, upload_url: signed.signedUrl, token: signed.token, bucket: BUCKET, path, expires_in: PLAYBACK_TTL };
}

/** Step 2 — client has uploaded the audio; kick off the async pipeline. */
export async function markUploaded(actor: Actor, id: string) {
  const { data: rec } = await supabaseAdmin.from('conversation_recordings')
    .select('id, status, consent_captured').eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!rec) throw new AppError(404, 'Recording not found', 'NOT_FOUND');
  if (!(rec as any).consent_captured) throw new AppError(400, 'Consent not captured', 'CONSENT_REQUIRED');

  await supabaseAdmin.from('conversation_recordings').update({ status: 'uploaded', updated_at: new Date().toISOString() }).eq('id', id);
  // Fire-and-forget: transcription + analysis can take tens of seconds.
  processAsync(id).catch((e) => logger.error(`[conv-intel] process ${id} failed: ${e?.message || e}`));
  return { ok: true, status: 'processing' };
}

/** The heavy pipeline: transcribe -> analyze -> store. Runs detached. */
async function processAsync(id: string): Promise<void> {
  const { data: rec } = await supabaseAdmin.from('conversation_recordings').select('*').eq('id', id).maybeSingle();
  if (!rec) return;
  const r = rec as any;
  if (!r.consent_captured) { await fail(id, 'Consent not captured'); return; }
  if (!sarvamConfigured()) { await fail(id, 'Transcription provider not configured (SARVAM_API_KEY)'); return; }

  try {
    await supabaseAdmin.from('conversation_recordings').update({ status: 'transcribing', updated_at: new Date().toISOString() }).eq('id', id);

    // Download the audio from storage.
    const { data: blob, error: dErr } = await supabaseAdmin.storage.from(BUCKET).download(r.audio_path);
    if (dErr || !blob) throw new Error(`audio download failed: ${dErr?.message || 'missing'}`);
    const audio = Buffer.from(await blob.arrayBuffer());
    const filename = String(r.audio_path).split('/').pop() || 'audio.m4a';

    const t = await transcribe({
      audio, filename, languageCode: r.language || 'unknown', diarize: true,
      // Persist the Sarvam job_id the moment we have it so a subsequent
      // failure is still traceable to the exact job for debugging.
      onJob: async (jobId) => {
        await supabaseAdmin.from('conversation_recordings')
          .update({ sarvam_job_id: jobId, updated_at: new Date().toISOString() })
          .eq('id', id);
      },
    });

    await supabaseAdmin.from('conversation_recordings').update({
      status: 'analyzing', transcript: t.transcript, diarization: t.segments,
      language: t.language || r.language || null, sarvam_job_id: t.jobId,
      updated_at: new Date().toISOString(),
    }).eq('id', id);

    // Lead context sharpens the analysis (name, city, stage, product interest).
    const { data: lead } = await supabaseAdmin.from('crm_leads')
      .select('name, city, state, status, lifecycle_stage, source, score').eq('id', r.lead_id).maybeSingle();

    const insights = await analyze(t.transcript, t.segments, lead as any);

    await supabaseAdmin.from('conversation_recordings').update({
      status: 'complete', insights, updated_at: new Date().toISOString(),
    }).eq('id', id);

    const intent = insights?.intent?.stage ? ` · intent: ${insights.intent.stage}` : '';
    await notify(r.org_id, r.user_id, 'Call analysis ready',
      `KINI analyzed your conversation${intent}. Tap to see positives, gaps and next steps.`,
      { type: 'conversation_ready', recording_id: id, lead_id: r.lead_id });
  } catch (e: any) {
    await fail(id, e?.message || String(e));
  }
}

async function fail(id: string, message: string) {
  logger.warn(`[conv-intel] ${id} failed: ${message}`);
  await supabaseAdmin.from('conversation_recordings').update({
    status: 'failed', error: String(message).slice(0, 2000), updated_at: new Date().toISOString(),
  }).eq('id', id);
}

const SYSTEM = `You are KINI, a sales-conversation analyst for a building-materials brand (TMT steel rebar) selling to individual home builders (IHBs) in India via field reps ("Consumer Champions"). You are given a diarized transcript (Hindi/Hinglish/English) of a rep↔customer conversation.
Return ONLY a JSON object (no prose, no markdown) with EXACTLY these keys:
{
  "summary": string,                              // 3-4 line recap
  "intent": { "stage": string, "score": number, "signals": string[] },  // stage e.g. "exploring"|"comparing"|"ready_to_buy"; score 0-100
  "sentiment": { "overall": string, "trajectory": string },             // e.g. "positive"; "improved"|"declined"|"flat"
  "positives": string[],                          // what the rep did well
  "improvements": string[],                       // missed opportunities / what to do better
  "objections": [ { "type": string, "handled": string, "note": string } ], // handled: "well"|"partially"|"poorly"|"ignored"
  "competitors": [ { "name": string, "context": string } ],
  "commitments": string[],                        // concrete next steps the customer agreed to
  "extracted": { "grade": string, "quantity_tonnes": string, "budget": string, "timeline": string, "project_stage": string, "decision_maker": string },
  "coaching": { "talk_listen_ratio": string, "missed_questions": string[], "tips": string[] },
  "next_action": string,                          // the single best next step for the rep
  "draft_followup": string,                        // a short WhatsApp/call follow-up the rep can send
  "risk_flags": string[]                          // over-promises, unauthorized discounts, consent/compliance concerns
}
Use "" or [] where unknown. Base everything strictly on the transcript. Compute talk_listen_ratio from the diarized speakers when possible.`;

/** Analyze the transcript with Claude Sonnet 5 -> structured insights JSON. */
export async function analyze(transcript: string, segments: DiarizedSegment[], lead?: any): Promise<any> {
  if (!transcript?.trim()) return { summary: 'Empty or inaudible recording.', risk_flags: ['no_transcript'] };

  const ctx = lead ? `Lead context: name=${lead.name ?? ''}, city=${lead.city ?? ''}, status=${lead.status ?? ''}, stage=${lead.lifecycle_stage ?? ''}, score=${lead.score ?? ''}.` : '';
  const diar = segments?.length
    ? segments.map((s) => `[${s.speaker}] ${s.text}`).join('\n').slice(0, 12000)
    : transcript.slice(0, 12000);
  const userMsg = `${ctx}\n\nDiarized transcript:\n${diar}`;

  const apiKey = await AIService.getFunctionalKey();
  const res = await AIService.anthropicFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1800,
      // Sonnet 5 runs adaptive thinking when `thinking` is omitted, which would
      // put an (empty) thinking block first in `content`. Disable it so the
      // first block is our JSON text and cost stays predictable.
      thinking: { type: 'disabled' },
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }),
  }, 90_000);

  if (!res.ok) {
    const err = await res.json().catch(() => ({} as any));
    throw new Error(`analysis failed (${res.status}): ${(err as any)?.error?.message || ''}`);
  }
  const data: any = await res.json();
  const textBlock = (data?.content || []).find((b: any) => b.type === 'text');
  const text: string = textBlock?.text || data?.content?.[0]?.text || '';
  const jsonStr = extractJson(text);
  try { return JSON.parse(jsonStr); }
  catch { return { summary: text.slice(0, 800), risk_flags: ['analysis_parse_error'] }; }
}

function extractJson(s: string): string {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

// ── reads ──────────────────────────────────────────────────────────────────

/** A rep's conversations on one lead (own scope) — list view (no full transcript). */
export async function listForLead(actor: Actor, lead_id: string) {
  const { data, error } = await supabaseAdmin.from('conversation_recordings')
    .select('id, status, duration_seconds, language, insights, created_at, user_id')
    .eq('org_id', actor.org_id).eq('lead_id', lead_id)
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw new AppError(500, error.message, 'DB');
  return (data ?? []).map((r: any) => ({
    id: r.id, status: r.status, duration_seconds: r.duration_seconds, language: r.language, created_at: r.created_at,
    intent: r.insights?.intent?.stage ?? null, sentiment: r.insights?.sentiment?.overall ?? null,
    summary: r.insights?.summary ?? null,
  }));
}

/** Full record incl. insights + a short-lived signed playback URL. */
export async function getOne(actor: Actor, id: string) {
  const { data, error } = await supabaseAdmin.from('conversation_recordings')
    .select('*').eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB');
  if (!data) throw new AppError(404, 'Recording not found', 'NOT_FOUND');
  const r = data as any;
  // Non-managers may only open their own recordings.
  if (!isManager(actor.role) && r.user_id !== actor.id) throw new AppError(403, 'Not permitted', 'FORBIDDEN');

  let audio_url: string | null = null;
  if (r.audio_path) {
    const { data: signed } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(r.audio_path, PLAYBACK_TTL);
    audio_url = signed?.signedUrl ?? null;
  }
  return { ...r, audio_url };
}

/** Manager/dashboard list across the org — champion name + lead name + insights. */
export async function listForOrg(actor: Actor, filters: { lead_id?: string; user_id?: string; limit?: number } = {}) {
  if (!isManager(actor.role)) throw new AppError(403, 'Managers only', 'FORBIDDEN');
  let q = supabaseAdmin.from('conversation_recordings')
    .select('id, lead_id, user_id, status, duration_seconds, language, insights, created_at')
    .eq('org_id', actor.org_id).order('created_at', { ascending: false }).limit(filters.limit ?? 100);
  if (actor.client_id) q = q.eq('client_id', actor.client_id);
  if (filters.lead_id) q = q.eq('lead_id', filters.lead_id);
  if (filters.user_id) q = q.eq('user_id', filters.user_id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  const rows = data ?? [];
  if (!rows.length) return [];

  // Stamp champion + lead names in one batch each.
  const userIds = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
  const leadIds = Array.from(new Set(rows.map((r: any) => r.lead_id).filter(Boolean)));
  const [{ data: users }, { data: leads }] = await Promise.all([
    supabaseAdmin.from('users').select('id, name, employee_id').in('id', userIds),
    supabaseAdmin.from('crm_leads').select('id, name, phone, city').in('id', leadIds),
  ]);
  const uMap = new Map((users ?? []).map((u: any) => [u.id, u]));
  const lMap = new Map((leads ?? []).map((l: any) => [l.id, l]));
  return rows.map((r: any) => {
    const u = uMap.get(r.user_id); const l = lMap.get(r.lead_id);
    return {
      id: r.id, status: r.status, created_at: r.created_at, duration_seconds: r.duration_seconds, language: r.language,
      champion_name: u?.name ?? null, employee_id: u?.employee_id ?? null,
      lead_id: r.lead_id, lead_name: l?.name ?? null, lead_city: l?.city ?? null,
      intent: r.insights?.intent?.stage ?? null, intent_score: r.insights?.intent?.score ?? null,
      sentiment: r.insights?.sentiment?.overall ?? null, summary: r.insights?.summary ?? null,
    };
  });
}

// ── Analytics (aggregated insights for the manager charts) ───────────────────

const INTENT_ORDER = ['exploring', 'comparing', 'evaluating', 'negotiating', 'ready_to_buy', 'closed_won', 'closed_lost'];

function normStage(s: any): string {
  const t = String(s ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return t || 'unknown';
}
function normSentiment(s: any): 'positive' | 'neutral' | 'negative' {
  const t = String(s ?? '').toLowerCase();
  if (/(positive|good|warm|hot|high|happy)/.test(t)) return 'positive';
  if (/(negative|poor|cold|bad|low|angry|frustrat|unhappy)/.test(t)) return 'negative';
  return 'neutral';
}
function normTrajectory(s: any): 'improved' | 'declined' | 'flat' {
  const t = String(s ?? '').toLowerCase();
  if (/(improv|up|better|rising|warm|positive)/.test(t)) return 'improved';
  if (/(declin|down|worse|drop|cool|negative)/.test(t)) return 'declined';
  return 'flat';
}
// Fold the model's 4-way objection outcome into a 3-bucket status scale so the
// chart's colours (green / amber / red) stay CVD-separable (amber↔orange fail).
function normHandled(s: any): 'well' | 'partially' | 'poor' {
  const t = String(s ?? '').toLowerCase();
  if (/(well|good|strong|full|resolved)/.test(t)) return 'well';
  if (/(partial|some|attempt)/.test(t)) return 'partially';
  return 'poor'; // poorly / ignored / missed / none
}
/** "55:45 (...)" | "55/45" | 0.55 | 55 → rep talk-share %, or null if unparseable. */
function parseTalkPct(v: any): number | null {
  if (typeof v === 'number' && isFinite(v)) {
    if (v > 1 && v <= 100) return Math.round(v);
    if (v > 0 && v <= 1) return Math.round(v * 100);
    return null;
  }
  const m = /(\d{1,3})\s*[:/]\s*(\d{1,3})/.exec(String(v ?? ''));
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (a + b === 0) return null;
  return Math.round((a / (a + b)) * 100);
}
function dayKey(iso: string): string {
  return String(iso).slice(0, 10); // YYYY-MM-DD (UTC) — stable bucket per day
}

export interface ConversationAnalytics {
  window_days: number;
  totals: {
    total: number; analyzed: number; reps: number; leads: number;
    avg_intent_score: number | null; avg_talk_pct: number | null;
    risk_calls: number; commitment_calls: number;
  };
  intent_stages: Array<{ key: string; count: number }>;
  sentiment: Array<{ key: 'positive' | 'neutral' | 'negative'; count: number }>;
  trajectory: Array<{ key: 'improved' | 'flat' | 'declined'; count: number }>;
  objections: Array<{ type: string; count: number; well: number; partially: number; poor: number }>;
  handling: { well: number; partially: number; poor: number };
  competitors: Array<{ name: string; count: number }>;
  timeline: Array<{ date: string; count: number; avg_score: number | null }>;
  reps: Array<{ user_id: string; name: string; calls: number; avg_intent_score: number | null; avg_talk_pct: number | null; positive: number; neutral: number; negative: number }>;
}

/**
 * Aggregate the structured insights across analyzed conversations into
 * chart-ready series for the manager "Conversation Analytics" view. Manager-only;
 * org + client scoped. `city` routes through the linked lead (recordings carry
 * no geo column). Everything is computed from real rows — empty series come back
 * empty (the UI renders empty states) rather than being fabricated.
 */
export async function analyticsForOrg(actor: Actor, filters: { user_id?: string; city?: string; days?: number } = {}) {
  if (!isManager(actor.role)) throw new AppError(403, 'Managers only', 'FORBIDDEN');
  const days = Math.min(Math.max(Math.round(filters.days ?? 90), 1), 365);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  const empty: ConversationAnalytics = {
    window_days: days,
    totals: { total: 0, analyzed: 0, reps: 0, leads: 0, avg_intent_score: null, avg_talk_pct: null, risk_calls: 0, commitment_calls: 0 },
    intent_stages: [], sentiment: [], trajectory: [], objections: [], handling: { well: 0, partially: 0, poor: 0 },
    competitors: [], timeline: [], reps: [],
  };

  let q = supabaseAdmin.from('conversation_recordings')
    .select('id, user_id, lead_id, status, duration_seconds, insights, created_at')
    .eq('org_id', actor.org_id)
    .eq('status', 'complete')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (actor.client_id) q = q.eq('client_id', actor.client_id);
  if (filters.user_id) q = q.eq('user_id', filters.user_id);

  // City filter routes through the linked lead — recordings have no geo column.
  if (filters.city) {
    let lq = supabaseAdmin.from('crm_leads').select('id').eq('org_id', actor.org_id).ilike('city', filters.city);
    if (actor.client_id) lq = lq.eq('client_id', actor.client_id);
    const { data: leadRows } = await lq.limit(5000);
    const ids = (leadRows ?? []).map((l: any) => l.id).filter(Boolean);
    if (!ids.length) return empty;
    q = q.in('lead_id', ids);
  }

  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  const rows = (data ?? []).filter((r: any) => r.insights && typeof r.insights === 'object');
  if (!rows.length) return empty;

  const stageMap = new Map<string, number>();
  const sentMap = { positive: 0, neutral: 0, negative: 0 };
  const trajMap = { improved: 0, flat: 0, declined: 0 };
  const handling = { well: 0, partially: 0, poor: 0 };
  const objByType = new Map<string, { count: number; well: number; partially: number; poor: number }>();
  const compMap = new Map<string, number>();
  const timeMap = new Map<string, { count: number; scoreSum: number; scoreN: number }>();
  const repMap = new Map<string, { calls: number; scoreSum: number; scoreN: number; talkSum: number; talkN: number; positive: number; neutral: number; negative: number }>();

  let scoreSum = 0, scoreN = 0, talkSum = 0, talkN = 0, riskCalls = 0, commitCalls = 0;
  const leadSet = new Set<string>();

  for (const r of rows) {
    const ins = r.insights as any;
    if (r.lead_id) leadSet.add(r.lead_id);

    const stage = normStage(ins?.intent?.stage);
    if (stage !== 'unknown') stageMap.set(stage, (stageMap.get(stage) ?? 0) + 1);

    const score = Number(ins?.intent?.score);
    const hasScore = isFinite(score);
    if (hasScore) { scoreSum += score; scoreN++; }

    const sent = normSentiment(ins?.sentiment?.overall);
    sentMap[sent]++;
    trajMap[normTrajectory(ins?.sentiment?.trajectory)]++;

    const talk = parseTalkPct(ins?.coaching?.talk_listen_ratio);
    if (talk != null) { talkSum += talk; talkN++; }

    if (Array.isArray(ins?.risk_flags) && ins.risk_flags.length) riskCalls++;
    if (Array.isArray(ins?.commitments) && ins.commitments.length) commitCalls++;

    for (const o of (Array.isArray(ins?.objections) ? ins.objections : [])) {
      const type = String(o?.type ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_') || 'other';
      const h = normHandled(o?.handled);
      handling[h]++;
      const e = objByType.get(type) ?? { count: 0, well: 0, partially: 0, poor: 0 };
      e.count++; e[h]++;
      objByType.set(type, e);
    }
    for (const c of (Array.isArray(ins?.competitors) ? ins.competitors : [])) {
      const name = String(c?.name ?? '').trim();
      if (name) compMap.set(name, (compMap.get(name) ?? 0) + 1);
    }

    const dk = dayKey(r.created_at);
    const tm = timeMap.get(dk) ?? { count: 0, scoreSum: 0, scoreN: 0 };
    tm.count++; if (hasScore) { tm.scoreSum += score; tm.scoreN++; }
    timeMap.set(dk, tm);

    if (r.user_id) {
      const rm = repMap.get(r.user_id) ?? { calls: 0, scoreSum: 0, scoreN: 0, talkSum: 0, talkN: 0, positive: 0, neutral: 0, negative: 0 };
      rm.calls++;
      if (hasScore) { rm.scoreSum += score; rm.scoreN++; }
      if (talk != null) { rm.talkSum += talk; rm.talkN++; }
      rm[sent]++;
      repMap.set(r.user_id, rm);
    }
  }

  // Resolve rep display names in one batch.
  const repIds = Array.from(repMap.keys());
  const { data: users } = repIds.length
    ? await supabaseAdmin.from('users').select('id, name, employee_id').in('id', repIds)
    : { data: [] as any[] };
  const uMap = new Map((users ?? []).map((u: any) => [u.id, u]));

  const stageRank = (k: string) => { const i = INTENT_ORDER.indexOf(k); return i === -1 ? 99 : i; };
  const avg = (sum: number, n: number) => (n ? Math.round((sum / n) * 10) / 10 : null);

  const result: ConversationAnalytics = {
    window_days: days,
    totals: {
      total: rows.length,
      analyzed: rows.length,
      reps: repMap.size,
      leads: leadSet.size,
      avg_intent_score: avg(scoreSum, scoreN),
      avg_talk_pct: avg(talkSum, talkN),
      risk_calls: riskCalls,
      commitment_calls: commitCalls,
    },
    intent_stages: Array.from(stageMap, ([key, count]) => ({ key, count }))
      .sort((a, b) => stageRank(a.key) - stageRank(b.key) || b.count - a.count),
    sentiment: (['positive', 'neutral', 'negative'] as const).map((key) => ({ key, count: sentMap[key] })),
    trajectory: (['improved', 'flat', 'declined'] as const).map((key) => ({ key, count: trajMap[key] })),
    objections: Array.from(objByType, ([type, v]) => ({ type, count: v.count, well: v.well, partially: v.partially, poor: v.poor }))
      .sort((a, b) => b.count - a.count).slice(0, 8),
    handling,
    competitors: Array.from(compMap, ([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 8),
    timeline: Array.from(timeMap, ([date, v]) => ({ date, count: v.count, avg_score: avg(v.scoreSum, v.scoreN) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    reps: Array.from(repMap, ([user_id, v]) => ({
      user_id,
      name: uMap.get(user_id)?.name ?? uMap.get(user_id)?.employee_id ?? 'Unknown',
      calls: v.calls,
      avg_intent_score: avg(v.scoreSum, v.scoreN),
      avg_talk_pct: avg(v.talkSum, v.talkN),
      positive: v.positive, neutral: v.neutral, negative: v.negative,
    })).sort((a, b) => b.calls - a.calls || (b.avg_intent_score ?? 0) - (a.avg_intent_score ?? 0)),
  };
  return result;
}

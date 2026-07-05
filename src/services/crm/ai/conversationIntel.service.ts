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

    const t = await transcribe({ audio, filename, languageCode: r.language || 'unknown', diarize: true });

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
    status: 'failed', error: String(message).slice(0, 500), updated_at: new Date().toISOString(),
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

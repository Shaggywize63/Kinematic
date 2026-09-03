/**
 * Telephony call-recording ingest — turn a provider's completed, recorded call
 * into an analyzed conversation_recording.
 *
 * A telephony provider (Exotel / Knowlarity / Ozonetel / Twilio / Plivo) is
 * pointed at the call-recording webhook (provider 'call_recording' in the
 * integrations framework). On call completion it POSTs the caller number, the
 * recording URL and call metadata. We:
 *   1. resolve the lead by caller phone (dedup-by-phone, same as every other
 *      channel), creating one if this is a new number;
 *   2. attribute it to the lead's owner (the rep) — user_id is NOT NULL;
 *   3. download the recording audio;
 *   4. hand it to ingestExternalRecording, which runs Sarvam -> KINI.
 *
 * Provider-agnostic: reads the caller / recording / status / duration fields
 * across the shapes the major providers use, mirroring ivrMissedCall. Reuses
 * the analysis pipeline unchanged — this is purely a capture/ingest path.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { findOrCreateLead } from '../integrations/dedup.orchestrator';
import { ingestExternalRecording } from './conversationIntel.service';

const CALLER_ALIASES = ['CallFrom', 'From', 'from', 'caller_id', 'caller', 'caller_number', 'source', 'src', 'phone', 'mobile', 'customer_number', 'A_PARTY'];
const RECORDING_ALIASES = ['RecordingUrl', 'recording_url', 'RecordingURL', 'recordingUrl', 'recording', 'MediaUrl', 'media_url', 'file_url', 'file', 'url', 'conversation_recording'];
const DURATION_ALIASES = ['RecordingDuration', 'CallDuration', 'ConversationDuration', 'conversation_duration', 'duration', 'call_duration', 'Duration'];
const STATUS_ALIASES = ['CallStatus', 'call_status', 'status', 'DialCallStatus', 'Status'];

const MAX_AUDIO_BYTES = 40 * 1024 * 1024; // 40MB — headroom for a long call at phone bitrate

function pick(body: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function extFromUrl(url: string): string {
  const m = /\.(mp3|wav|m4a|ogg|opus|amr)(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'mp3';
}

export interface CallRecordingIntegration {
  org_id: string;
  client_id?: string | null;
  source_id?: string | null;
  config?: Record<string, unknown> | null;
}

export type CallIngestResult = { recording_id: string; lead_id: string } | { skipped: string };

/** Get (or lazily create) the org's "Phone Call" lead source so call-created
 *  leads are attributed to the channel. */
async function getOrCreateCallSource(org_id: string): Promise<string | null> {
  try {
    const { data: existing } = await supabaseAdmin.from('crm_lead_sources')
      .select('id').eq('org_id', org_id).ilike('name', 'Phone Call').is('deleted_at', null).limit(1).maybeSingle();
    if ((existing as any)?.id) return (existing as any).id;
    const { data: created } = await supabaseAdmin.from('crm_lead_sources')
      .insert({ org_id, name: 'Phone Call' }).select('id').single();
    return (created as any)?.id ?? null;
  } catch (e: any) {
    logger.warn(`[call-rec] resolve source failed: ${e?.message || e}`);
    return null;
  }
}

async function downloadRecording(url: string, config: Record<string, unknown> | null | undefined): Promise<Buffer> {
  const headers: Record<string, string> = {};
  // Some providers (e.g. Twilio) require basic auth to fetch the recording file.
  const user = config?.recording_auth_user as string | undefined;
  const pass = config?.recording_auth_pass as string | undefined;
  if (user && pass) headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`recording fetch failed [${res.status}]`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('recording is empty');
  if (buf.length > MAX_AUDIO_BYTES) throw new Error(`recording too large (${buf.length} bytes)`);
  return buf;
}

/**
 * Ingest one recorded call. Returns a `skipped` reason (recorded to the event
 * log by the caller) for anything that isn't an answered call with audio, so a
 * provider's non-recorded status callbacks are ignored quietly.
 */
export async function ingestCallRecording(
  integration: CallRecordingIntegration,
  body: Record<string, unknown>,
): Promise<CallIngestResult> {
  const caller = pick(body, CALLER_ALIASES).replace(/[^\d+]/g, '');
  const recordingUrl = pick(body, RECORDING_ALIASES);
  const status = pick(body, STATUS_ALIASES).toLowerCase();
  const duration = Number(pick(body, DURATION_ALIASES)) || null;
  const config = integration.config ?? null;

  if (!recordingUrl) return { skipped: 'no recording url in payload' };
  if (!caller) return { skipped: 'no caller number in payload' };
  // Only ingest calls that connected and were recorded. Missed/failed calls
  // carry no useful audio (and are handled by the ivr_missed_call lead flow).
  if (status && !/(complet|answer|success|record|in.?progress)/.test(status)) {
    return { skipped: `call status '${status}' is not an answered/recorded call` };
  }

  // 1. Resolve the lead by caller phone (dedup — repeat callers merge).
  const source_id = integration.source_id || await getOrCreateCallSource(integration.org_id);
  if (!source_id) return { skipped: 'could not resolve a lead source' };
  const res = await findOrCreateLead({
    org_id: integration.org_id,
    source_id,
    normalized: { phone: caller, notes: 'Recorded phone call', utm_source: 'call_recording', utm_medium: 'call' },
    client_id: integration.client_id ?? null,
  });
  const lead_id = res.lead_id;

  // 2. Attribute to a rep — user_id is NOT NULL. Prefer the lead's owner; fall
  //    back to a configured default agent; else skip (nothing to attribute to).
  const { data: lead } = await supabaseAdmin.from('crm_leads')
    .select('owner_id, client_id').eq('id', lead_id).maybeSingle();
  const user_id = ((lead as any)?.owner_id as string | null) || (config?.default_user_id as string | undefined) || null;
  if (!user_id) return { skipped: 'no rep to attribute the call to (lead has no owner; set default_user_id in the integration config)' };

  // 3. Download the recording and run the transcribe -> analyze pipeline.
  const audio = await downloadRecording(recordingUrl, config);
  const out = await ingestExternalRecording({
    org_id: integration.org_id,
    client_id: ((lead as any)?.client_id as string | null) ?? integration.client_id ?? null,
    lead_id,
    user_id,
    audio,
    ext: extFromUrl(recordingUrl),
    duration_seconds: duration,
    // Consent: the telephony flow is expected to play a "this call is being
    // recorded" announcement, so consent is captured. An org that handles
    // consent differently can set consent_captured=false in the integration
    // config to have the ingest reject calls without explicit consent.
    consent_captured: config?.consent_captured !== false,
    consent_method: 'telephony_recorded',
  });
  logger.info(`[call-rec] ingested recording ${out.id} for lead ${lead_id}`);
  return { recording_id: out.id, lead_id };
}

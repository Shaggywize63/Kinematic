/**
 * CallerDesk recording PULL — reconcile answered calls into Conversation Analysis.
 *
 * CallerDesk records every answered call but (on this account) does not reliably
 * PUSH the Call Report to our webhook. Its Call Report API
 * (POST https://app.callerdesk.io/api/call_list_v2, auth = `authcode`) returns
 * recent calls with the recording URL in `file`, so we PULL them and run the
 * SAME transcribe → analyze pipeline the in-app recorder and the webhook use
 * (ingestExternalRecording → Sarvam → KINI → the lead's Conversations), so the
 * existing Conversation Analysis section lights up with zero extra work.
 *
 * Correlation + dedup go through crm_telephony_calls (telephonyCallLog):
 *   - A click-to-call placed from the app logs campid → lead + rep, so we ingest
 *     a pulled recording onto that EXACT lead/rep (precise path).
 *   - A call with no placement row (placed outside the app) falls back to phone
 *     resolution via ingestCallRecording.
 *   - claimForIngest makes a call ingest at most once across repeated ticks AND
 *     the webhook.
 *
 * Idempotent, best-effort per call/integration, safe on empty. Runs from the
 * cron endpoint and an in-process tick, both project-scoped by the caller.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { ingestExternalRecording } from './conversationIntel.service';
import { ingestCallRecording, type CallRecordingIntegration } from './callRecordingIngest.service';
import { claimForIngest, markIngested, markCallStatus, getCall } from './telephonyCallLog.service';

const PROVIDER = 'callerdesk';
const MAX_AUDIO_BYTES = 40 * 1024 * 1024; // 40MB — a long call at phone bitrate
const IST_OFFSET = '+05:30';              // CallerDesk call_date is IST, no tz suffix

interface CallerDeskRow {
  sid_id?: string; id?: string; file?: string; caller_num?: string; member_num?: string;
  callstatus?: string; callresult?: string; total_duration?: string | number; talk_duration?: string | number;
  call_date?: string; Flow_type?: string;
}

interface IntegrationRow {
  id: string; org_id: string; client_id: string | null; source_id: string | null;
  config: Record<string, unknown> | null;
}

export interface PullResult {
  integrations: number; calls_seen: number; ingested: number; skipped: number; errors: number;
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** CallerDesk `callstatus`/`callresult` → was this an answered, recorded call? */
function isAnswered(row: CallerDeskRow): boolean {
  const s = `${row.callstatus ?? ''} ${row.callresult ?? ''}`.toLowerCase();
  return /(answer|complete|success|connected)/.test(s);
}

/** Parse CallerDesk's IST `call_date` ("YYYY-MM-DD HH:mm:ss") to epoch ms, or 0. */
function callDateMs(call_date?: string): number {
  if (!call_date) return 0;
  const t = Date.parse(`${call_date.trim().replace(' ', 'T')}${IST_OFFSET}`);
  return Number.isFinite(t) ? t : 0;
}

function extFromUrl(url: string): string {
  const m = /\.(mp3|wav|m4a|ogg|opus|amr)(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'wav';
}

/** POST call_list_v2 with the account authcode → the recent-calls array. */
async function fetchCalls(authcode: string, baseUrl?: string): Promise<CallerDeskRow[]> {
  const base = (baseUrl || 'https://app.callerdesk.io').replace(/\/+$/, '');
  const res = await fetch(`${base}/api/call_list_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `authcode=${encodeURIComponent(authcode)}`,
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { throw new Error(`call_list_v2 non-JSON [${res.status}]`); }
  const rows = json?.result ?? json?.data ?? [];
  if (!Array.isArray(rows)) throw new Error(`call_list_v2 unexpected shape: ${String(json?.type || '')}`);
  return rows as CallerDeskRow[];
}

async function downloadAudio(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`recording fetch failed [${res.status}]`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('recording is empty');
  if (buf.length > MAX_AUDIO_BYTES) throw new Error(`recording too large (${buf.length} bytes)`);
  return buf;
}

/** Map a pull row to the webhook-shaped body ingestCallRecording understands. */
function toWebhookBody(row: CallerDeskRow): Record<string, unknown> {
  return {
    SourceNumber: row.caller_num,
    CallRecordingUrl: row.file,
    Status: row.callstatus || row.callresult,
    CallDuration: row.total_duration,
    TalkDuration: row.talk_duration,
    CallSid: row.sid_id,
    campid: row.sid_id,
    Direction: row.Flow_type,
  };
}

/**
 * Ingest ONE pulled call. Claims it first (dedup); returns the outcome. Precise
 * path when a placement row carries the lead + rep; else phone-resolution
 * fallback. Never throws — records an `error` status for a later retry.
 */
async function ingestOne(integ: IntegrationRow, row: CallerDeskRow): Promise<'ingested' | 'skipped' | 'error'> {
  const callKey = String(row.sid_id || row.id || '').trim();
  const file = String(row.file || '').trim();
  if (!callKey || !file) return 'skipped';
  if (!isAnswered(row)) return 'skipped';
  if (num(row.talk_duration) <= 0) return 'skipped'; // ringing-only / no conversation → no useful audio

  const won = await claimForIngest(integ.org_id, PROVIDER, callKey, {
    client_id: integ.client_id, integration_id: integ.id,
    campid: callKey, call_sid: callKey,
    customer_number: row.caller_num ?? null, agent_number: row.member_num ?? null, direction: row.Flow_type ?? null,
  });
  if (!won) return 'skipped'; // already ingested / being processed elsewhere

  try {
    const placement = await getCall(integ.org_id, PROVIDER, callKey);
    const cfg = integ.config ?? {};
    const consent_captured = (cfg as any).consent_captured !== false;

    if (placement?.lead_id && placement?.user_id) {
      // Precise: ingest onto the exact lead + rep captured when the call was placed.
      const audio = await downloadAudio(file);
      const out = await ingestExternalRecording({
        org_id: integ.org_id,
        client_id: placement.client_id ?? integ.client_id ?? null,
        lead_id: placement.lead_id,
        user_id: placement.user_id,
        audio,
        ext: extFromUrl(file),
        duration_seconds: num(row.total_duration) || null,
        consent_captured,
        consent_method: 'telephony_recorded',
      });
      await markIngested(integ.org_id, PROVIDER, callKey, { recording_id: out.id, lead_id: placement.lead_id });
      return 'ingested';
    }

    // Fallback: resolve the lead by caller phone + attribute to its owner.
    const r = await ingestCallRecording(
      { org_id: integ.org_id, client_id: integ.client_id, source_id: integ.source_id, config: cfg } as CallRecordingIntegration,
      toWebhookBody(row),
    );
    if ('recording_id' in r) {
      await markIngested(integ.org_id, PROVIDER, callKey, { recording_id: r.recording_id, lead_id: r.lead_id });
      return 'ingested';
    }
    await markCallStatus(integ.org_id, PROVIDER, callKey, 'skipped', r.skipped);
    return 'skipped';
  } catch (e: any) {
    await markCallStatus(integ.org_id, PROVIDER, callKey, 'error', e?.message || String(e));
    logger.warn(`[call-pull] ingest ${callKey} failed: ${e?.message || e}`);
    return 'error';
  }
}

/**
 * Reconcile recorded calls for every CallerDesk call_recording integration in
 * the current project. Project scoping is the caller's job (runWithProject),
 * matching the other cron jobs.
 *
 *   - org_id        restrict to one tenant
 *   - lookbackHours only ingest calls newer than this (default 48h) — keeps a
 *                   periodic tick cheap; dedup still protects re-ingest
 *   - maxPerInteg   cap rows examined per integration (default 200)
 *   - onlyCampid    ingest just this campid (used for targeted verification)
 */
export async function reconcileCallRecordings(opts?: {
  org_id?: string; lookbackHours?: number; maxPerInteg?: number; onlyCampid?: string;
}): Promise<PullResult> {
  const lookbackHours = Math.min(Math.max(Math.round(opts?.lookbackHours ?? 48), 1), 24 * 30);
  const maxPerInteg = Math.min(Math.max(Math.round(opts?.maxPerInteg ?? 200), 1), 1000);
  const sinceMs = Date.now() - lookbackHours * 3_600_000;

  let q = supabaseAdmin.from('crm_lead_source_integrations')
    .select('id, org_id, client_id, source_id, config')
    .eq('provider', 'call_recording');
  if (opts?.org_id) q = q.eq('org_id', opts.org_id);
  const { data: integs, error } = await q.limit(500);
  if (error) { logger.error(`[call-pull] integration query failed: ${error.message}`); return { integrations: 0, calls_seen: 0, ingested: 0, skipped: 0, errors: 0 }; }

  const result: PullResult = { integrations: 0, calls_seen: 0, ingested: 0, skipped: 0, errors: 0 };

  for (const integ of (integs ?? []) as IntegrationRow[]) {
    const cfg = (integ.config ?? {}) as Record<string, unknown>;
    const provider = String(cfg.provider ?? '').toLowerCase();
    const authcode = cfg.callerdesk_authcode as string | undefined;
    if (provider !== 'callerdesk' || !authcode) continue; // not a CallerDesk pull integration
    result.integrations++;

    let rows: CallerDeskRow[];
    try {
      rows = await fetchCalls(authcode, cfg.callerdesk_base_url as string | undefined);
    } catch (e: any) {
      logger.warn(`[call-pull] fetch failed for org ${integ.org_id}: ${e?.message || e}`);
      continue;
    }

    let seen = 0;
    for (const row of rows) {
      if (seen >= maxPerInteg) break;
      const callKey = String(row.sid_id || row.id || '').trim();
      if (opts?.onlyCampid) {
        if (callKey !== opts.onlyCampid) continue;
      } else {
        const ts = callDateMs(row.call_date);
        if (ts && ts < sinceMs) continue; // outside the window
      }
      seen++;
      result.calls_seen++;
      const outcome = await ingestOne(integ, row);
      if (outcome === 'ingested') result.ingested++;
      else if (outcome === 'error') result.errors++;
      else result.skipped++;
    }
  }

  logger.info(`[call-pull] integrations=${result.integrations} seen=${result.calls_seen} ingested=${result.ingested} skipped=${result.skipped} errors=${result.errors}`);
  return result;
}

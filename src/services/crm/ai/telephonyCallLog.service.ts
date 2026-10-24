/**
 * Telephony call log + ingest dedup (crm_telephony_calls).
 *
 * The single choke point that guarantees one recorded call is transcribed +
 * analyzed at most once, whether it arrives via the CallerDesk webhook OR the
 * pull reconcile (call_list_v2). It also carries the campid → lead + rep link
 * captured when a click-to-call is placed, so a pulled recording lands on the
 * exact lead/rep instead of being re-resolved by phone.
 *
 * Correlation key (`call_key`): campid for an outgoing click-to-call — the same
 * value shows up as the click-to-call response `campid`, the pull API `sid_id`,
 * and the webhook `campid` — else the provider CallSid/Uniqueid for an incoming
 * call. Kept in its own module so both the webhook controller and the pull
 * service depend on it without importing each other.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

const TABLE = 'crm_telephony_calls';

export interface CallLogMeta {
  client_id?: string | null;
  integration_id?: string | null;
  campid?: string | null;
  call_sid?: string | null;
  customer_number?: string | null;
  agent_number?: string | null;
  direction?: string | null;
}

/** First non-empty of campid / call_sid / uniqueid, as a trimmed string. */
export function deriveCallKey(parts: { campid?: unknown; call_sid?: unknown; uniqueid?: unknown }): string {
  for (const v of [parts.campid, parts.call_sid, parts.uniqueid]) {
    const s = v == null ? '' : String(v).trim();
    if (s) return s;
  }
  return '';
}

/**
 * Record a placed click-to-call (campid → lead + rep). Best-effort: a logging
 * hiccup must never fail the call itself. Upsert so a retry/re-place is a no-op
 * and never clobbers an already-ingested row's state.
 */
export async function recordPlacement(row: {
  org_id: string; provider: string; call_key: string;
  lead_id?: string | null; user_id?: string | null;
} & CallLogMeta): Promise<void> {
  if (!row.call_key) return;
  try {
    await supabaseAdmin.from(TABLE).upsert({
      org_id: row.org_id,
      provider: row.provider,
      call_key: row.call_key,
      campid: row.campid ?? row.call_key,
      call_sid: row.call_sid ?? null,
      lead_id: row.lead_id ?? null,
      user_id: row.user_id ?? null,
      client_id: row.client_id ?? null,
      integration_id: row.integration_id ?? null,
      customer_number: row.customer_number ?? null,
      agent_number: row.agent_number ?? null,
      direction: row.direction ?? null,
      status: 'placed',
      placed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,provider,call_key', ignoreDuplicates: true });
  } catch (e: any) {
    logger.warn(`[telephony-log] recordPlacement failed: ${e?.message || e}`);
  }
}

/** The placement row for a call, if one was logged when it was placed. */
export async function getCall(org_id: string, provider: string, call_key: string): Promise<any | null> {
  if (!call_key) return null;
  const { data } = await supabaseAdmin.from(TABLE)
    .select('id, lead_id, user_id, client_id, status, recording_id')
    .eq('org_id', org_id).eq('provider', provider).eq('call_key', call_key).maybeSingle();
  return data ?? null;
}

/**
 * Atomically claim a call for ingestion. Returns true only for the caller that
 * wins the claim (should proceed to ingest); false if it is already ingested or
 * being processed, so the webhook and the pull never double-ingest.
 *
 * Ensures the row exists (insert-if-absent, carrying any metadata), then flips
 * it to `processing` in a single conditional UPDATE that only matches a row not
 * already `processing`/`ingested` — so overlapping ticks can't both win.
 */
export async function claimForIngest(
  org_id: string, provider: string, call_key: string, meta: CallLogMeta = {},
): Promise<boolean> {
  if (!call_key) return true; // nothing to dedup on (rare) — let it through

  // 1. Ensure a row exists. ignoreDuplicates => no-op if it is already there.
  const { error: upErr } = await supabaseAdmin.from(TABLE).upsert({
    org_id, provider, call_key,
    campid: meta.campid ?? call_key,
    call_sid: meta.call_sid ?? null,
    client_id: meta.client_id ?? null,
    integration_id: meta.integration_id ?? null,
    customer_number: meta.customer_number ?? null,
    agent_number: meta.agent_number ?? null,
    direction: meta.direction ?? null,
    status: 'new',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'org_id,provider,call_key', ignoreDuplicates: true });
  if (upErr) { logger.warn(`[telephony-log] claim upsert failed: ${upErr.message}`); return false; }

  // 2. Win the claim: move to `processing` only if not already processing/ingested.
  const { data, error } = await supabaseAdmin.from(TABLE)
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('org_id', org_id).eq('provider', provider).eq('call_key', call_key)
    .in('status', ['new', 'placed', 'error'])
    .select('id');
  if (error) { logger.warn(`[telephony-log] claim update failed: ${error.message}`); return false; }
  return Array.isArray(data) && data.length > 0;
}

/** Mark a claimed call ingested, linking the resulting recording + lead. */
export async function markIngested(
  org_id: string, provider: string, call_key: string,
  result: { recording_id?: string | null; lead_id?: string | null },
): Promise<void> {
  if (!call_key) return;
  try {
    // Only set lead_id when the caller resolved one, so we keep the placement
    // row's lead_id when the webhook/fallback didn't carry it.
    const patch: Record<string, unknown> = {
      status: 'ingested',
      recording_id: result.recording_id ?? null,
      ingested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (result.lead_id) patch.lead_id = result.lead_id;
    await supabaseAdmin.from(TABLE).update(patch)
      .eq('org_id', org_id).eq('provider', provider).eq('call_key', call_key);
  } catch (e: any) {
    logger.warn(`[telephony-log] markIngested failed: ${e?.message || e}`);
  }
}

/** Mark a claimed call skipped/errored so a later run can see why (error is retryable). */
export async function markCallStatus(
  org_id: string, provider: string, call_key: string,
  status: 'skipped' | 'error', detail?: string,
): Promise<void> {
  if (!call_key) return;
  try {
    await supabaseAdmin.from(TABLE).update({
      status, detail: detail ? String(detail).slice(0, 2000) : null, updated_at: new Date().toISOString(),
    }).eq('org_id', org_id).eq('provider', provider).eq('call_key', call_key);
  } catch (e: any) {
    logger.warn(`[telephony-log] markCallStatus failed: ${e?.message || e}`);
  }
}

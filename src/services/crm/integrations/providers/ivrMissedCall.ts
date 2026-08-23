/**
 * IVR / missed-call provider — turn an inbound (or missed) call into a lead.
 *
 * Auth model: per-integration `webhook_secret` shipped as `?key=<secret>` on
 * the public POST URL (same as web_form / email). The telephony provider's
 * call-status / missed-call webhook is pointed at that URL.
 *
 * Payload: telephony providers POST either JSON or (more commonly)
 * application/x-www-form-urlencoded — both land in req.body via the global
 * urlencoded/json parsers. We read the caller's number across the shapes used
 * by the major providers (Exotel, Knowlarity, Twilio/Plivo, and a generic
 * fallback), normalise it, and create a phone-only lead. Dedup-by-phone in the
 * orchestrator means repeat callers merge onto the same lead instead of
 * spawning duplicates. No AI needed — this is pure field extraction.
 */
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow } from './types';
import type { NormalizedLead } from '../dedup.orchestrator';

// Caller (the lead) number — the person who called in.
const CALLER_ALIASES = [
  'CallFrom', 'From', 'from', 'caller_id', 'caller', 'caller_number',
  'source', 'src', 'phone', 'mobile', 'number', 'A_PARTY', 'customer_number',
];
// The DID / virtual number the caller dialled (ours) — context, not the lead.
const DID_ALIASES = [
  'CallTo', 'To', 'to', 'call_to_number', 'called_number', 'destination',
  'dst', 'did', 'virtual_number', 'B_PARTY',
];
const CALLID_ALIASES = ['CallSid', 'call_id', 'callid', 'uuid', 'CallUUID', 'call_uuid'];
const STATUS_ALIASES = ['CallStatus', 'call_status', 'status', 'DialCallStatus'];
const TIME_ALIASES   = ['StartTime', 'start_time', 'start_stamp', 'timestamp', 'time', 'created_at'];

function pick(body: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export const ivrMissedCallProvider: IntegrationProvider = {
  id: 'ivr_missed_call',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    const provided =
      (req.query.key as string | undefined) ??
      (req.headers['x-webhook-key'] as string | undefined);
    if (!provided || !integration.webhook_secret) return false;
    if (provided.length !== integration.webhook_secret.length) return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ integration.webhook_secret.charCodeAt(i);
    }
    return diff === 0;
  },

  normalize(raw: unknown): NormalizedLead {
    const body = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const caller = pick(body, CALLER_ALIASES);
    const did     = pick(body, DID_ALIASES);
    const callId  = pick(body, CALLID_ALIASES);
    const status  = pick(body, STATUS_ALIASES);
    const when    = pick(body, TIME_ALIASES);

    // Keep only digits (+ leading +) so dedup-by-phone matches other channels.
    const phone = caller ? caller.replace(/[^\d+]/g, '') || null : null;

    const noteBits = ['Inbound call'];
    if (did) noteBits.push(`to ${did}`);
    if (status) noteBits.push(`(${status})`);
    if (when) noteBits.push(`at ${when}`);
    const notes = phone ? noteBits.join(' ') : 'Inbound call (no caller id)';

    return {
      first_name: null,
      last_name: null,
      email: null,
      phone,
      notes,
      utm_source: 'ivr_missed_call',
      utm_medium: 'call',
      custom_fields: {
        ivr_did: did || undefined,
        ivr_call_id: callId || undefined,
        ivr_status: status || undefined,
        ivr_time: when || undefined,
      },
    };
  },
};

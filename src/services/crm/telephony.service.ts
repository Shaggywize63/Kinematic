/**
 * Outbound "click-to-call" (recorded) — place a bridged call so the rep can
 * talk to a lead and have the call recorded server-side, which then flows into
 * Conversation Analysis via the call_recording webhook (see callRecordingIngest).
 *
 * Provider-agnostic entry point; Exotel is implemented first (the common India
 * CRM telephony provider). All credentials come from the org's call_recording
 * integration `config` — nothing is hardcoded — so this stays tenant-scoped and
 * safe. The call itself is placed on the provider; we only kick it off and
 * return the provider's call id/status.
 */
import { AppError } from '../../utils';
import { supabaseAdmin } from '../../lib/supabase';

export interface TelephonyConfig {
  provider?: string;            // 'exotel' (default). 'callerdesk'. knowlarity / twilio can follow.
  exotel_sid?: string;
  exotel_api_key?: string;
  exotel_api_token?: string;
  exotel_subdomain?: string;    // default 'api.exotel.com'
  // CallerDesk (IVR click-to-call). All of these are read from the org's
  // call_recording integration config — never hardcoded, never shipped in the app.
  callerdesk_authcode?: string;        // CallerDesk API Key (the "authcode")
  callerdesk_secret?: string;          // CallerDesk Secret Key (HTTP Basic password)
  callerdesk_integration_key?: string; // optional Integration Key, if the account needs it
  callerdesk_deskphone?: string;       // the account's virtual / DID number the call rides on (REQUIRED)
  callerdesk_base_url?: string;        // default 'https://api.callerdesk.io'
  callerdesk_path?: string;            // default '/v1/click_to_call_v2'
  caller_id?: string;           // your ExoPhone / virtual number the customer sees (Exotel); CallerDesk falls back to this for deskphone
  recording_callback_url?: string; // point at the call_recording webhook so the
                                    // recording is delivered back for analysis
  [k: string]: unknown;
}

export interface ClickToCallResult {
  ok: boolean;
  provider: string;
  call_id: string | null;
  status: string | null;
}

/** Place a recorded click-to-call bridging `from` (the rep/agent) to `to`
 *  (the customer). Throws AppError with a clear message on misconfiguration. */
export async function placeClickToCall(
  cfg: TelephonyConfig,
  from: string,
  to: string,
  opts?: { callerId?: string },
): Promise<ClickToCallResult> {
  const provider = (cfg.provider || 'exotel').toLowerCase();
  if (provider === 'exotel') return exotelConnect(cfg, from, to, opts);
  if (provider === 'callerdesk') return callerDeskConnect(cfg, from, to, opts);
  throw new AppError(400, `Telephony provider '${provider}' is not supported yet`, 'PROVIDER_UNSUPPORTED');
}

/** CallerDesk wants Indian mobiles as the bare 10-digit subscriber number (no +91 / 0 prefix). */
function toCallerDeskNumber(raw: string): string {
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);   // 91XXXXXXXXXX
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // 0XXXXXXXXXX
  return d;
}

/**
 * CallerDesk "IVR click-to-call": places two calls — first to the agent
 * (`calling_party_a`), then to the customer (`calling_party_b`) — and bridges
 * them on the account's virtual number (`deskphone`), recording the call. The
 * recording + report are delivered back through CallerDesk's Call Report webhook
 * (point it at our call_recording webhook URL), which feeds Conversation Analysis.
 *
 * NOTE: the exact endpoint/param contract is isolated here on purpose — this
 * environment cannot reach api.callerdesk.io to verify it, so it is implemented
 * from CallerDesk's published click_to_call_v2 shape and is overridable via
 * config (callerdesk_base_url / callerdesk_path) without a code change. Auth is
 * sent both ways CallerDesk documents: HTTP Basic (API key : secret) AND the
 * `authcode` field, so whichever the account enforces is satisfied.
 */
async function callerDeskConnect(
  cfg: TelephonyConfig,
  from: string,
  to: string,
  opts?: { callerId?: string },
): Promise<ClickToCallResult> {
  const authcode = cfg.callerdesk_authcode;
  const secret = cfg.callerdesk_secret;
  const deskphone = toCallerDeskNumber(opts?.callerId || cfg.callerdesk_deskphone || cfg.caller_id || '');
  if (!authcode || !secret || !deskphone) {
    throw new AppError(400, 'CallerDesk is not fully configured (need callerdesk_authcode, callerdesk_secret and callerdesk_deskphone in the Call Recording integration config)', 'TELEPHONY_NOT_CONFIGURED');
  }

  const base = (cfg.callerdesk_base_url || 'https://api.callerdesk.io').replace(/\/+$/, '');
  const path = cfg.callerdesk_path || '/v1/click_to_call_v2';
  const url = base + (path.startsWith('/') ? path : '/' + path);

  const body = new URLSearchParams();
  body.set('calling_party_a', toCallerDeskNumber(from)); // ring the agent first
  body.set('calling_party_b', toCallerDeskNumber(to));   // then bridge the customer
  body.set('deskphone', deskphone);
  body.set('call_from_did', '1');
  body.set('authcode', authcode);
  if (cfg.callerdesk_integration_key) body.set('integration_key', String(cfg.callerdesk_integration_key));

  const auth = 'Basic ' + Buffer.from(`${authcode}:${secret}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* CallerDesk sometimes replies text/plain */ }
  if (!res.ok) {
    const msg = json?.message || json?.error || json?.msg || text.slice(0, 200) || res.statusText;
    throw new AppError(502, `CallerDesk click-to-call failed [${res.status}]: ${msg}`, 'TELEPHONY_FAILED');
  }
  // CallerDesk returns the request/campaign id under one of these keys.
  const callId = json?.callid ?? json?.campid ?? json?.request_id ?? json?.data?.callid ?? null;
  const status = json?.status ?? json?.message ?? 'queued';
  return { ok: true, provider: 'callerdesk', call_id: callId ? String(callId) : null, status: status ? String(status) : null };
}

/**
 * Exotel "Connect two numbers" (click-to-call): dials `From` (the agent) first,
 * then bridges to `To` (the customer). Record=true records the call; the
 * recording is delivered to StatusCallback — point that at the call_recording
 * webhook so it lands in Conversation Analysis.
 * Docs: POST https://<key>:<token>@<subdomain>/v1/Accounts/<sid>/Calls/connect.json
 */
async function exotelConnect(
  cfg: TelephonyConfig,
  from: string,
  to: string,
  opts?: { callerId?: string },
): Promise<ClickToCallResult> {
  const sid = cfg.exotel_sid, key = cfg.exotel_api_key, token = cfg.exotel_api_token;
  const subdomain = cfg.exotel_subdomain || 'api.exotel.com';
  const callerId = opts?.callerId || cfg.caller_id;
  if (!sid || !key || !token || !callerId) {
    throw new AppError(400, 'Exotel is not fully configured (need exotel_sid, exotel_api_key, exotel_api_token and caller_id in the Call Recording integration config)', 'TELEPHONY_NOT_CONFIGURED');
  }

  const url = `https://${subdomain}/v1/Accounts/${sid}/Calls/connect.json`;
  const body = new URLSearchParams();
  body.set('From', from);
  body.set('To', to);
  body.set('CallerId', callerId);
  body.set('Record', 'true');
  if (cfg.recording_callback_url) body.set('StatusCallback', String(cfg.recording_callback_url));

  const auth = 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.RestException?.Message || json?.message || JSON.stringify(json).slice(0, 200) || res.statusText;
    throw new AppError(502, `Exotel connect failed [${res.status}]: ${msg}`, 'TELEPHONY_FAILED');
  }
  const call = json?.Call ?? json?.Calls ?? {};
  return { ok: true, provider: 'exotel', call_id: call?.Sid ?? call?.CallSid ?? null, status: call?.Status ?? 'queued' };
}

/**
 * Orchestrate a recorded click-to-call for a lead: resolve the customer number
 * (from the lead), the agent number (the rep's profile mobile), and the org's
 * telephony config (from the call_recording integration), then place the call.
 */
export async function clickToCallForLead(params: {
  org_id: string; user_id: string; lead_id: string; to?: string | null; from?: string | null;
}): Promise<ClickToCallResult & { from: string; to: string; lead_id: string }> {
  const { org_id, user_id, lead_id } = params;
  if (!lead_id) throw new AppError(400, 'lead_id is required', 'BAD_REQUEST');

  const { data: lead } = await supabaseAdmin.from('crm_leads')
    .select('phone').eq('id', lead_id).eq('org_id', org_id).maybeSingle();
  const to = String(params.to ?? (lead as any)?.phone ?? '').replace(/[^\d+]/g, '');
  if (!to) throw new AppError(400, 'No customer number to dial (the lead has no phone)', 'NO_CUSTOMER_NUMBER');

  const { data: me } = await supabaseAdmin.from('users')
    .select('mobile').eq('id', user_id).maybeSingle();
  const from = String(params.from ?? (me as any)?.mobile ?? '').replace(/[^\d+]/g, '');
  if (!from) throw new AppError(400, 'Your phone number is not set on your profile — add it to place recorded calls', 'NO_AGENT_NUMBER');

  const { data: integs } = await supabaseAdmin.from('crm_lead_source_integrations')
    .select('config').eq('org_id', org_id).eq('provider', 'call_recording').limit(1);
  const cfg = (((integs?.[0] as any)?.config) || {}) as TelephonyConfig;

  const result = await placeClickToCall(cfg, from, to, {});
  return { ...result, from, to, lead_id };
}

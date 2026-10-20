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
import { AppError, isUUID } from '../../utils';
import { supabaseAdmin } from '../../lib/supabase';
import { clientGrantedModuleIds } from '../../lib/entitlements';
import { recordPlacement } from './ai/telephonyCallLog.service';

export interface TelephonyConfig {
  provider?: string;            // 'exotel' (default). 'callerdesk'. knowlarity / twilio can follow.
  exotel_sid?: string;
  exotel_api_key?: string;
  exotel_api_token?: string;
  exotel_subdomain?: string;    // default 'api.exotel.com'
  // CallerDesk (IVR click-to-call). All of these are read from the org's
  // call_recording integration config — never hardcoded, never shipped in the app.
  // Contract verified live against account 129579 (see callerDeskConnect).
  callerdesk_authcode?: string;        // CallerDesk API Key — this is the "authcode" (the only auth the C2C API needs)
  callerdesk_secret?: string;          // CallerDesk Secret Key — kept for webhook-signature verification; NOT used to place the call
  callerdesk_integration_key?: string; // optional Integration Key (stored; not a click_to_call param)
  callerdesk_deskphone?: string;       // the account's virtual / DID number the call rides on, e.g. '08062986292' (REQUIRED)
  callerdesk_base_url?: string;        // default 'https://app.callerdesk.io'
  callerdesk_path?: string;            // default '/api/click_to_call_v2'
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

/** CallerDesk wants the two parties as bare 10-digit Indian subscriber numbers (no +91 / 0 prefix). */
function toCallerDeskNumber(raw: string): string {
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);   // 91XXXXXXXXXX
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // 0XXXXXXXXXX
  return d;
}

/**
 * CallerDesk "IVR click-to-call": places two calls — first to the agent
 * (`calling_party_a`), then to the customer (`calling_party_b`) — and bridges
 * them on the account's virtual DID (`deskphone`), recording the call. The
 * recording + report are delivered back through CallerDesk's Call Report webhook
 * (point it at our call_recording webhook URL), which feeds Conversation Analysis.
 *
 * Contract verified live (2026-10) against CallerDesk account 129579:
 *   GET https://app.callerdesk.io/api/click_to_call_v2
 *       ?calling_party_a=<agent 10-digit>
 *       &calling_party_b=<customer 10-digit>
 *       &deskphone=<account DID, e.g. 08062986292 — leading 0 kept>
 *       &authcode=<CallerDesk API Key>
 *       &call_from_did=1
 * Auth is the `authcode` query param ONLY — there is no HTTP Basic. CallerDesk
 * replies HTTP 200 even on failure, carrying `{"type":"error","message":...}`,
 * so success is decided by `type`, not the HTTP status. Endpoint is overridable
 * via config (callerdesk_base_url / callerdesk_path) without a code change.
 */
async function callerDeskConnect(
  cfg: TelephonyConfig,
  from: string,
  to: string,
  opts?: { callerId?: string },
): Promise<ClickToCallResult> {
  const authcode = cfg.callerdesk_authcode;
  // The deskphone is the account's DID exactly as CallerDesk stores it (e.g.
  // '08062986292' — leading 0 retained); only strip formatting characters.
  const deskphone = String(opts?.callerId || cfg.callerdesk_deskphone || cfg.caller_id || '').replace(/\D/g, '');
  if (!authcode || !deskphone) {
    throw new AppError(400, 'CallerDesk is not fully configured (need callerdesk_authcode and callerdesk_deskphone in the Call Recording integration config)', 'TELEPHONY_NOT_CONFIGURED');
  }

  const base = (cfg.callerdesk_base_url || 'https://app.callerdesk.io').replace(/\/+$/, '');
  const path = cfg.callerdesk_path || '/api/click_to_call_v2';
  const qs = new URLSearchParams();
  qs.set('calling_party_a', toCallerDeskNumber(from)); // ring the agent first
  qs.set('calling_party_b', toCallerDeskNumber(to));   // then bridge the customer
  qs.set('deskphone', deskphone);
  qs.set('authcode', authcode);
  qs.set('call_from_did', '1');
  const url = base + (path.startsWith('/') ? path : '/' + path) + '?' + qs.toString();

  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* CallerDesk sometimes replies text/plain */ }
  // CallerDesk returns HTTP 200 even for errors — the real outcome is in `type`.
  const isError = json && typeof json === 'object' && String(json.type).toLowerCase() === 'error';
  if (!res.ok || isError) {
    const msg = json?.message || json?.error || json?.msg || text.slice(0, 200) || res.statusText;
    throw new AppError(502, `CallerDesk click-to-call failed: ${msg}`, 'TELEPHONY_FAILED');
  }
  // CallerDesk returns the request/campaign id under one of these keys.
  const callId = json?.callid ?? json?.campid ?? json?.request_id ?? json?.callsid ?? json?.data?.callid ?? null;
  const status = json?.message ?? json?.status ?? json?.type ?? 'queued';
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

/** The module Client Management switches on for a client that gets IVR calling. */
export const IVR_MODULE = 'ivr_call';

/**
 * IVR is a per-client switch (Client Management → IVR calling). The apps hide the button for a user whose client lacks the
 * module, but platform admins bypass the module list there, so the server decides: the lead's client (else the caller's
 * client) must hold `ivr_call`. A lead with no client at all is a platform-level lead and is left to the caller's own
 * entitlement check in the route.
 */
export async function assertIvrEnabledForLead(params: { org_id: string; lead_id?: string | null; caller_client_id?: string | null }): Promise<void> {
  let client: string | null = null;
  if (params.lead_id && isUUID(params.lead_id)) {
    const { data } = await supabaseAdmin.from('crm_leads').select('client_id').eq('id', params.lead_id).eq('org_id', params.org_id).maybeSingle();
    client = (data as { client_id?: string | null } | null)?.client_id ?? null;
  }
  client = client ?? params.caller_client_id ?? null;
  if (!client) return;
  if (!(await clientGrantedModuleIds(client)).includes(IVR_MODULE)) {
    throw new AppError(403, 'IVR calling is not switched on for this client', 'FORBIDDEN');
  }
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
    .select('id, client_id, config').eq('org_id', org_id).eq('provider', 'call_recording').limit(1);
  const integ = (integs?.[0] as any) || {};
  const cfg = (integ.config || {}) as TelephonyConfig;

  const result = await placeClickToCall(cfg, from, to, {});

  // Log the placement (campid → lead + rep) so the recording PULL reconcile can
  // ingest the resulting recording onto this exact lead/rep instead of
  // re-resolving by phone. Best-effort (recordPlacement never throws); only the
  // CallerDesk provider returns a campid we can correlate on.
  if (result.call_id && (cfg.provider || '').toLowerCase() === 'callerdesk') {
    await recordPlacement({
      org_id, provider: 'callerdesk', call_key: result.call_id,
      campid: result.call_id, lead_id, user_id,
      client_id: integ.client_id ?? null, integration_id: integ.id ?? null,
      customer_number: to, agent_number: from, direction: 'WEBOBD',
    });
  }

  return { ...result, from, to, lead_id };
}

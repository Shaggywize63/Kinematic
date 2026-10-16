/**
 * CallerDesk IVR click-to-call provider (telephony.service). Pins the request WE
 * build against the contract verified live against account 129579:
 *   GET https://app.callerdesk.io/api/click_to_call_v2?calling_party_a&calling_party_b
 *       &deskphone&authcode&call_from_did=1
 * Auth is the `authcode` query param only (no HTTP Basic), the two parties are
 * normalised to bare 10-digit Indian subscriber numbers, the deskphone (DID) is
 * passed through as configured, and — because CallerDesk returns HTTP 200 even on
 * failure — a body of `{type:'error'}` is surfaced as a failure.
 */
import { placeClickToCall, type TelephonyConfig } from '../src/services/crm/telephony.service';

const CFG: TelephonyConfig = {
  provider: 'callerdesk',
  callerdesk_authcode: 'API_KEY_123',
  callerdesk_secret: 'SECRET_456',
  callerdesk_deskphone: '08062986292',
  callerdesk_integration_key: 'INTEG_789',
};

type Captured = { url: string; method?: string; headers: Record<string, string>; body: string };
let captured: Captured | null;

beforeEach(() => {
  captured = null;
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    captured = { url, method: init?.method, headers: init?.headers ?? {}, body: String(init?.body ?? '') };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ type: 'success', message: 'call initiated', callid: 'CD-999' }),
    } as any;
  });
});
afterEach(() => { delete (global as any).fetch; });

/** The params are on the query string of a GET (there is no body). */
function params(): URLSearchParams {
  return new URLSearchParams(new URL(captured!.url).search);
}

describe('CallerDesk click-to-call', () => {
  it('rings the agent (party A) then the customer (party B), bridged on the deskphone DID', async () => {
    const r = await placeClickToCall(CFG, '+91 90000 11111', '088888-22222');
    const p = params();
    expect(captured!.method).toBe('GET');
    expect(p.get('calling_party_a')).toBe('9000011111'); // +91 stripped
    expect(p.get('calling_party_b')).toBe('8888822222');  // leading 0 stripped
    expect(p.get('deskphone')).toBe('08062986292');       // DID passed through (leading 0 kept)
    expect(p.get('call_from_did')).toBe('1');
    expect(p.get('authcode')).toBe('API_KEY_123');
    expect(r).toEqual({ ok: true, provider: 'callerdesk', call_id: 'CD-999', status: 'call initiated' });
  });

  it('authenticates with the authcode query param only — no HTTP Basic header', async () => {
    await placeClickToCall(CFG, '9000011111', '8888822222');
    expect(captured!.headers.Authorization).toBeUndefined();
    expect(captured!.url.startsWith('https://app.callerdesk.io/api/click_to_call_v2?')).toBe(true);
  });

  it('honours an overridden base url / path without a code change', async () => {
    await placeClickToCall({ ...CFG, callerdesk_base_url: 'https://app.callerdesk.io/', callerdesk_path: 'api/click_to_call_v3' }, '9000011111', '8888822222');
    expect(captured!.url.startsWith('https://app.callerdesk.io/api/click_to_call_v3?')).toBe(true);
  });

  it('falls back to caller_id for the deskphone when callerdesk_deskphone is unset', async () => {
    const { callerdesk_deskphone, ...rest } = CFG;
    await placeClickToCall({ ...rest, caller_id: '08062986292' }, '9000011111', '8888822222');
    expect(params().get('deskphone')).toBe('08062986292');
  });

  it('throws a clear misconfiguration error when the authcode or deskphone is missing', async () => {
    await expect(placeClickToCall({ provider: 'callerdesk', callerdesk_authcode: 'x' }, '9000011111', '8888822222'))
      .rejects.toThrow(/not fully configured/i);
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('treats an HTTP-200 body of {type:error} as a failure and surfaces its message', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ type: 'error', message: 'You dont have permission to use this. Please Contact Administrator.' }) } as any));
    await expect(placeClickToCall(CFG, '9000011111', '8888822222')).rejects.toThrow(/permission to use this/i);
  });

  it('surfaces a non-200 provider failure with its message', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid authcode' }) } as any));
    await expect(placeClickToCall(CFG, '9000011111', '8888822222')).rejects.toThrow(/invalid authcode/);
  });

  it('still rejects an unknown provider', async () => {
    await expect(placeClickToCall({ provider: 'nope' } as TelephonyConfig, '1', '2')).rejects.toThrow(/not supported/i);
  });
});

/**
 * CallerDesk IVR click-to-call provider (telephony.service). The exact CallerDesk
 * contract can't be reached from CI, so these pin the request WE build: number
 * normalization to bare 10-digit Indian subscriber numbers, the required params
 * (calling_party_a / calling_party_b / deskphone / call_from_did / authcode),
 * both auth styles (Basic + authcode), and the misconfiguration guard.
 */
import { placeClickToCall, type TelephonyConfig } from '../src/services/crm/telephony.service';

const CFG: TelephonyConfig = {
  provider: 'callerdesk',
  callerdesk_authcode: 'API_KEY_123',
  callerdesk_secret: 'SECRET_456',
  callerdesk_deskphone: '914445556666',
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
      text: async () => JSON.stringify({ status: 'success', callid: 'CD-999' }),
    } as any;
  });
});
afterEach(() => { delete (global as any).fetch; });

function params(): URLSearchParams {
  return new URLSearchParams(captured!.body);
}

describe('CallerDesk click-to-call', () => {
  it('rings the agent (party A) then the customer (party B), bridged on the deskphone', async () => {
    const r = await placeClickToCall(CFG, '+91 90000 11111', '088888-22222');
    const p = params();
    expect(p.get('calling_party_a')).toBe('9000011111'); // +91 stripped
    expect(p.get('calling_party_b')).toBe('8888822222');  // leading 0 stripped
    expect(p.get('deskphone')).toBe('4445556666');        // 91 stripped
    expect(p.get('call_from_did')).toBe('1');
    expect(p.get('authcode')).toBe('API_KEY_123');
    expect(p.get('integration_key')).toBe('INTEG_789');
    expect(r).toEqual({ ok: true, provider: 'callerdesk', call_id: 'CD-999', status: 'success' });
  });

  it('sends HTTP Basic auth (apikey:secret) as well as the authcode field', async () => {
    await placeClickToCall(CFG, '9000011111', '8888822222');
    const expected = 'Basic ' + Buffer.from('API_KEY_123:SECRET_456').toString('base64');
    expect(captured!.headers.Authorization).toBe(expected);
    expect(captured!.method).toBe('POST');
    expect(captured!.url).toBe('https://api.callerdesk.io/v1/click_to_call_v2');
  });

  it('honours an overridden base url / path without a code change', async () => {
    await placeClickToCall({ ...CFG, callerdesk_base_url: 'https://api.callerdesk.io/', callerdesk_path: 'v1/click_to_call' }, '9000011111', '8888822222');
    expect(captured!.url).toBe('https://api.callerdesk.io/v1/click_to_call');
  });

  it('falls back to caller_id for the deskphone when callerdesk_deskphone is unset', async () => {
    const { callerdesk_deskphone, ...rest } = CFG;
    await placeClickToCall({ ...rest, caller_id: '4445556666' }, '9000011111', '8888822222');
    expect(params().get('deskphone')).toBe('4445556666');
  });

  it('throws a clear misconfiguration error when a credential or the deskphone is missing', async () => {
    await expect(placeClickToCall({ provider: 'callerdesk', callerdesk_authcode: 'x', callerdesk_secret: 'y' }, '9000011111', '8888822222'))
      .rejects.toThrow(/not fully configured/i);
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('surfaces a provider failure with its message', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid authcode' }) } as any));
    await expect(placeClickToCall(CFG, '9000011111', '8888822222')).rejects.toThrow(/invalid authcode/);
  });

  it('still rejects an unknown provider', async () => {
    await expect(placeClickToCall({ provider: 'nope' } as TelephonyConfig, '1', '2')).rejects.toThrow(/not supported/i);
  });
});
